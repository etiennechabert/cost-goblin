import {
  assertValidGcsBucketName,
  describeGcpImpersonationFailure,
  isGcpImpersonationError,
  SERVICE_ACCOUNT_EMAIL_RULE,
  isServiceAccountEmail,
  isStringRecord,
  logger,
  parseJsonArray,
  splitGcsLocation,
} from '@costgoblin/core';
import type { GcpProject, GcsDownloadCheckResult, GcsStorageOptions } from '@costgoblin/core';
import type { GcloudCaptureResult } from './gcloud-capture.js';

/** Pure parsers behind the GCP setup handlers, kept out of `handlers/setup.ts`
 *  so they can be tested without spawning gcloud or reaching Cloud Storage —
 *  the same split `setup-manifest.ts` makes for the AWS side. */

/** Projects whose buckets are still usable. `gcloud projects list` also
 *  returns projects pending deletion; a project the user picks must not
 *  vanish underneath the bucket step. An ABSENT lifecycleState is kept —
 *  older CLI versions omit it, and absent is not the same as non-ACTIVE. */
function isUsableLifecycle(entry: Readonly<Record<string, unknown>>): boolean {
  const state: unknown = entry['lifecycleState'];
  if (typeof state !== 'string') return true;
  return state === 'ACTIVE';
}

/** Narrow `gcloud projects list --format=json` stdout into the project list.
 *
 *  Returns `null` — NOT an empty array — when the payload isn't a JSON array.
 *  gcloud writes update nags and auth prose to stdout in some configurations
 *  while still exiting 0, and collapsing that into `[]` shows the wizard's
 *  "No Google Cloud projects found" panel — a claim about their account
 *  rather than the truth (we couldn't read the answer).
 *  An empty array still means genuinely zero projects. */
export function parseGcloudProjects(stdout: string): GcpProject[] | null {
  const parsed = parseJsonArray(stdout);
  if (parsed === null) return null;

  const projects: GcpProject[] = [];
  for (const entry of parsed) {
    if (!isStringRecord(entry)) continue;
    if (!isUsableLifecycle(entry)) continue;
    const rawId: unknown = entry['projectId'];
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const rawName: unknown = entry['name'];
    const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : rawId;
    projects.push({ projectId: rawId, name });
  }
  return projects;
}

/** Pull the child folder names out of a `getFiles({ delimiter: '/' })`
 *  response.
 *
 *  The SDK types `apiResponse` as `unknown` (the common prefixes live only
 *  there, not on the `File[]`), so every step is guarded. Names come back
 *  relative to `parentPrefix` and without the trailing delimiter, matching
 *  what `browseS3` returns for the AWS wizard. */
export function extractGcsPrefixNames(apiResponse: unknown, parentPrefix: string): string[] {
  if (!isStringRecord(apiResponse)) return [];
  const raw: unknown = apiResponse['prefixes'];
  if (!Array.isArray(raw)) return [];

  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    // A prefix outside the browsed folder would be mangled by a blind
    // length-slice into a name that resolves nowhere when clicked.
    if (!value.startsWith(parentPrefix)) continue;
    const relative = value.slice(parentPrefix.length).replace(/\/$/, '');
    if (relative.length === 0) continue;
    names.push(relative);
  }
  return names;
}

/** Pull the next page token out of a `getFiles({ autoPaginate: false })`
 *  `nextQuery`. The SDK types it `unknown`, so the shape is probed defensively:
 *  a missing or oddly-shaped `nextQuery` (e.g. after an SDK upgrade changes it)
 *  yields `undefined`, terminating the walk with whatever was collected rather
 *  than looping or throwing. */
export function gcsNextPageToken(nextQuery: unknown): string | undefined {
  return isStringRecord(nextQuery) && typeof nextQuery['pageToken'] === 'string'
    ? nextQuery['pageToken']
    : undefined;
}

/** One delimiter-listing page: the raw `apiResponse` (where the common prefixes
 *  live) and the token for the next page, or `undefined` when this is the last. */
export interface GcsPrefixPage {
  readonly apiResponse: unknown;
  readonly nextPageToken: string | undefined;
}

