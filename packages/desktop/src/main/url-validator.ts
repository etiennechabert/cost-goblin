export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

// Allowlist check before shell.openExternal to block file://, javascript:, data:, etc.
export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecurityError(`Malformed URL "${url}"`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SecurityError(`Blocked protocol "${parsed.protocol}" in URL "${url}" — only https:// and http:// are allowed`);
  }
}
