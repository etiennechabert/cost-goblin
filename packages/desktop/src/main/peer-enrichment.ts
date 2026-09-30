import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasControlChar, isStringRecord, parseJsonObject } from '@costgoblin/core';
import type {
  OrgAccount,
  OrgSyncResult,
  PackEnrichment,
  RegionEnrichment,
  SharedEnrichmentSummary,
  SharedPullSelection,
} from '@costgoblin/core';
import { MERGED_ORG_FILE, buildFlatOrgTags, decodeOrgSyncResult } from './org-merge.js';

/** Enrichment a teammate's snapshot carries: account names/tags/OU paths and
 *  region names. It lands in files the query layer reads directly (account
 *  names, the account-tag fallback join, the region alias CASE), so on the
 *  pulling side it is untrusted input:
 *
 *   - applied only with the consumer's consent (the `config` tier), and
 *   - strictly decoded, capped and canonicalised before anything is written
 *     — a payload that fails is rejected WHOLE and the local file is left
 *     byte-identical (never deleted, never partially overwritten).
 *
 *  The flat account-tags file is always DERIVED locally from the decoded
 *  accounts (never the peer's copy), so it can never be `[]` or carry rows
 *  missing the columns the fallback join selects.
 *
 *  Pure module: node:fs I/O against a caller-supplied directory, no Electron —
 *  unit-testable against a temp dir. */

/** Outcome of strictly decoding one untrusted enrichment payload. */
export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** The canonical region-names.json shape (what `ssm:sync-region-names`
 *  writes and `getRegionMap` reads). */
export interface RegionNamesFile {
  readonly syncedAt: string;
  readonly regions: Readonly<Record<string, RegionEnrichment>>;
}

/** What happened to one enrichment file on a pull. `skipped`: nothing to
 *  write (the peer sent nothing for it); `rejected`: the payload failed the
 *  strict decode. Either way the local file is left byte-identical. */
export type EnrichmentFileReport =
  | { readonly file: string; readonly status: 'written' }
  | { readonly file: string; readonly status: 'skipped' }
  | { readonly file: string; readonly status: 'rejected'; readonly reason: string };

const FLAT_ORG_TAGS_FILE = 'org-account-tags.json';
const REGION_NAMES_FILE = 'region-names.json';

// Caps sit far above anything AWS Organizations / SSM produce, so a real
// snapshot always passes; they only bound what a hostile peer can plant.
const MAX_ACCOUNTS = 50_000;
/** AWS 12-digit ids and GCP project ids both fit; excludes whitespace,
 *  quotes and control characters by construction. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ACCOUNT_FIELD = 256;
const MAX_OU_PATH = 1024;
const MAX_TAGS_PER_ACCOUNT = 200;
const MAX_TAG_KEY = 128;
const MAX_TAG_VALUE = 256;
const MAX_ORG_META = 128;

const MAX_REGIONS = 500;
const REGION_CODE_PATTERN = /^[a-z0-9-]{1,40}$/;
const MAX_REGION_FIELD = 128;

function fail<T>(reason: string): DecodeResult<T> {
  return { ok: false, reason };
}

/** An unpaired UTF-16 surrogate. JSON.stringify writes it as a `\\uD800`
 *  escape that DuckDB's read_json rejects, failing every query that joins the
 *  flat tags file. (Code units, not the `u` flag, so a lone half matches.) */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** At most `max` UTF-16 units, free of control characters (NUL included —
 *  it would cut a SQL alias CASE short) and well-formed UTF-16. */
function isBoundedText(value: string, max: number): boolean {
  return value.length <= max && !hasControlChar(value) && !LONE_SURROGATE.test(value);
}

/** Why one decoded account is unacceptable, or null when it is fine. The
 *  reason never echoes peer text (only an already-validated id), so it is
 *  safe to log. */
