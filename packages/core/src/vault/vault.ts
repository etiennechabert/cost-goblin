import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

interface ScryptOptions {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly maxmem: number;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err === null) resolve(derivedKey);
      else reject(err);
    });
  });
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_LENGTH = 32;
const KEY_CHECK_PLAINTEXT = Buffer.from('costgoblin-key-check');

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const key = await scryptAsync(password, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  });
  return key;
}

export function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decrypt(encryptedData: Buffer, key: Buffer): Buffer {
  if (encryptedData.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }
  const iv = encryptedData.subarray(0, IV_LENGTH);
  const authTag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function encryptFile(inputPath: string, outputPath: string, key: Buffer): Promise<void> {
  const data = await readFile(inputPath);
  const encrypted = encrypt(data, key);
  await writeFile(outputPath, encrypted);
}

export async function decryptFile(inputPath: string, outputPath: string, key: Buffer): Promise<void> {
  const data = await readFile(inputPath);
  const decrypted = decrypt(data, key);
  await writeFile(outputPath, decrypted);
}

export function createKeyCheck(key: Buffer): Buffer {
  return encrypt(KEY_CHECK_PLAINTEXT, key);
}

export function verifyKeyCheck(keyCheck: Buffer, key: Buffer): boolean {
  try {
    const decrypted = decrypt(keyCheck, key);
    return decrypted.equals(KEY_CHECK_PLAINTEXT);
  } catch {
    return false;
  }
}
