export {
  generateSalt,
  deriveKey,
  encrypt,
  decrypt,
  encryptFile,
  decryptFile,
  createKeyCheck,
  verifyKeyCheck,
} from './vault.js';

export type { EncryptionConfig } from './types.js';
