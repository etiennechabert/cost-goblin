export interface EncryptionConfig {
  readonly enabled: boolean;
  readonly salt: string;
  readonly keyCheck: string;
}