/** Walk the pages of a delimiter listing, collecting deduped child folder
 *  names. Extracted from the `setup:browse-gcs` handler so the token walk,
 *  cross-page dedupe, and the page cap are unit-testable without the Storage
 *  SDK. `fetchPage` performs one page; `maxPages` caps a pathological bucket —
 *  reaching it while a token is still pending sets `truncated`. A `getFiles`
 *  page bounds `items[] + prefixes[]` COMBINED, so a page of loose objects can
 *  carry no folders while more pages still do — hence walking rather than
 *  reading a single page. */
export async function collectGcsPrefixes(
  prefix: string,
  maxPages: number,
  fetchPage: (pageToken: string | undefined) => Promise<GcsPrefixPage>,
): Promise<{ prefixes: string[]; truncated: boolean }> {
  const prefixes: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pagesFetched = 0;
  do {
    const page = await fetchPage(pageToken);
    for (const name of extractGcsPrefixNames(page.apiResponse, prefix)) {
      if (seen.has(name)) continue;
      seen.add(name);
      prefixes.push(name);
    }
    pagesFetched += 1;
    pageToken = page.nextPageToken;
    if (pageToken !== undefined && pagesFetched >= maxPages) {
      return { prefixes, truncated: true };
    }
  } while (pageToken !== undefined);
  return { prefixes, truncated: false };
}

/** The service account the wizard browses AS, read off the IPC boundary.
 *
 *  Optional: blank means the user's own ADC login. When set it reaches an
 *  impersonation request and, written to the config, a gcloud argv array — so
 *  it is held to the validator's own address grammar here, before any SDK
 *  call, rather than trusted because the renderer already checked it. */
export function parseWizardReader(raw: unknown):
  | { readonly ok: true; readonly reader: string | undefined }
  | { readonly ok: false; readonly error: string } {
  if (raw === undefined) return { ok: true, reader: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `The reader must be ${SERVICE_ACCOUNT_EMAIL_RULE}` };
  const reader = raw.trim();
  if (reader.length === 0) return { ok: true, reader: undefined };
  if (!isServiceAccountEmail(reader)) {
    return { ok: false, error: `"${reader}" is not ${SERVICE_ACCOUNT_EMAIL_RULE}` };
  }
  return { ok: true, reader };
}

/** The wizard's copy for a failed bucket listing or browse. Only the
 *  impersonation denial is rewritten — into the Token Creator remedy, which
 *  the raw IAM sentence never names. Everything else passes through verbatim,
 *  because the wizard classifies the raw text to decide between a sign-in
 *  button and the bucket-list-denied explainer. */
export function wizardGcsErrorMessage(err: unknown, reader: string | undefined): string {
  if (err instanceof Error) {
    return isGcpImpersonationError(err) ? describeGcpImpersonationFailure(reader, err.message) : err.message;
  }
  return String(err);
}

/** The `setup:write-config` reader: absent stays `undefined` (the upsert
 *  carries the replaced entry's reader), blank becomes '' (the wizard browsed
 *  as the ADC login, which clears it). Throws on anything the next launch's
 *  validator would reject — written to disk, it would stop the app starting. */
