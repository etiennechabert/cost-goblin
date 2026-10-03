import {
  describeGcpImpersonationFailure,
  isGcpImpersonationError,
  SERVICE_ACCOUNT_EMAIL_RULE,
  isServiceAccountEmail,
  isStringRecord,
  logger,
  parseJsonArray,
} from '@costgoblin/core';
import type { GcpProject, GcsStorageOptions } from '@costgoblin/core';

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
