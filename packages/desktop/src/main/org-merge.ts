import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStringRecord, isValidProviderName } from '@costgoblin/core';
import type { OrgAccount, OrgSyncResult } from '@costgoblin/core';

/** Per-provider org-sync storage with a merged view (#516).
 *
 *  Layout in `stateDir`:
 *
 *    org-accounts.{provider}.json  — one provider's raw OrgSyncResult (sidecar)
 *    org-accounts.json             — merged view, REGENERATED from all sidecars
 *
 *  The merged file keeps the legacy `{ accounts, orgId, syncedAt }` shape —
 *  every consumer reads exactly that (org:get-result's decode, the rollup
 *  shape-signature digest, getAccountMap / loadOrgAccountsMap,
 *  generateFlatOrgTags, and data-sharing enrichment, which ships the file
 *  verbatim). Per-provider metadata rides along in an ADDITIVE `providers`
 *  array that all legacy readers ignore; the top-level orgId/syncedAt are the
 *  most recently synced provider's (last-synced wins).
 *
 *  Pure module: path-based node:fs I/O only, no Electron — unit-testable
 *  against a temp directory. */

export const MERGED_ORG_FILE = 'org-accounts.json';

/** `org-accounts.{provider}.json`. Provider names never contain dots (see
 *  PROVIDER_NAME_PATTERN) so the middle segment is unambiguous and the merged
 *  file name can never collide with a sidecar. */
const SIDECAR_PATTERN = /^org-accounts\.(.+)\.json$/;

export interface MergedOrgProviderMeta {
  readonly provider: string;
  readonly orgId: string;
  readonly syncedAt: string;
}

/** The merged file's full shape: legacy OrgSyncResult + additive metadata. */
export interface MergedOrgResult extends OrgSyncResult {
  readonly providers: readonly MergedOrgProviderMeta[];
}

export interface ProviderOrgInput {
  readonly providerName: string;
  readonly result: OrgSyncResult;
}

export interface OrgSidecarEntry {
  readonly providerName: string;
  readonly fileName: string;
}

export interface ClearOrgFilesResult {
  /** File names actually removed (for logging). */
  readonly deleted: readonly string[];
  /** Non-ENOENT unlink failures — the clear keeps going past them. */
  readonly failed: readonly { readonly file: string; readonly message: string }[];
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function isOrgAccount(v: unknown): v is OrgAccount {
  if (!isStringRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['email'] === 'string' &&
    typeof v['status'] === 'string' &&
    typeof v['joinedTimestamp'] === 'string' &&
    typeof v['ouPath'] === 'string' &&
    isStringRecord(v['tags'])
  );
}

/** Strict decode of an org-accounts JSON payload (merged file or sidecar —
 *  both carry the OrgSyncResult shape; a merged file's extra `providers` key
 *  is ignored). Null on any malformation. */
export function decodeOrgSyncResult(raw: string): OrgSyncResult | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isStringRecord(parsed)) return null;
  const accounts = parsed['accounts'];
  const orgId = parsed['orgId'];
  const syncedAt = parsed['syncedAt'];
  if (!Array.isArray(accounts) || typeof orgId !== 'string' || typeof syncedAt !== 'string') return null;
  if (!accounts.every(isOrgAccount)) return null;
  return { accounts, orgId, syncedAt };
}

/** Sidecar file name for one provider. Provider names come from the validated
 *  config (dir-safe by construction) — this re-validates as defense in depth
 *  since the name becomes part of a path inside stateDir. */
export function orgSidecarFileName(providerName: string): string {
  if (!isValidProviderName(providerName)) {
    throw new Error(`Invalid provider name "${providerName}"`);
  }
  return `org-accounts.${providerName}.json`;
}

/** All per-provider sidecar files present in stateDir. A missing stateDir
 *  reads as "no sidecars". File names whose provider segment fails validation
 *  are ignored (never written by us). */
export async function listOrgSidecars(stateDir: string): Promise<readonly OrgSidecarEntry[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }
  const out: OrgSidecarEntry[] = [];
  for (const fileName of entries) {
    const match = SIDECAR_PATTERN.exec(fileName);
    const providerName = match?.[1];
    if (providerName === undefined || !isValidProviderName(providerName)) continue;
    out.push({ providerName, fileName });
  }
  return out.sort((a, b) => a.providerName.localeCompare(b.providerName));
}

/** Pure merge of per-provider sync results into the merged-file shape.
 *  Accounts are concatenated and deduplicated by account id — the most
 *  recently synced provider wins a collision (ties broken by provider name
 *  for determinism). Top-level orgId/syncedAt are the winning (last-synced)
 *  provider's. Empty input merges to an empty result. */