export function wizardWriteReader(raw: unknown): string | undefined {
  const parsed = parseWizardReader(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return raw === undefined ? undefined : parsed.reader ?? '';
}

/** The slice of `Storage` bucket discovery uses — narrow so tests can inject it. */
export interface GcsBucketLister {
  getBuckets(): Promise<readonly [readonly { readonly name: string }[], ...unknown[]]>;
}

/** `setup:list-gcs-buckets`: the project's buckets, listed as the reader the
 *  wizard names (or the ADC login). `build` is `createGcsStorage` in the app —
 *  the sync's own constructor, so the wizard sees the identity the sync uses.
 *  Failures come back as text: the wizard classifies it to choose between a
 *  sign-in button and the bucket-list-denied explainer. */
export async function listGcsBucketsAs(
  projectId: string,
  rawReader: unknown,
  build: (options: GcsStorageOptions) => Promise<GcsBucketLister>,
): Promise<{ buckets: readonly { name: string }[]; error?: string | undefined }> {
  const parsed = parseWizardReader(rawReader);
  if (!parsed.ok) return { buckets: [], error: parsed.error };
  try {
    const storage = await build({ projectId, impersonateServiceAccount: parsed.reader });
    const [buckets] = await storage.getBuckets();
    return { buckets: buckets.map(b => ({ name: b.name })) };
  } catch (err: unknown) {
    const message = wizardGcsErrorMessage(err, parsed.reader);
    logger.info('setup:list-gcs-buckets failed', { error: message });
    return { buckets: [], error: message };
  }
}

/** What `setup:list-gcp-projects` answers for one `gcloud projects list` run.
 *  `GCLOUD_CLI_NOT_FOUND` is the sentinel the wizard renders as "install the
 *  gcloud CLI". */
export function gcloudProjectsOutcome(result: GcloudCaptureResult): { projects: readonly GcpProject[]; error?: string | undefined } {
  switch (result.kind) {
    case 'missing':
      return { projects: [], error: 'GCLOUD_CLI_NOT_FOUND' };
    case 'timeout':
      // A sentinel, not prose: the old message carried `gcloud auth login`,
      // which the wizard's credential check matched — so an organisation
      // whose thousands of projects simply outlast the ceiling was offered a
      // sign-in that could not help. The wizard words both causes.
      return { projects: [], error: 'GCLOUD_PROJECTS_TIMEOUT' };
    case 'failed':
      return { projects: [], error: result.message };
    case 'exited':
      break;
  }
  if (result.code === 0) {
    const projects = parseGcloudProjects(result.stdout);
    // Exit 0 but unreadable stdout. Reporting [] here would render the "No
    // Google Cloud projects found" panel — a false statement about their
    // account, with no remedy offered.
    return projects === null
      ? { projects: [], error: 'Could not read the project list from gcloud. Run `gcloud projects list` in a terminal to see what it printed.' }
      : { projects };
  }
  // gcloud's own stderr is the most useful thing to show: it names the exact
  // remedy ("You do not currently have an active account") that the wizard's
  // sign-in button then performs.
  const stderr = result.stderr.trim();
  return { projects: [], error: stderr.length > 0 ? stderr : `gcloud projects list failed (exit ${String(result.code)})` };
}

/** Ceiling on the wizard's download check. One non-recursive `ls` of a tier
 *  folder answers in a second or two; the ceiling is for a gcloud sitting on a
 *  re-auth prompt it will never get input for (stdin is ignored). */
export const GCS_DOWNLOAD_CHECK_TIMEOUT_MS = 30_000;

/** Characters that would stop the checked folder being the literal one the
 *  export lives in: control characters, and the wildcards `gcloud storage`
 *  expands (`*`, `?`, `[…]`) — a wildcard would list some OTHER match and
 *  could pass for a folder the download then cannot read. */
function hasUnsafeLocationChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '*' || ch === '?' || ch === '[' || ch === ']') return true;
  }
  return false;
}

/** The argv for the wizard's download check: `gcloud storage ls` of the
 *  export folder, as the identity the provider's `gcloud storage rsync` will
 *  run as — `--impersonate-service-account` exactly when the sync passes it.
 *
 *  Non-recursive on purpose: a tier folder holds one `billing_period=` entry
 *  per month, so the listing stays small without a flag to bound it. Throws
 *  before anything is spawned when the location is not a `gs://` path on a
 *  legal bucket — the same rules the config loader and the rsync sink hold
 *  the bucket to, since this argv reaches a cmd.exe line on Windows too. */
export function gcsDownloadCheckArgs(bucketPath: string, reader: string | undefined): string[] {
  if (!bucketPath.startsWith('gs://')) {
    throw new Error(`The export location must be a gs:// path, not ${JSON.stringify(bucketPath)}`);
  }
  const { bucket, prefix } = splitGcsLocation(bucketPath);
  assertValidGcsBucketName(bucket);
  if (hasUnsafeLocationChar(prefix)) {
    throw new Error(`The export folder ${JSON.stringify(prefix)} contains characters gcloud would treat as a pattern`);
  }
  const folder = prefix.length === 0 || prefix.endsWith('/') ? prefix : `${prefix}/`;
  const args = ['storage', 'ls', `gs://${bucket}/${folder}`];
  if (reader !== undefined) args.push(`--impersonate-service-account=${reader}`);
  return args;
}

