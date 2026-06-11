import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 32 random bytes, URL-safe so it works both as a Bearer token and as a
 *  `?token=` query param. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function persistToken(filePath: string, token: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // 0o600: only the current user can read the secret.
  writeFileSync(filePath, token, { mode: 0o600 });
}

/** Load the persisted MCP auth token, generating and saving one on first use.
 *  The token is stable across restarts so a user's copy-pasted client config
 *  keeps working until they explicitly regenerate it. */
export function loadOrCreateMcpToken(filePath: string): string {
  try {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing.length > 0) return existing;
  } catch {
    // file missing or unreadable — fall through and create a fresh token
  }
  const token = generateToken();
  persistToken(filePath, token);
  return token;
}

/** Rotate the token: any client using the old value stops working until its
 *  config is updated. */
export function regenerateMcpToken(filePath: string): string {
  const token = generateToken();
  persistToken(filePath, token);
  return token;
}
