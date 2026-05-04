export interface EncryptionConfig {
  readonly salt: string;
  readonly keyCheck: string;
  readonly usePassword: boolean;
}
