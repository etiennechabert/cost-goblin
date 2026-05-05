import { ipcMain, safeStorage } from 'electron';
import { readFile, writeFile, readdir, mkdir, rm, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import {
  deriveKey,
  generateSalt,
  createKeyCheck,
  verifyKeyCheck,
  encryptFile,
  decryptFile,
  logger,
} from '@costgoblin/core';
import type { EncryptionConfig } from '@costgoblin/core';

export interface VaultState {
  encryptionConfig: EncryptionConfig | null;
  derivedKey: Buffer | null;
  tempDataDir: string | null;
}

export interface VaultContext {
  readonly dataDir: string;
  readonly userDataPath: string;
}

type VaultStatus =
  | { state: 'not-configured' }
  | { state: 'locked' }
  | { state: 'unlocked' };

function encryptionConfigPath(userDataPath: string): string {
  return join(userDataPath, 'encryption.json');
}

function safeStorageKeyPath(userDataPath: string): string {
  return join(userDataPath, 'vault-key.enc');
}

function tempVaultDir(userDataPath: string): string {
  return join(userDataPath, 'vault-temp');
}

async function mkdirRestricted(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await chmod(dir, 0o700);
  }
}

async function loadEncryptionConfig(userDataPath: string): Promise<EncryptionConfig | null> {
  try {
    const raw = await readFile(encryptionConfigPath(userDataPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && 'salt' in parsed && typeof parsed.salt === 'string'
      && 'keyCheck' in parsed && typeof parsed.keyCheck === 'string'
      && 'usePassword' in parsed && typeof parsed.usePassword === 'boolean'
    ) {
      return parsed as EncryptionConfig;
    }
  } catch { /* not configured yet */ }
  return null;
}

async function saveEncryptionConfig(userDataPath: string, config: EncryptionConfig): Promise<void> {
  await writeFile(encryptionConfigPath(userDataPath), JSON.stringify(config, null, 2));
}

async function collectFiles(dir: string, suffix: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, suffix));
    } else if (entry.name.endsWith(suffix)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectEncryptedFiles(dataDir: string): Promise<string[]> {
  return collectFiles(join(dataDir, 'aws', 'raw'), '.parquet.enc');
}

function collectParquetFiles(dataDir: string): Promise<string[]> {
  return collectFiles(join(dataDir, 'aws', 'raw'), '.parquet');
}

function loadKeyFromSafeStorage(userDataPath: string): Buffer | null {
  try {
    const encrypted = readFileSync(safeStorageKeyPath(userDataPath));
    const hex = safeStorage.decryptString(encrypted);
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

export function registerVaultHandlers(vaultCtx: VaultContext): VaultState {
  const { dataDir, userDataPath } = vaultCtx;
  const isE2E = process.env['COSTGOBLIN_E2E'] === '1';

  const vaultState: VaultState = {
    encryptionConfig: null,
    derivedKey: null,
    tempDataDir: null,
  };

  ipcMain.handle('vault:status', async (): Promise<VaultStatus> => {
    if (isE2E) return { state: 'unlocked' };

    const config = await loadEncryptionConfig(userDataPath);
    vaultState.encryptionConfig = config;

    if (config === null) {
      return { state: 'not-configured' };
    }

    if (!config.usePassword && config.keyCheck === '') {
      vaultState.encryptionConfig = config;
      return { state: 'unlocked' };
    }

    if (vaultState.derivedKey !== null) {
      return { state: 'unlocked' };
    }

    if (!config.usePassword) {
      const key = loadKeyFromSafeStorage(userDataPath);
      if (key !== null && verifyKeyCheck(Buffer.from(config.keyCheck, 'hex'), key)) {
        vaultState.derivedKey = key;
        const tempDir = tempVaultDir(userDataPath);
        await decryptDataToTemp(dataDir, tempDir, key);
        vaultState.tempDataDir = tempDir;
        logger.info('Vault auto-unlocked via system keychain');
        return { state: 'unlocked' };
      }
    }

    return { state: 'locked' };
  });

  ipcMain.handle('vault:unlock', async (_event, password: string): Promise<{ success: boolean; dataDir: string | null }> => {
    const config = await loadEncryptionConfig(userDataPath);
    if (config === null) {
      return { success: true, dataDir };
    }

    const salt = Buffer.from(config.salt, 'hex');
    const key = await deriveKey(password, salt);
    const keyCheck = Buffer.from(config.keyCheck, 'hex');

    if (!verifyKeyCheck(keyCheck, key)) {
      return { success: false, dataDir: null };
    }

    vaultState.derivedKey = key;
    vaultState.encryptionConfig = config;

    const tempDir = tempVaultDir(userDataPath);
    await decryptDataToTemp(dataDir, tempDir, key);
    vaultState.tempDataDir = tempDir;

    logger.info('Vault unlocked, data decrypted to temp');
    return { success: true, dataDir: tempDir };
  });

  ipcMain.handle('vault:setup', async (_event, password: string | null): Promise<void> => {
    if (password === null) {
      const config: EncryptionConfig = {
        salt: '',
        keyCheck: '',
        usePassword: false,
      };
      await saveEncryptionConfig(userDataPath, config);
      vaultState.encryptionConfig = config;
      logger.info('Vault setup complete (no encryption)');
      return;
    }

    const salt = generateSalt();
    const key = await deriveKey(password, salt);
    const keyCheck = createKeyCheck(key);

    const config: EncryptionConfig = {
      salt: salt.toString('hex'),
      keyCheck: keyCheck.toString('hex'),
      usePassword: true,
    };

    const parquetFiles = await collectParquetFiles(dataDir);
    for (const filePath of parquetFiles) {
      const encPath = `${filePath}.enc`;
      await encryptFile(filePath, encPath, key);
      await unlink(filePath);
    }

    await saveEncryptionConfig(userDataPath, config);
    vaultState.encryptionConfig = config;
    vaultState.derivedKey = key;

    const tempDir = tempVaultDir(userDataPath);
    await mkdirRestricted(tempDir);
    vaultState.tempDataDir = tempDir;

    logger.info(`Vault setup complete (password): ${String(parquetFiles.length)} files encrypted`);
  });

  ipcMain.handle('vault:reset', async (): Promise<void> => {
    const rawDir = join(dataDir, 'aws', 'raw');
    if (existsSync(rawDir)) {
      await rm(rawDir, { recursive: true });
    }
    await cleanupTemp(userDataPath);

    for (const path of [encryptionConfigPath(userDataPath), safeStorageKeyPath(userDataPath)]) {
      if (existsSync(path)) {
        await unlink(path);
      }
    }

    vaultState.encryptionConfig = null;
    vaultState.derivedKey = null;
    vaultState.tempDataDir = null;

    logger.info('Vault reset: all data wiped');
  });

  ipcMain.handle('vault:encrypt-file', async (_event, filePath: string): Promise<void> => {
    if (vaultState.derivedKey === null) return;
    const encPath = `${filePath}.enc`;
    await encryptFile(filePath, encPath, vaultState.derivedKey);
    await unlink(filePath);
  });

  return vaultState;
}

async function decryptDataToTemp(dataDir: string, tempDir: string, key: Buffer): Promise<void> {
  await cleanupTemp(dirname(tempDir));
  await mkdirRestricted(tempDir);

  const encFiles = await collectEncryptedFiles(dataDir);
  for (const encPath of encFiles) {
    const rel = relative(join(dataDir, 'aws', 'raw'), encPath).replace(/\.enc$/, '');
    const outPath = join(tempDir, 'aws', 'raw', rel);
    await mkdirRestricted(dirname(outPath));
    await decryptFile(encPath, outPath, key);
  }

  logger.info(`Decrypted ${String(encFiles.length)} files to temp`);
}

export async function cleanupTemp(userDataPath: string): Promise<void> {
  const tempDir = tempVaultDir(userDataPath);
  if (existsSync(tempDir)) {
    await rm(tempDir, { recursive: true });
    logger.info('Vault temp directory cleaned up');
  }
}