export function mergeOrgResults(inputs: readonly ProviderOrgInput[]): MergedOrgResult {
  // Ascending sync order: later entries overwrite earlier ones in the map.
  const ordered = [...inputs].sort((a, b) =>
    a.result.syncedAt.localeCompare(b.result.syncedAt) || a.providerName.localeCompare(b.providerName));
  const byId = new Map<string, OrgAccount>();
  for (const input of ordered) {
    for (const account of input.result.accounts) {
      byId.set(account.id, account);
    }
  }
  const last = ordered[ordered.length - 1];
  return {
    accounts: [...byId.values()],
    orgId: last?.result.orgId ?? '',
    syncedAt: last?.result.syncedAt ?? '',
    providers: ordered.map(i => ({
      provider: i.providerName,
      orgId: i.result.orgId,
      syncedAt: i.result.syncedAt,
    })),
  };
}

/** Legacy adoption: pre-#516 installs have ONLY the merged org-accounts.json.
 *  On the first per-provider write, adopt that file as the FIRST configured
 *  provider's sidecar so a pre-upgrade org sync is never silently dropped.
 *  No-op (false) when any sidecar already exists, when there is no merged
 *  file, or when the merged file doesn't decode (it was unusable anyway —
 *  org:get-result would have returned null for it too). */
export async function adoptLegacyMergedFile(stateDir: string, firstProviderName: string): Promise<boolean> {
  const sidecars = await listOrgSidecars(stateDir);
  if (sidecars.length > 0) return false;
  let raw: string;
  try {
    raw = await readFile(join(stateDir, MERGED_ORG_FILE), 'utf-8');
  } catch {
    return false;
  }
  const decoded = decodeOrgSyncResult(raw);
  if (decoded === null) return false;
  await writeFile(
    join(stateDir, orgSidecarFileName(firstProviderName)),
    JSON.stringify(decoded, null, 2),
  );
  return true;
}

/** Rebuild the merged org-accounts.json from every decodable sidecar. Returns
 *  the merged result, or null — WITHOUT touching the existing merged file —
 *  when no sidecar contributes (none present, or none decodes). */
export async function regenerateMergedOrgFile(stateDir: string): Promise<MergedOrgResult | null> {
  const sidecars = await listOrgSidecars(stateDir);
  const inputs: ProviderOrgInput[] = [];
  for (const sidecar of sidecars) {
    let raw: string;
    try {
      raw = await readFile(join(stateDir, sidecar.fileName), 'utf-8');
    } catch {
      continue;
    }
    const decoded = decodeOrgSyncResult(raw);
    if (decoded === null) continue;
    inputs.push({ providerName: sidecar.providerName, result: decoded });
  }
  if (inputs.length === 0) return null;
  const merged = mergeOrgResults(inputs);
  await writeFile(join(stateDir, MERGED_ORG_FILE), JSON.stringify(merged, null, 2));
  return merged;
}

/** Store one provider's sync result: adopt a legacy merged-only layout if
 *  this is the first per-provider write, write the provider's sidecar, then
 *  regenerate the merged view from ALL sidecars. Returns the merged result. */
export async function writeProviderOrgResult(
  stateDir: string,
  providerName: string,
  firstProviderName: string,
  result: OrgSyncResult,
): Promise<MergedOrgResult> {
  await adoptLegacyMergedFile(stateDir, firstProviderName);
  await writeFile(
    join(stateDir, orgSidecarFileName(providerName)),
    JSON.stringify(result, null, 2),
  );
  const merged = await regenerateMergedOrgFile(stateDir);
  // Unreachable in practice — the sidecar we just wrote always decodes — but
  // degrade to a single-provider merge rather than a non-null assertion.
  return merged ?? mergeOrgResults([{ providerName, result }]);
}

/** The flat org-account-tags.json payload for the account-tag fallback,
 *  derived from the MERGED accounts so it covers every provider. Entry shape
 *  {id, tags, ouPath} matches context.ts's generateFlatOrgTags — including
 *  ouPath up front so getOrgAccountsPath's schema probe never has to
 *  regenerate the file. */
export function buildFlatOrgTags(accounts: readonly OrgAccount[]): string {
  return JSON.stringify(accounts.map(a => ({ id: a.id, tags: a.tags, ouPath: a.ouPath })));
}

/** Delete the merged file and every per-provider sidecar. ENOENT is swallowed
 *  (idempotent — clicking Clear twice must not error); other failures are
 *  collected so the caller can log them while the clear keeps going. */
export async function clearMergedAndSidecars(stateDir: string): Promise<ClearOrgFilesResult> {
  const sidecars = await listOrgSidecars(stateDir);
  const files = [MERGED_ORG_FILE, ...sidecars.map(s => s.fileName)];
  const deleted: string[] = [];
  const failed: { file: string; message: string }[] = [];
  for (const file of files) {
    try {
      await unlink(join(stateDir, file));
      deleted.push(file);
    } catch (err: unknown) {
      if (errorCode(err) !== 'ENOENT') {
        failed.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { deleted, failed };
}
