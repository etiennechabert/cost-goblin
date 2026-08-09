/** Recognising the GCP FOCUS exporter's output layout from a folder listing.
 *
 *  The AWS side answers "is this a billing export?" by finding `data/` and
 *  `metadata/` siblings and parsing the manifest JSON beside them. The GCP
 *  exporter writes no manifest at all — its layout is
 *
 *    gs://<BUCKET>/<PREFIX>/<TIER>/billing_period=YYYY-MM/shard-*.parquet
 *
 *  so the partition folders ARE the marker. These helpers are pure so the
 *  browse wizard and any future validator classify a listing the same way.
 */

/** The two grains `scripts/gcp-focus-exporter` can publish. There is no
 *  `cost-optimization` tier: GCP has no Cost Optimization Hub analogue, and
 *  `validateGcpSync` rejects that key outright. */
export type GcsTier = 'daily' | 'hourly';

const TIER_ORDER: readonly GcsTier[] = ['daily', 'hourly'];

/** What one folder level looks like, judged by its immediate child folders.
 *
 *  `tier-parent` exists to catch the single most common GCP misconfiguration:
 *  pointing a provider at the exporter's PREFIX (`gs://bucket/focus`) instead
 *  of a tier folder under it (`gs://bucket/focus/daily`), which makes the
 *  daily tier list the hourly shards as well. The sync already fails on this
 *  after the fact; naming it here lets the wizard refuse it up front. */
export type GcsFolderKind =
  | { readonly kind: 'export'; readonly periods: readonly string[] }
  | { readonly kind: 'tier-parent'; readonly tiers: readonly GcsTier[] }
  | { readonly kind: 'unknown' };

/** Anchored at both ends so `x-billing_period=2026-07` cannot match, and the
 *  month is bounded to 01-12 — the period string keys the sync's own
 *  `raw/{tier}-{period}/` directories, so a folder that merely looks like one
 *  would have the wizard accept a location the sync then finds empty. */
const BILLING_PERIOD_PATTERN = /^billing_period=(\d{4}-(?:0[1-9]|1[0-2]))$/;

/** A GCS common prefix arrives with its trailing delimiter (`daily/`); a
 *  hand-typed folder name generally does not. Accept both everywhere. */
function stripTrailingSlash(name: string): string {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

/** The `YYYY-MM` inside an exporter period folder, or null when the name is
 *  not one. */
export function parseBillingPeriod(folderName: string): string | null {
  const match = BILLING_PERIOD_PATTERN.exec(stripTrailingSlash(folderName));
  return match?.[1] ?? null;
}

export function isBillingPeriodFolder(folderName: string): boolean {
  return parseBillingPeriod(folderName) !== null;
}

/** Whether two tier locations resolve to the same folder or one inside the
 *  other.
 *
 *  This is the rule `validateGcpSync` enforces at load time; the setup wizard
 *  applies it while the user is still choosing, so an overlapping pair is
 *  refused with a hint instead of being written into a config that then
 *  refuses to load on the next launch. Compared on normalized prefixes so a
 *  trailing slash, or a parent path, is caught as well as an exact match. */
export function gcsTiersOverlap(a: string, b: string): boolean {
  const norm = (v: string): string => {
    const stripped = v.startsWith('gs://') ? v.slice('gs://'.length) : v;
    let end = stripped.length;
    while (end > 0 && stripped.charAt(end - 1) === '/') end--;
    return `${stripped.slice(0, end)}/`;
  };
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** Classify a folder from the names of its immediate children.
 *
 *  `export` wins over `tier-parent` when both readings are available: the
 *  period partitions are what the sync actually reads, so a tier folder that
 *  happens to contain a stray `daily/` must stay selectable. */
export function classifyGcsFolder(childFolders: readonly string[]): GcsFolderKind {
  const periods = childFolders
    .map(parseBillingPeriod)
    .filter((p): p is string => p !== null)
    .sort((a, b) => a.localeCompare(b));

  if (periods.length > 0) return { kind: 'export', periods };

  const present = new Set(childFolders.map(stripTrailingSlash));
  const tiers = TIER_ORDER.filter(t => present.has(t));
  if (tiers.length > 0) return { kind: 'tier-parent', tiers };

  return { kind: 'unknown' };
}
