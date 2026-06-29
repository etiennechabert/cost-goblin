/**
 * Shared fixture wiring for the query fuzzer: the dimensions config the cases
 * are generated and validated against, plus helpers to locate the synthetic
 * Parquet data. Mirrors the config used by the DuckDB integration tests so the
 * fuzzer exercises the same allow-list the production handlers resolve against.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asDimensionId, tagDimColumn } from '../types/branded.js';
import type { DimensionId } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Root of the committed synthetic fixture data ({dir}/aws/raw/{tier}-{period}). */
export const SYNTHETIC_DIR = join(here, '..', '__fixtures__', 'synthetic');

export const DIMENSIONS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab', aliases: { 'core-banking': ['core_banking', 'corebanking'] } },
    { tagName: 'environment', label: 'Environment', concept: 'environment', normalize: 'lowercase', aliases: { production: ['prod', 'prd'] } },
  ],
};

/** Dimension ids `resolveField` accepts — derived from DIMENSIONS so adding a
 *  built-in or tag dimension automatically extends fuzz coverage (no manual
 *  list to drift out of sync). */
export const VALID_DIMENSION_IDS: readonly DimensionId[] = [
  ...DIMENSIONS.builtIn.map(d => d.name),
  ...DIMENSIONS.tags.map(t => asDimensionId(tagDimColumn(t))),
];

const periodsCache = new Map<string, readonly string[]>();

/** Periods present on disk for a tier, e.g. ['2026-01', '2026-02'] for daily.
 *  Memoized — the committed fixtures are immutable within a run, so a soak of
 *  N cases shouldn't do N readdir syscalls. */
export function periodsOnDisk(tier: 'daily' | 'hourly'): readonly string[] {
  const cached = periodsCache.get(tier);
  if (cached !== undefined) return cached;
  const root = join(SYNTHETIC_DIR, 'aws', 'raw');
  const prefix = `${tier}-`;
  const periods = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(prefix))
    .map(e => e.name.slice(prefix.length))
    .sort();
  periodsCache.set(tier, periods);
  return periods;
}
