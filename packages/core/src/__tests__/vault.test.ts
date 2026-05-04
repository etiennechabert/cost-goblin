import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  encryptFile,
  decryptFile,
  createKeyCheck,
  verifyKeyCheck,
} from '../vault/vault.js';

describe('crypto-service', () => {
  describe('generateSalt', () => {
    it('returns 32 bytes', () => {
      const salt = generateSalt();
      expect(salt.length).toBe(32);
    });

    it('produces unique values', () => {
      const a = generateSalt();
      const b = generateSalt();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it('derives a 32-byte key', async () => {
      const salt = generateSalt();
      const key = await deriveKey('test-password', salt);
      expect(key.length).toBe(32);
    });

    it('same password + salt produces same key', async () => {
      const salt = generateSalt();
      const key1 = await deriveKey('my-password', salt);
      const key2 = await deriveKey('my-password', salt);
      expect(key1.equals(key2)).toBe(true);
    });

    it('different passwords produce different keys', async () => {
      const salt = generateSalt();
      const key1 = await deriveKey('password-a', salt);
      const key2 = await deriveKey('password-b', salt);
      expect(key1.equals(key2)).toBe(false);
    });

    it('different salts produce different keys', async () => {
      const key1 = await deriveKey('same-password', generateSalt());
      const key2 = await deriveKey('same-password', generateSalt());
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips data correctly', async () => {
      const salt = generateSalt();
      const key = await deriveKey('test', salt);
      const plaintext = Buffer.from('hello world');
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('fails with wrong key', async () => {
      const key1 = await deriveKey('pass1', generateSalt());
      const key2 = await deriveKey('pass2', generateSalt());
      const encrypted = encrypt(Buffer.from('secret'), key1);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('rejects truncated data', async () => {
      const key = await deriveKey('test', generateSalt());
      expect(() => decrypt(Buffer.alloc(10), key)).toThrow('too short');
    });

    it('each encryption produces different ciphertext (unique IV)', async () => {
      const key = await deriveKey('test', generateSalt());
      const plaintext = Buffer.from('same data');
      const a = encrypt(plaintext, key);
      const b = encrypt(plaintext, key);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('encryptFile / decryptFile', () => {
    it('round-trips a file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cg-crypto-test-'));
      try {
        const salt = generateSalt();
        const key = await deriveKey('file-test', salt);
        const inputPath = join(dir, 'input.parquet');
        const encPath = join(dir, 'input.parquet.enc');
        const outPath = join(dir, 'output.parquet');

        const content = Buffer.from('fake parquet content for testing');
        await writeFile(inputPath, content);

        await encryptFile(inputPath, encPath, key);
        const encryptedOnDisk = await readFile(encPath);
        expect(encryptedOnDisk.equals(content)).toBe(false);

        await decryptFile(encPath, outPath, key);
        const restored = await readFile(outPath);
        expect(restored.equals(content)).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  describe('keyCheck', () => {
    it('verifies correct key', async () => {
      const key = await deriveKey('correct', generateSalt());
      const check = createKeyCheck(key);
      expect(verifyKeyCheck(check, key)).toBe(true);
    });

    it('rejects wrong key', async () => {
      const key1 = await deriveKey('right', generateSalt());
      const key2 = await deriveKey('wrong', generateSalt());
      const check = createKeyCheck(key1);
      expect(verifyKeyCheck(check, key2)).toBe(false);
    });
  });
});