function accountProblem(account: OrgAccount): string | null {
  if (!ACCOUNT_ID_PATTERN.test(account.id)) return 'invalid account id';
  const fields = [account.name, account.email, account.status, account.joinedTimestamp];
  if (!fields.every(f => isBoundedText(f, MAX_ACCOUNT_FIELD))) {
    return `account ${account.id}: a name/email/status/joinedTimestamp is too long or has a control character`;
  }
  if (!isBoundedText(account.ouPath, MAX_OU_PATH)) {
    return `account ${account.id}: ouPath is too long or has a control character`;
  }
  const tags = Object.entries(account.tags);
  if (tags.length > MAX_TAGS_PER_ACCOUNT) return `account ${account.id}: more than ${String(MAX_TAGS_PER_ACCOUNT)} tags`;
  const badTag = tags.some(([key, value]) => !isBoundedText(key, MAX_TAG_KEY) || !isBoundedText(value, MAX_TAG_VALUE));
  if (badTag) return `account ${account.id}: a tag key/value is too long or has a control character`;
  return null;
}

/** Only the known OrgAccount fields — a peer's extra keys never reach disk. */
function canonicalAccount(account: OrgAccount): OrgAccount {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    status: account.status,
    joinedTimestamp: account.joinedTimestamp,
    ouPath: account.ouPath,
    tags: Object.fromEntries(Object.entries(account.tags)),
  };
}

/** Strictly decode a peer's org-accounts.json. Shape-checked by the same
 *  decoder the app uses for its own file (which requires every field,
 *  joinedTimestamp included, and string tag values), then capped, checked
 *  for control characters, and canonicalised. Any bad account rejects the
 *  WHOLE payload. */
export function decodePeerOrgAccounts(raw: string): DecodeResult<OrgSyncResult> {
  const decoded = decodeOrgSyncResult(raw);
  if (decoded === null) return fail('malformed org accounts');
  if (decoded.accounts.length === 0) return fail('empty');
  if (decoded.accounts.length > MAX_ACCOUNTS) return fail(`more than ${String(MAX_ACCOUNTS)} accounts`);
  if (!isBoundedText(decoded.orgId, MAX_ORG_META) || !isBoundedText(decoded.syncedAt, MAX_ORG_META)) {
    return fail('orgId/syncedAt is too long or has a control character');
  }
  // The flat tags file derived from these accounts is LEFT JOINed onto every
  // cost row by id, so a repeated id would repeat that account's costs.
  const seen = new Set<string>();
  for (const account of decoded.accounts) {
    const problem = accountProblem(account);
    if (problem !== null) return fail(problem);
    if (seen.has(account.id)) return fail(`duplicate account id ${account.id}`);
    seen.add(account.id);
  }
  return {
    ok: true,
    value: { accounts: decoded.accounts.map(canonicalAccount), orgId: decoded.orgId, syncedAt: decoded.syncedAt },
  };
}

function decodeRegionEntry(code: string, info: unknown): RegionEnrichment | null {
  if (!REGION_CODE_PATTERN.test(code) || !isStringRecord(info)) return null;
  const longName = info['longName'];
  const country = info['country'];
  const continent = info['continent'];
  if (typeof longName !== 'string' || typeof country !== 'string' || typeof continent !== 'string') return null;
  if (longName.length === 0) return null;
  const bounded = [longName, country, continent].every(v => isBoundedText(v, MAX_REGION_FIELD));
  return bounded ? { longName, country, continent } : null;
}

/** Strictly decode a peer's region-names.json: 1–500 entries, lowercase
 *  code grammar, a non-empty longName, every field capped and free of
 *  control characters. Canonicalised to the SSM-sync shape. */
export function decodeRegionNames(raw: string): DecodeResult<RegionNamesFile> {
  const parsed = parseJsonObject(raw);
  if (parsed === null) return fail('malformed region names');
  const syncedAt = parsed['syncedAt'];
  const regions = parsed['regions'];
  if (typeof syncedAt !== 'string' || !isStringRecord(regions)) return fail('malformed region names');
  if (!isBoundedText(syncedAt, MAX_REGION_FIELD)) return fail('syncedAt is too long or has a control character');
  const entries = Object.entries(regions);
  if (entries.length === 0 || entries.length > MAX_REGIONS) {
    return fail(`expected 1-${String(MAX_REGIONS)} regions, got ${String(entries.length)}`);
  }
  const canonical: [string, RegionEnrichment][] = [];
  for (const [code, info] of entries) {
    const entry = decodeRegionEntry(code, info);
    if (entry === null) return fail('invalid region entry');
    canonical.push([code, entry]);
  }
  return { ok: true, value: { syncedAt, regions: Object.fromEntries(canonical) } };
}

