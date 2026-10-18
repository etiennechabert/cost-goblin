import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  applyRegionFriendlyNames,
  buildAliasSqlCase,
  resolveAlias,
  type RegionEnrichment,
} from '../normalize/normalize.js';
import { asDimensionId } from '../types/branded.js';
import type { BuiltInDimension, DimensionsConfig } from '../types/config.js';

/**
 * The SSM global-infrastructure snapshot (or a peer's shared copy of it) is
 * folded into the Region-family built-ins as aliases, so `region`,
 * `region_country` and `region_continent` all group the same raw `region`
 * column differently. The snapshot can arrive from a peer's pack, whose
 * labels are free text, and the local region-names.json is read without a
 * code grammar, so labels and codes alike end up as SQL string literals.
 */

const REGION_MAP: ReadonlyMap<string, RegionEnrichment> = new Map([
  ['eu-central-1', { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' }],
  ['eu-west-1', { longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' }],
  ['us-east-1', { longName: 'US East (N. Virginia)', country: 'US', continent: 'NA' }],
  ['us-east-2', { longName: 'US East (Ohio)', country: 'US', continent: 'NA' }],
]);

function regionDim(over: Partial<BuiltInDimension> = {}): BuiltInDimension {
  return { name: asDimensionId('region'), label: 'Region', field: 'region', ...over };
}

const COUNTRY_DIM: BuiltInDimension = { name: asDimensionId('region_country'), label: 'Country', field: 'region' };
const CONTINENT_DIM: BuiltInDimension = { name: asDimensionId('region_continent'), label: 'Continent', field: 'region' };
const SERVICE_DIM: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };

function dimsOf(...builtIn: BuiltInDimension[]): DimensionsConfig {
  return { builtIn, tags: [] };
}

/** The single built-in of a one-dim result, or a failed test. */
function onlyDim(dims: DimensionsConfig): BuiltInDimension {
  const [dim] = dims.builtIn;
  if (dim === undefined || dims.builtIn.length !== 1) throw new Error('expected exactly one built-in dimension');
  return dim;
}

describe('applyRegionFriendlyNames', () => {
  it('returns the config itself when no SSM snapshot has been synced', () => {
    const dims = dimsOf(regionDim({ useRegionNames: true }), COUNTRY_DIM);
    expect(applyRegionFriendlyNames(dims, new Map())).toBe(dims);
  });

  it('maps each code to its long name on the region dim when useRegionNames is on', () => {
    const dim = onlyDim(applyRegionFriendlyNames(dimsOf(regionDim({ useRegionNames: true })), REGION_MAP));
    expect(dim.aliases).toEqual({
      'Europe (Frankfurt)': ['eu-central-1'],
      'Europe (Ireland)': ['eu-west-1'],
      'US East (N. Virginia)': ['us-east-1'],
      'US East (Ohio)': ['us-east-2'],
    });
    expect(resolveAlias('eu-central-1', dim.aliases)).toBe('Europe (Frankfurt)');
  });

  it('leaves the region dim on raw codes when useRegionNames is off or unset', () => {
    for (const dim of [regionDim(), regionDim({ useRegionNames: false })]) {
      expect(onlyDim(applyRegionFriendlyNames(dimsOf(dim), REGION_MAP))).toBe(dim);
    }
  });

  it('groups region_country by ISO country code, whatever useRegionNames says', () => {
    for (const useRegionNames of [undefined, false, true]) {
      const dim = onlyDim(applyRegionFriendlyNames(dimsOf({ ...COUNTRY_DIM, useRegionNames }), REGION_MAP));
      expect(dim.aliases).toEqual({ DE: ['eu-central-1'], IE: ['eu-west-1'], US: ['us-east-1', 'us-east-2'] });
    }
  });

  it('groups region_continent by AWS geo bucket', () => {
    const dim = onlyDim(applyRegionFriendlyNames(dimsOf(CONTINENT_DIM), REGION_MAP));
    expect(dim.aliases).toEqual({ EU: ['eu-central-1', 'eu-west-1'], NA: ['us-east-1', 'us-east-2'] });
    expect(resolveAlias('us-east-2', dim.aliases)).toBe('NA');
  });

  it('only rewrites dims built on the region column and keeps the rest of the config', () => {
    const notOnRegion: BuiltInDimension = { name: asDimensionId('region_country'), label: 'Location', field: 'location' };
    const dims: DimensionsConfig = {
      builtIn: [SERVICE_DIM, notOnRegion, regionDim({ useRegionNames: true })],
      tags: [{ tagName: 'team', label: 'Team' }],
      order: ['builtin:service', 'tag:team'],
    };
    const result = applyRegionFriendlyNames(dims, REGION_MAP);
    expect(result).not.toBe(dims);
    expect(result.builtIn[0]).toBe(SERVICE_DIM);
    expect(result.builtIn[1]).toBe(notOnRegion);
    expect(result.builtIn[2]?.aliases).toHaveProperty(['Europe (Ireland)'], ['eu-west-1']);
    expect(result.tags).toBe(dims.tags);
    expect(result.order).toBe(dims.order);
  });

  it('lets a user alias that already covers a code win over the SSM label', () => {
    const userAliases = { 'Frankfurt DC': Object.freeze(['eu-central-1']) };
    const dim = onlyDim(applyRegionFriendlyNames(dimsOf(regionDim({ useRegionNames: true, aliases: userAliases })), REGION_MAP));
    expect(dim.aliases).toEqual({
      'Frankfurt DC': ['eu-central-1'],
      'Europe (Ireland)': ['eu-west-1'],
      'US East (N. Virginia)': ['us-east-1'],
      'US East (Ohio)': ['us-east-2'],
    });
    expect(dim.aliases).not.toHaveProperty(['Europe (Frankfurt)']);
    expect(resolveAlias('eu-central-1', dim.aliases)).toBe('Frankfurt DC');
  });

  it('adds SSM codes to a user canonical of the same name without touching the user list', () => {
    // Frozen: a push into the caller's own array would throw in strict mode.
    const userList = Object.freeze(['dublin']);
    const dim = onlyDim(applyRegionFriendlyNames(
      dimsOf({ ...CONTINENT_DIM, aliases: { EU: userList } }),
      REGION_MAP,
    ));
    expect(dim.aliases).toEqual({ EU: ['dublin', 'eu-central-1', 'eu-west-1'], NA: ['us-east-1', 'us-east-2'] });
    expect(userList).toEqual(['dublin']);
  });

  it('leaves a code with no value for the requested field on its raw code', () => {
    const sparse: ReadonlyMap<string, RegionEnrichment> = new Map([
      ['eu-central-1', { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' }],
      ['xx-local-1', { longName: '', country: '', continent: 'EU' }],
    ]);
    const named = onlyDim(applyRegionFriendlyNames(dimsOf(regionDim({ useRegionNames: true })), sparse));
    expect(named.aliases).toEqual({ 'Europe (Frankfurt)': ['eu-central-1'] });
    expect(resolveAlias('xx-local-1', named.aliases)).toBe('xx-local-1');

    const country = onlyDim(applyRegionFriendlyNames(dimsOf(COUNTRY_DIM), sparse));
    expect(country.aliases).toEqual({ DE: ['eu-central-1'] });

    // The same code still has a continent, so that grouping does pick it up.
    const continent = onlyDim(applyRegionFriendlyNames(dimsOf(CONTINENT_DIM), sparse));
    expect(continent.aliases).toEqual({ EU: ['eu-central-1', 'xx-local-1'] });
  });
});

describe('region alias SQL from untrusted snapshot text (DuckDB execution)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    conn.closeSync();
    db.closeSync();
  });

  async function labelsFor(regionSql: string, codesSql: string): Promise<Record<string, unknown>[]> {
    const reader = await conn.runAndReadAll(
      `SELECT region, ${regionSql} AS label FROM (VALUES ${codesSql}) AS t(region) ORDER BY region`,
    );
    return reader.getRowObjectsJson();
  }

  it('escapes quotes in snapshot labels and codes, so they stay string literals', async () => {
    const hostileLabel = "Ireland (O'Brien)' OR 1=1 --";
    const hostileCode = "eu-o'brien-1";
    const regionMap: ReadonlyMap<string, RegionEnrichment> = new Map([
      [hostileCode, { longName: hostileLabel, country: "I'E", continent: 'EU' }],
      ['us-east-1', { longName: 'US East (N. Virginia)', country: 'US', continent: 'NA' }],
    ]);
    const named = onlyDim(applyRegionFriendlyNames(dimsOf(regionDim({ useRegionNames: true })), regionMap));
    const sql = buildAliasSqlCase('region', named);

    expect(sql).toContain("IN ('eu-o''brien-1') THEN 'Ireland (O''Brien)'' OR 1=1 --'");

    const rows = await labelsFor(sql, "('eu-o''brien-1'), ('us-east-1'), ('zz-unknown-1')");
    expect(rows).toEqual([
      { region: hostileCode, label: hostileLabel },
      { region: 'us-east-1', label: 'US East (N. Virginia)' },
      // A code the snapshot does not know keeps its raw value.
      { region: 'zz-unknown-1', label: 'zz-unknown-1' },
    ]);

    const country = onlyDim(applyRegionFriendlyNames(dimsOf(COUNTRY_DIM), regionMap));
    const countryRows = await labelsFor(buildAliasSqlCase('region', country), "('eu-o''brien-1'), ('us-east-1')");
    expect(countryRows).toEqual([
      { region: hostileCode, label: "I'E" },
      { region: 'us-east-1', label: 'US' },
    ]);
  });

  it('groups several codes under one continent in a single CASE arm', async () => {
    const continent = onlyDim(applyRegionFriendlyNames(dimsOf(CONTINENT_DIM), REGION_MAP));
    const sql = buildAliasSqlCase('region', continent);
    expect(sql).toBe(
      "CASE WHEN region IN ('eu-central-1', 'eu-west-1') THEN 'EU' WHEN region IN ('us-east-1', 'us-east-2') THEN 'NA' ELSE region END",
    );
    const rows = await labelsFor(sql, "('eu-west-1'), ('us-east-2'), ('ap-south-1')");
    expect(rows).toEqual([
      { region: 'ap-south-1', label: 'ap-south-1' },
      { region: 'eu-west-1', label: 'EU' },
      { region: 'us-east-2', label: 'NA' },
    ]);
  });
});
