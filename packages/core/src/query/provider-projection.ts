import type { ProviderType } from '../types/config.js';

/** How `buildSource` reads each provider's raw files where the providers'
 *  FOCUS exports disagree. The quirks are fixed at read time, once, so every
 *  query path, the rollup and the MCP tools see one value per meaning, and a
 *  mixed workspace groups the two providers' rows together. */

/** Bump a provider's entry when its projection below changes a value a rollup
 *  partition stores. The rollup shape signature records it, so that
 *  provider's rollups rebuild and no other provider's do. 0 adds nothing to
 *  the signature: a provider still at 0 keeps the one it had before revisions
 *  existed.
 *  gcp 1: region falls back to x_Location; pricing_category takes FOCUS's
 *  casing. */
export const SOURCE_PROJECTION_REVISION: Readonly<Record<ProviderType, number>> = {
  aws: 0,
  gcp: 1,
};

/** Columns the projection reads that a provider's files may lack. A column
 *  absent from every file of a glob is a binder error, not a NULL fill, and
 *  the GCP canonicalizer guarantees only the FOCUS contract columns:
 *  x_Location reaches the files because it passes every export column
 *  through, so an export without one has none. */
const OPTIONAL_SOURCE_COLUMNS: Readonly<Record<ProviderType, readonly string[]>> = {
  aws: [],
  gcp: ['x_Location'],
};

/** `read` (a `read_parquet(...)` call) widened with the provider's optional
 *  columns: a union BY NAME with an empty row that has them, so a file
 *  without one reads NULL. DuckDB prunes the unused columns through the
 *  union as it does for the bare read. */
export function withOptionalSourceColumns(read: string, type: ProviderType): string {
  const columns = OPTIONAL_SOURCE_COLUMNS[type];
  if (columns.length === 0) return read;
  const nulls = columns.map(c => `CAST(NULL AS VARCHAR) AS ${c}`).join(', ');
  return `(SELECT * FROM ${read} UNION ALL BY NAME SELECT ${nulls} WHERE FALSE)`;
}

/** FOCUS's PricingCategory values, in the spec's casing. */
const FOCUS_PRICING_CATEGORIES: readonly string[] = ['Standard', 'Dynamic', 'Committed', 'Other'];

/** PricingCategory read case-insensitively and written in FOCUS's casing.
 *  Google's export writes 'standard' where its documentation and the spec say
 *  'Standard', which AWS writes: one category would show as two values. A
 *  value FOCUS doesn't define passes through. */
function specCasedPricingCategory(prefix: string): string {
  const arms = FOCUS_PRICING_CATEGORIES.map(v => `WHEN '${v.toLowerCase()}' THEN '${v}'`).join(' ');
  return `CASE lower(${prefix}PricingCategory) ${arms} ELSE COALESCE(${prefix}PricingCategory, '') END`;
}

/** The SQL behind the source columns whose raw column differs by provider.
 *  `prefix` qualifies the raw columns ('src.' under the org-accounts join). */
export interface ProviderColumnExprs {
  readonly region: string;
  readonly pricingCategory: string;
}

export function providerColumnExprs(type: ProviderType, prefix: string): ProviderColumnExprs {
  switch (type) {
    case 'aws':
      return {
        region: `COALESCE(${prefix}RegionId, '')`,
        pricingCategory: `COALESCE(${prefix}PricingCategory, '')`,
      };
    case 'gcp':
      return {
        // Google leaves RegionId empty on multi-region and global charges
        // (BigQuery's US multi-region, Vertex AI's global endpoint) and names
        // the location in x_Location: 'us', 'europe', 'global'. Marketplace
        // rows have neither and stay ''.
        region: `COALESCE(NULLIF(${prefix}RegionId, ''), ${prefix}x_Location, '')`,
        pricingCategory: specCasedPricingCategory(prefix),
      };
  }
}
