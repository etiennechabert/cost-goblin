import { ipcMain } from 'electron';
import { readFile, writeFile, readdir, mkdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  | { state: 'disabled' }
  | { state: 'locked' }
  | { state: 'unlocked' };

function encryptionConfigPath(userDataPath: string): string {
  return join(userDataPath, 'encryption.json');
}

function tempVaultDir(userDataPath: string): string {
  return join(userDataPath, 'vault-temp');
}

async function loadEncryptionConfig(userDataPath: string): Promise<EncryptionConfig | null> {
  try {
    const raw = await readFile(encryptionConfigPath(userDataPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && 'enabled' in parsed && typeof parsed.enabled === 'boolean'
      && 'salt' in parsed && typeof parsed.salt === 'string'
      && 'keyCheck' in parsed && typeof parsed.keyCheck === 'string'
    ) {
      return parsed as EncryptionConfig;
    }
  } catch { /* not configured yet */ }
  return null;
}

async function saveEncryptionConfig(userDataPath: string, config: EncryptionConfig): Promise<void> {
  await writeFile(encryptionConfigPath(userDataPath), JSON.stringify(config, null, 2));
}

async function collectEncryptedFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];
  const rawDir = join(dataDir, 'aws', 'raw');
  if (!existsSync(rawDir)) return files;

  const periods = await readdir(rawDir);
  for (const period of periods) {
    const periodDir = join(rawDir, period);
    const entries = await readdir(periodDir);
    for (const entry of entries) {
      if (entry.endsWith('.parquet.enc')) {
        files.push(join(periodDir, entry));
      }
    }
  }
  return files;
}

async function collectParquetFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];
  const rawDir = join(dataDir, 'aws', 'raw');
  if (!existsSync(rawDir)) return files;

  const periods = await readdir(rawDir);
  for (const period of periods) {
    const periodDir = join(rawDir, period);
    const entries = await readdir(periodDir);
    for (const entry of entries) {
      if (entry.endsWith('.parquet')) {
        files.push(join(periodDir, entry));
      }
    }
  }
  return files;
}

export function registerVaultHandlers(vaultCtx: VaultContext): VaultState {
  const { dataDir, userDataPath } = vaultCtx;

  const vaultState: VaultState = {
    encryptionConfig: null,
    derivedKey: null,
    tempDataDir: null,
  };

  ipcMain.handle('vault:status', async (): Promise<VaultStatus> => {
    const config = await loadEncryptionConfig(userDataPath);
    vaultState.encryptionConfig = config;
    if (config === null || !config.enabled) {
      return { state: 'disabled' };
    }
    if (vaultState.derivedKey === null) {
      return { state: 'locked' };
    }
    return { state: 'unlocked' };
  });

  ipcMain.handle('vault:unlock', async (_event, password: string): Promise<{ success: boolean; dataDir: string | null }> => {
    const config = await loadEncryptionConfig(userDataPath);
    if (config === null || !config.enabled) {
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

  ipcMain.handle('vault:setup', async (_event, password: string): Promise<void> => {
    const salt = generateSalt();
    const key = await deriveKey(password, salt);
    const keyCheck = createKeyCheck(key);

    const config: EncryptionConfig = {
      enabled: true,
      salt: salt.toString('hex'),
      keyCheck: keyCheck.toString('hex'),
    };

    // Encrypt any existing parquet files in place
    const parquetFiles = await collectParquetFiles(dataDir);
    for (const filePath of parquetFiles) {
      const encPath = `${filePath}.enc`;
      await encryptFile(filePath, encPath, key);
      await unlink(filePath);
    }

    await saveEncryptionConfig(userDataPath, config);
    vaultState.encryptionConfig = config;
    vaultState.derivedKey = key;

    logger.info(`Vault setup complete: ${String(parquetFiles.length)} files encrypted`);
  });

  ipcMain.handle('vault:reset', async (): Promise<void> => {
    // Wipe all data and encryption config
    const rawDir = join(dataDir, 'aws', 'raw');
    if (existsSync(rawDir)) {
      await rm(rawDir, { recursive: true });
    }
    await cleanupTemp(userDataPath);

    const configPath = encryptionConfigPath(userDataPath);
    if (existsSync(configPath)) {
      await unlink(configPath);
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
  await mkdir(tempDir, { recursive: true });

  const encFiles = await collectEncryptedFiles(dataDir);
  for (const encPath of encFiles) {
    const rel = relative(join(dataDir, 'aws', 'raw'), encPath).replace(/\.enc$/, '');
    const outPath = join(tempDir, 'aws', 'raw', rel);
    await mkdir(dirname(outPath), { recursive: true });
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