/** What a snapshot's enrichment would replace, counted with the same strict
 *  decoders the pull applies — for the pre-pull preview. A part that is
 *  missing or fails to decode counts 0 (it would not be written); null when
 *  neither part would be. */
export function summarizePeerEnrichment(enrichment: PackEnrichment): SharedEnrichmentSummary | null {
  const org = enrichment.orgAccounts === null ? null : decodePeerOrgAccounts(enrichment.orgAccounts);
  const regionNames = enrichment.regionNames === null ? null : decodeRegionNames(enrichment.regionNames);
  const accounts = org?.ok === true ? org.value.accounts.length : 0;
  const regions = regionNames?.ok === true ? Object.keys(regionNames.value.regions).length : 0;
  return accounts === 0 && regions === 0 ? null : { accounts, regions };
}

/** Whether a pull may touch local enrichment. Same rule as the config
 *  bundle: an explicit selection must include `config`; no selection at all
 *  (the legacy pull-everything default) consents. */
export function enrichmentConsent(selection?: SharedPullSelection): boolean {
  return selection === undefined || selection.sources.includes('config');
}

interface PendingWrite {
  readonly file: string;
  readonly content: string;
}

interface EnrichmentPlan {
  readonly reports: readonly EnrichmentFileReport[];
  readonly writes: readonly PendingWrite[];
}

function planOrgAccounts(raw: string | null): EnrichmentPlan {
  const skippedFlat: EnrichmentFileReport = { file: FLAT_ORG_TAGS_FILE, status: 'skipped' };
  if (raw === null) return { reports: [{ file: MERGED_ORG_FILE, status: 'skipped' }, skippedFlat], writes: [] };
  const decoded = decodePeerOrgAccounts(raw);
  if (!decoded.ok) {
    return { reports: [{ file: MERGED_ORG_FILE, status: 'rejected', reason: decoded.reason }, skippedFlat], writes: [] };
  }
  return {
    reports: [{ file: MERGED_ORG_FILE, status: 'written' }, { file: FLAT_ORG_TAGS_FILE, status: 'written' }],
    writes: [
      { file: MERGED_ORG_FILE, content: JSON.stringify(decoded.value, null, 2) },
      // Derived here from the decoded accounts — never the peer's copy.
      { file: FLAT_ORG_TAGS_FILE, content: buildFlatOrgTags(decoded.value.accounts) },
    ],
  };
}

function planRegionNames(raw: string | null): EnrichmentPlan {
  if (raw === null) return { reports: [{ file: REGION_NAMES_FILE, status: 'skipped' }], writes: [] };
  const decoded = decodeRegionNames(raw);
  if (!decoded.ok) return { reports: [{ file: REGION_NAMES_FILE, status: 'rejected', reason: decoded.reason }], writes: [] };
  return {
    reports: [{ file: REGION_NAMES_FILE, status: 'written' }],
    writes: [{ file: REGION_NAMES_FILE, content: JSON.stringify(decoded.value, null, 2) }],
  };
}

/** Apply a consented pull's enrichment to `stateDir`. The caller gates on
 *  enrichmentConsent first. Each file is decided independently: a null or
 *  rejected field leaves its local file untouched. The peer's
 *  `orgAccountTags` is deliberately ignored (see the module comment). */
export async function applyPulledEnrichment(
  stateDir: string,
  enrichment: PackEnrichment,
): Promise<readonly EnrichmentFileReport[]> {
  const plans = [planOrgAccounts(enrichment.orgAccounts), planRegionNames(enrichment.regionNames)];
  const writes = plans.flatMap(p => p.writes);
  if (writes.length > 0) {
    await mkdir(stateDir, { recursive: true });
    for (const w of writes) await writeFile(join(stateDir, w.file), w.content, 'utf-8');
  }
  return plans.flatMap(p => p.reports);
}
