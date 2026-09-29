import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MCP_MIN_TOKEN_LENGTH } from '@costgoblin/mcp';

/** 32 random bytes, base64url-encoded (43 chars), sent by clients as an
 *  `Authorization: Bearer <token>` header. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function persistToken(filePath: string, token: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // 0o600: only the current user can read the secret. writeFileSync's `mode`
  // applies only when it creates the file, so an existing file (say, one left
  // at 0644) is tightened explicitly after the write.
  writeFileSync(filePath, token, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/** Load the persisted MCP auth token, generating and saving one on first use.
 *  The token is stable across restarts so a user's copy-pasted client config
 *  keeps working until they explicitly regenerate it. A stored token shorter
 *  than the server's minimum counts as missing and is replaced; otherwise the
 *  server could never start. */
export function loadOrCreateMcpToken(filePath: string): string {
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
