import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readTextIfExists, writeFileAtomic } from '@costgoblin/core';
import { MCP_MIN_TOKEN_LENGTH } from '@costgoblin/mcp';

/** 32 random bytes, base64url-encoded (43 chars), sent by clients as an
 *  `Authorization: Bearer <token>` header. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

async function persistToken(filePath: string, token: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // 0o600: only the current user can read the secret — set on the new file
  // before it replaces the old, so one left at 0644 is tightened too.
  await writeFileAtomic(filePath, token, { mode: 0o600 });
}

/** Load the persisted MCP auth token, generating and saving one on first use.
 *  The token is stable across restarts so a user's copy-pasted client config
 *  keeps working until they explicitly regenerate it. Only a missing file means
 *  "first use": any other read failure (transient ones are retried) throws, as
 *  minting a token over a file that was merely locked would silently break
 *  every configured client. A stored token shorter than the server's minimum
 *  counts as missing and is replaced; no client can be using it, since the
 *  server could never start with it. */
export async function loadOrCreateMcpToken(filePath: string): Promise<string> {
  const existing = (await readTextIfExists(filePath))?.trim();
  if (existing !== undefined && existing.length >= MCP_MIN_TOKEN_LENGTH) return existing;
  const token = generateToken();
  await persistToken(filePath, token);
  return token;
}

/** Rotate the token: any client using the old value stops working until its
 *  config is updated. */
export async function regenerateMcpToken(filePath: string): Promise<string> {
  const token = generateToken();
  await persistToken(filePath, token);
  return token;
}
