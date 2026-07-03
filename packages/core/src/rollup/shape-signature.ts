import type { BuiltInDimension, DimensionsConfig, TagDimension } from '../types/config.js';
import type { CostMetric, CostPerspective, ExclusionRule, MarketplaceAttributionConfig } from '../types/cost-scope.js';
import { tagDimColumn } from '../types/branded.js';
import { normalizeTagValue, resolveAlias } from '../normalize/normalize.js';
import { canonicalJson, sha256Hex } from './digest.js';

/** Bump to invalidate every persisted rollup partition (e.g. when the stored
 *  partition schema or build semantics change in a backwards-incompatible way).
 *  Prefer a conditional signature marker (see `exclusionSemantics` below) when
 *  only some configs are affected — a version bump forces a full-history
 *  rebuild for everyone, including configs whose partitions are byte-identical. */
export const ROLLUP_SCHEMA_VERSION = 1;

function isEnabled(d: { readonly enabled?: boolean | undefined }): boolean {
  return d.enabled !== false;
}

/** Resolve a rule-condition value through the dim's normalize + alias, mirroring
 *  builder.ts `normalizeRuleValue`. Exclusion rows are dropped at BUILD time, so
 *  an alias edit that changes which rows a rule matches IS a shape change — the
 *  one carve-out to "aliases are query-time and free". */
function resolveRuleValue(value: string, dim: BuiltInDimension | TagDimension | undefined): string {
  if (dim === undefined) return value;
  return resolveAlias(normalizeTagValue(value, dim.normalize), dim.aliases);
}

function findDim(dimensionId: string, dims: DimensionsConfig): BuiltInDimension | TagDimension | undefined {
  const builtIn = dims.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) return builtIn;
  return dims.tags.find(t => tagDimColumn(t) === dimensionId);
}

export interface ShapeSignatureInput {
  readonly dimensions: DimensionsConfig;
  readonly costMetric: CostMetric;
  readonly costPerspective: CostPerspective;
  /** All exclusion rules; only enabled ones contribute to the signature. */
  readonly rules: readonly ExclusionRule[];
  /** Marketplace re-attribution. Rewrites the `service` column (and `cost` on
   *  the list metric) at BUILD time, so it changes stored bytes and must feed
   *  the signature. Disabled/absent contributes nothing (matches pre-feature). */
  readonly marketplaceAttribution?: MarketplaceAttributionConfig | undefined;
  /** Digest of org-accounts.json content — see {@link computeOrgAccountsDigest}. */
  readonly orgAccountsDigest: string;
  /** Columns the build probed in the user's Parquet. */
  readonly availableColumns: readonly string[];
}

/** The set of enabled dimension columns that form the rollup grain, sorted.
 *  Built-in dims contribute their output column (`field`); tag dims their
 *  `tagDimColumn`. This is what downstream routing compares a query's needed
 *  columns against. */
export function enabledGrainColumns(dims: DimensionsConfig): string[] {
  const cols = new Set<string>();
  for (const d of dims.builtIn) if (isEnabled(d)) cols.add(d.field);
  for (const t of dims.tags) if (isEnabled(t)) cols.add(tagDimColumn(t));
  return [...cols].sort((a, b) => a.localeCompare(b));
}

/** Digest over every input that changes the BYTES stored in a rollup partition.
 *  Excludes query-time concerns (value aliases, normalize, lagDays, labels,
 *  order, defaultFilterValues, display-name resolution) so editing those never
 *  forces a re-roll. */
/** Canonical, order-independent shape of the marketplace config for the digest.
 *  Null when it contributes no rewrite (disabled or no usable rules) so toggling
 *  it off yields the same signature as a pre-feature build. */
function marketplaceForSignature(
  cfg: MarketplaceAttributionConfig | undefined,
): { service: string; operations: string[] }[] | null {
  if (!cfg?.enabled) return null;
  const rules = cfg.rules
    .filter(r => r.service.length > 0 && r.operations.length > 0)
    .map(r => ({ service: r.service, operations: [...r.operations].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.service.localeCompare(b.service));
  return rules.length === 0 ? null : rules;
}

export function computeShapeSignature(input: ShapeSignatureInput): string {
  const { dimensions, costMetric, costPerspective, rules, orgAccountsDigest, availableColumns } = input;

  const builtinDims = dimensions.builtIn
    .filter(isEnabled)
    .map(d => ({ kind: 'builtin', name: d.name, field: d.field }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tagDims = dimensions.tags
    .filter(isEnabled)
    .map(t => ({
      kind: 'tag',
      column: tagDimColumn(t),
      tagName: t.tagName ?? null,
      accountTagFallback: t.accountTagFallback ?? null,
      missingValueTemplate: t.missingValueTemplate ?? null,
      pathSegment: t.pathSegment ?? null,
    }))
    .sort((a, b) => a.column.localeCompare(b.column));

  const exclusionRules = rules
    .filter(r => r.enabled)
    .map(r => ({
      conditions: r.conditions.map(c => ({
        dimensionId: c.dimensionId,
        values: [...c.values].map(v => resolveRuleValue(v, findDim(c.dimensionId, dimensions))).sort((a, b) => a.localeCompare(b)),
      })),
    }));
  // Order-independent: rules are a set, not a sequence.
  exclusionRules.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  // Omit the key entirely when it contributes nothing, so a disabled/absent
  // config hashes identically to a pre-feature build (no spurious re-roll);
  // only an active config shifts the signature.
  const marketplace = marketplaceForSignature(input.marketplaceAttribution);

  return sha256Hex(canonicalJson({
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    builtinDims,
    tagDims,
    costMetric,
    costPerspective,
    exclusionRules,
    // Exclusion clauses became NULL-safe (issue #451): partitions built under
    // the old semantics with ANY enabled rule may be missing untagged/NULL-dim
    // rows and must rebuild. With zero enabled rules no exclusion clause is
    // emitted at all, so those partitions are byte-identical across the fix —
    // omit the marker to keep their signature (and skip the rebuild), same
    // omit-when-inert pattern as marketplaceAttribution below.
    ...(exclusionRules.length === 0 ? {} : { exclusionSemantics: 2 }),
    ...(marketplace === null ? {} : { marketplaceAttribution: marketplace }),
    orgAccountsDigest,
    availableColumns: [...availableColumns].sort((a, b) => a.localeCompare(b)),
  }));
}

/** Normalized digest of org-accounts.json. Captures only the fields that feed
 *  the BAKED account-fallback tag projection (id, ouPath, tags) — NOT the
 *  account `name`, which is resolved post-query for display and updates
 *  immediately. Sorts accounts by id and tag keys so cosmetic JSON reordering
 *  or whitespace never spuriously invalidates the rollup. */
export function computeOrgAccountsDigest(rawJson: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return sha256Hex('invalid'); }
  const accounts = (parsed as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts)) return sha256Hex('empty');
  const normalized = accounts
    .map((a): { id: string; ouPath: string; tags: Record<string, string> } | null => {
      if (typeof a !== 'object' || a === null) return null;
      const rec = a as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' ? rec['id'] : '';
      const ouPath = typeof rec['ouPath'] === 'string' ? rec['ouPath'] : '';
      const tags: Record<string, string> = {};
      const t = rec['tags'];
      if (typeof t === 'object' && t !== null) {
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof v === 'string') tags[k] = v;
        }
      }
      return { id, ouPath, tags };
    })
    .filter((x): x is { id: string; ouPath: string; tags: Record<string, string> } => x !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256Hex(canonicalJson(normalized));
}