/** What the wizard shows for one download-check run. `GCLOUD_CLI_NOT_FOUND`
 *  is the sentinel the wizard renders as "install the gcloud CLI". gcloud's
 *  stderr passes through otherwise — it names the denied principal and
 *  permission, the evidence of which identity actually ran — except an
 *  impersonation refusal, rewritten into the Token Creator remedy the raw
 *  IAM sentence never names (the same rewrite the bucket listing gets). */
export function gcsDownloadCheckOutcome(result: GcloudCaptureResult, reader: string | undefined): GcsDownloadCheckResult {
  switch (result.kind) {
    case 'missing':
      return { ok: false, error: 'GCLOUD_CLI_NOT_FOUND' };
    case 'timeout':
      // No `gcloud auth login` in the copy: the wizard keys its sign-in
      // button on that phrase, and a slow network is not fixed by one.
      return { ok: false, error: `gcloud did not answer within ${String(GCS_DOWNLOAD_CHECK_TIMEOUT_MS / 1000)} seconds. Check your connection, then Retry.` };
    case 'failed':
      return { ok: false, error: result.message };
    case 'exited':
      break;
  }
  if (result.code === 0) return { ok: true };
  const stderr = result.stderr.trim();
  if (stderr.length === 0) return { ok: false, error: `gcloud storage ls failed (exit ${String(result.code)})` };
  return isGcpImpersonationError(new Error(stderr))
    ? { ok: false, error: describeGcpImpersonationFailure(reader, stderr) }
    : { ok: false, error: stderr };
}

/** The side effects `verifyGcsDownloadAs` needs — injected so the request
 *  parsing and the refuse-before-spawn rules are testable without gcloud. */
export interface GcsDownloadCheckDeps {
  /** `runGcloudCapture` in the app: trusted binary, `gcloudSpawnShape`,
   *  trusted-first child PATH — the rsync download's own recipe. */
  readonly run: (args: readonly string[], timeoutMs: number, extraEnv: Readonly<Record<string, string>>) => Promise<GcloudCaptureResult>;
  /** The configured `keyFile` of the named GCP provider, if it has one. */
  readonly keyFileOf: (providerName: string) => Promise<string | undefined>;
}

/** `setup:verify-gcs-download`: can the provider's DOWNLOAD identity read the
 *  export folder? Everything arriving over IPC is re-checked here — the
 *  location by `gcsDownloadCheckArgs`, the reader by `parseWizardReader` —
 *  before gcloud is spawned. A named key-file provider's key is applied only
 *  when no reader is given, mirroring the upsert (a reader replaces the key,
 *  and the validator refuses both at once). */
export async function verifyGcsDownloadAs(raw: unknown, deps: GcsDownloadCheckDeps): Promise<GcsDownloadCheckResult> {
  if (!isStringRecord(raw)) return { ok: false, error: 'The download check needs an export location.' };
  const bucketPath: unknown = raw['bucketPath'];
  if (typeof bucketPath !== 'string') return { ok: false, error: 'The download check needs an export location.' };
  const parsed = parseWizardReader(raw['impersonateServiceAccount']);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let args: string[];
  try {
    args = gcsDownloadCheckArgs(bucketPath, parsed.reader);
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const extraEnv: Record<string, string> = {};
  const keyFileProvider: unknown = raw['keyFileProvider'];
  if (parsed.reader === undefined && typeof keyFileProvider === 'string' && keyFileProvider.length > 0) {
    const keyFile = await deps.keyFileOf(keyFileProvider);
    // The sync's rsync points gcloud at the key the same way, without
    // touching the user's global credential store.
    if (keyFile !== undefined) extraEnv['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] = keyFile;
  }

  const outcome = gcsDownloadCheckOutcome(await deps.run(args, GCS_DOWNLOAD_CHECK_TIMEOUT_MS, extraEnv), parsed.reader);
  if (!outcome.ok) logger.info('setup:verify-gcs-download failed', { error: outcome.error });
  return outcome;
}
