import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MCP_MIN_TOKEN_LENGTH } from '@costgoblin/mcp';
import { tightenToOwnerOnly, writeOwnerOnlyFileSync } from './owner-only-file.js';

/** 32 random bytes, base64url-encoded (43 chars), sent by clients as an
 *  `Authorization: Bearer <token>` header. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function persistToken(filePath: string, token: string): void {
  // 0o600: only the current user can read the secret.
  writeOwnerOnlyFileSync(filePath, token);
}

/** Load the persisted MCP auth token, generating and saving one on first use.
 *  The token is stable across restarts so a user's copy-pasted client config
 *  keeps working until they explicitly regenerate it. A stored token shorter
 *  than the server's minimum counts as missing and is replaced; otherwise the
 *  server could never start. */
export function loadOrCreateMcpToken(filePath: string): string {
  // A file loosened outside the app must not stay readable by other users
  // just because its token is still valid. Best effort, before the read.
  tightenToOwnerOnly(filePath);
  try {
    const existing = readFileSync(filePath, 'utf-8').trim();
    if (existing.length >= MCP_MIN_TOKEN_LENGTH) return existing;
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
