import { beforeAll, describe, it, expect } from 'vitest';
import {
  TIERS,
  buildDailyProjection,
  buildTierSelect,
  createExporter,
  isGroupableType,
  loadConfig,
  normalizeTimestamp,
  parseTiers,
  periodFolder,
} from './export-focus.mjs';

/** The live FOCUS 1.2 export's schema, read from INFORMATION_SCHEMA of a real
 *  billing table (55 columns, `_PARTITIONTIME` excluded as hidden). Kept
 *  verbatim so a change to the classification rules has to face the actual
 *  shape it will meet in production rather than a convenient sample. */
const LIVE_COLUMNS = [
  ['AvailabilityZone', 'STRING'],
  ['BilledCost', 'NUMERIC'],
  ['BillingAccountId', 'STRING'],
  ['BillingCurrency', 'STRING'],
  ['BillingPeriodStart', 'TIMESTAMP'],
  ['BillingPeriodEnd', 'TIMESTAMP'],
  ['ChargeCategory', 'STRING'],
  ['ChargeClass', 'STRING'],
  ['ChargeDescription', 'STRING'],
  ['ChargePeriodStart', 'TIMESTAMP'],
  ['ChargePeriodEnd', 'TIMESTAMP'],
  ['ConsumedQuantity', 'NUMERIC'],
  ['ConsumedUnit', 'STRING'],
  ['ContractedCost', 'NUMERIC'],
  ['ContractedUnitPrice', 'NUMERIC'],
  ['ListCost', 'NUMERIC'],
  ['ListUnitPrice', 'NUMERIC'],
  ['PricingCategory', 'STRING'],
  ['PricingQuantity', 'NUMERIC'],
  ['PricingUnit', 'STRING'],
  ['ProviderName', 'STRING'],
  ['PublisherName', 'STRING'],
  ['RegionId', 'STRING'],
  ['RegionName', 'STRING'],
  ['ResourceId', 'STRING'],
  ['ResourceName', 'STRING'],
  ['ServiceName', 'STRING'],
  ['SkuId', 'STRING'],
  ['SkuPriceId', 'STRING'],
  ['SubAccountId', 'STRING'],
  ['SubAccountName', 'STRING'],
  ['x_Credits', 'ARRAY<STRUCT<Name STRING, Amount NUMERIC, FullName STRING, Id STRING, Type STRING>>'],
  ['x_CostType', 'STRING'],
  ['x_CurrencyConversionRate', 'FLOAT64'],
  ['x_ExportTime', 'TIMESTAMP'],
  ['x_Location', 'STRING'],
  ['x_Project', 'STRUCT<Id STRING, Number STRING, Name STRING, AncestryNumbers STRING, Ancestors ARRAY<STRUCT<ResourceName STRING, DisplayName STRING>>>'],
  ['x_ServiceId', 'STRING'],
  ['x_SystemLabels', 'ARRAY<STRUCT<Key STRING, Value STRING>>'],
  ['x_Labels', 'ARRAY<STRUCT<Key STRING, Value STRING>>'],
  ['x_ProjectLabels', 'ARRAY<STRUCT<Key STRING, Value STRING>>'],
  ['x_Tags', 'ARRAY<STRUCT<Key STRING, Value STRING, x_Inherited BOOL, x_Namespace STRING>>'],
  ['EffectiveCost', 'NUMERIC'],
  ['PricingCurrency', 'STRING'],
  ['PricingCurrencyContractedUnitPrice', 'NUMERIC'],
  ['PricingCurrencyEffectiveCost', 'NUMERIC'],
  ['PricingCurrencyListUnitPrice', 'NUMERIC'],
  ['BillingAccountType', 'STRING'],
  ['x_SubscriptionInstanceId', 'STRING'],
  ['x_PriceEffectivePriceDefault', 'NUMERIC'],
  ['x_PriceListPriceConsumptionModel', 'NUMERIC'],
  ['x_CostAtEffectivePriceDefault', 'NUMERIC'],
  ['x_CostAtListConsumptionModel', 'NUMERIC'],
  ['x_ConsumptionModelId', 'STRING'],
  ['x_ConsumptionModelDescription', 'STRING'],
].map(([name, dataType]) => ({ name, dataType }));

const TABLE = 'proj.dataset.gcp_billing_export_focus_XXXXXX';

/** The select-list entry for one column, by its trailing `AS \`name\`` (or the
 *  bare backticked name for a plain group key). */
function itemFor(select, name) {
  const found = select.find(s => s === `\`${name}\`` || s.endsWith(`AS \`${name}\``));
  if (found === undefined) throw new Error(`no select item for ${name}`);
  return found;
}

describe('parseTiers', () => {
  it('defaults to daily alone — hourly is ~24x the bytes and must be opted into', () => {
    expect(parseTiers(undefined)).toEqual(['daily']);
    expect(parseTiers('')).toEqual(['daily']);
    expect(parseTiers('   ')).toEqual(['daily']);
  });

  it('accepts either tier, and both', () => {
    expect(parseTiers('hourly')).toEqual(['hourly']);
    expect(parseTiers('daily,hourly')).toEqual(['daily', 'hourly']);
  });

  it('normalizes case, spacing, order and duplicates', () => {
    // Run order — and therefore the logs — must not depend on how the
    // environment variable happened to be typed.
    expect(parseTiers(' HOURLY , daily ,hourly')).toEqual(['daily', 'hourly']);
  });

  it('rejects an unknown tier rather than silently exporting nothing', () => {
    expect(() => parseTiers('monthly')).toThrow(/unknown tier/);
    expect(() => parseTiers('daily,montly')).toThrow(/"montly"/);
  });

  it('exposes the canonical tier list', () => {
    expect(TIERS).toEqual(['daily', 'hourly']);
  });
});

describe('periodFolder', () => {
  it('puts the tier between the prefix and the period, with a trailing slash', () => {
    // The trailing slash is load-bearing: it is used as a DELETE prefix, and
    // without it `billing_period=2026-1` would also match `2026-10`.
    expect(periodFolder('focus', 'daily', '2026-08')).toBe('focus/daily/billing_period=2026-08/');
    expect(periodFolder('a/b', 'hourly', '2026-12')).toBe('a/b/hourly/billing_period=2026-12/');
  });
});

describe('isGroupableType', () => {
  it('accepts scalars', () => {
    for (const t of ['STRING', 'NUMERIC', 'TIMESTAMP', 'FLOAT64', 'INT64', 'BOOL', 'DATE', 'BIGNUMERIC']) {
      expect(isGroupableType(t), t).toBe(true);
    }
  });

  it('rejects the types BigQuery cannot GROUP BY', () => {
    for (const t of ['ARRAY<STRUCT<Key STRING>>', 'STRUCT<Id STRING>', 'JSON', 'GEOGRAPHY']) {
      expect(isGroupableType(t), t).toBe(false);
    }
  });
});

describe('buildDailyProjection', () => {
  const { select, groupBy } = buildDailyProjection(LIVE_COLUMNS);

  it('projects every source column exactly once, in order', () => {
    // The two tiers must carry the same columns in the same order, or the
    // canonicalizer meets two different shapes for one provider.
    expect(select).toHaveLength(LIVE_COLUMNS.length);
    for (const { name } of LIVE_COLUMNS) expect(() => itemFor(select, name)).not.toThrow();
  });

  it('sums the additive cost and quantity measures', () => {
    for (const name of [
      'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost',
      'ConsumedQuantity', 'PricingQuantity', 'PricingCurrencyEffectiveCost',
      'x_CostAtEffectivePriceDefault', 'x_CostAtListConsumptionModel',
    ]) {
      expect(itemFor(select, name), name).toBe(`SUM(\`${name}\`) AS \`${name}\``);
    }
  });

  it('never sums a unit price or a conversion rate', () => {
    // Summing 24 hourly unit prices reports a rate 24x reality. These are
    // NUMERIC like the measures above, so only the explicit allow-list keeps
    // them apart — this is the test that fails if that list grows carelessly.
    for (const name of [
      'ContractedUnitPrice', 'ListUnitPrice',
      'PricingCurrencyContractedUnitPrice', 'PricingCurrencyListUnitPrice',
      'x_PriceEffectivePriceDefault', 'x_PriceListPriceConsumptionModel',
      'x_CurrencyConversionRate',
    ]) {
      expect(itemFor(select, name), name).toBe(`\`${name}\``);
    }
  });

  it('truncates the charge period to the day and derives the END from the START', () => {
    expect(itemFor(select, 'ChargePeriodStart'))
      .toBe('TIMESTAMP_TRUNC(`ChargePeriodStart`, DAY) AS `ChargePeriodStart`');
    // Truncating ChargePeriodEnd itself would put an hourly row ending at
    // 00:00 on the FOLLOWING day.
    expect(itemFor(select, 'ChargePeriodEnd'))
      .toBe('TIMESTAMP_ADD(TIMESTAMP_TRUNC(`ChargePeriodStart`, DAY), INTERVAL 1 DAY) AS `ChargePeriodEnd`');
  });

  it('takes the newest export time', () => {
    expect(itemFor(select, 'x_ExportTime')).toBe('MAX(`x_ExportTime`) AS `x_ExportTime`');
  });

  it('concatenates credits rather than picking one', () => {
    // x_Credits carries AMOUNTS. ANY_VALUE would keep one hour's credit while
    // EffectiveCost beside it summed all 24 — silently under-crediting the day.
    expect(itemFor(select, 'x_Credits')).toBe('ARRAY_CONCAT_AGG(`x_Credits`) AS `x_Credits`');
    expect(groupBy).not.toContain('TO_JSON_STRING(`x_Credits`)');
  });

  it('keeps repeated dimensions apart via a JSON group key', () => {
    for (const name of ['x_Labels', 'x_Tags', 'x_ProjectLabels', 'x_SystemLabels', 'x_Project']) {
      expect(itemFor(select, name), name).toBe(`ANY_VALUE(\`${name}\`) AS \`${name}\``);
      expect(groupBy, name).toContain(`TO_JSON_STRING(\`${name}\`)`);
    }
  });

  it('groups by ORDINAL, never by name', () => {
    // `GROUP BY ChargePeriodStart` binds to the underlying column rather than
    // the truncated alias of the same name — which would group by the hour and
    // make the "daily" tier a byte-for-byte copy of the hourly one.
    const ordinals = groupBy.filter(g => /^\d+$/.test(g));
    expect(ordinals.length).toBeGreaterThan(0);
    expect(groupBy).not.toContain('ChargePeriodStart');
    for (const g of groupBy) {
      expect(/^\d+$/.test(g) || g.startsWith('TO_JSON_STRING(')).toBe(true);
    }
    // Every ordinal points at a non-aggregated select item.
    for (const o of ordinals) {
      const item = select[Number(o) - 1];
      expect(item, `ordinal ${o}`).toBeDefined();
      expect(/^(SUM|MAX|ANY_VALUE|ARRAY_CONCAT_AGG)\(/.test(item), `ordinal ${o} -> ${item}`).toBe(false);
    }
  });

  it('accounts for every column as either a group key or an aggregate', () => {
    const aggregated = select.filter(s => /^(SUM|MAX|ANY_VALUE|ARRAY_CONCAT_AGG)\(/.test(s));
    const ordinals = groupBy.filter(g => /^\d+$/.test(g));
    expect(aggregated.length + ordinals.length).toBe(select.length);
    // Verified against the live table: 16 aggregated, 39 plain keys + 5 JSON keys.
    expect(aggregated).toHaveLength(16);
    expect(groupBy).toHaveLength(44);
  });

  it('treats an unrecognized column as a group key, which can only over-split', () => {
    // Drift safety: a new Preview-era column must never be summed by accident.
    // Splitting a day into more rows keeps totals exact; the reverse does not.
    const { select: s, groupBy: g } = buildDailyProjection([
      { name: 'ChargePeriodStart', dataType: 'TIMESTAMP' },
      { name: 'x_SomeNewColumn', dataType: 'NUMERIC' },
      { name: 'x_SomeNewRepeated', dataType: 'ARRAY<STRUCT<A STRING>>' },
    ]);
    expect(itemFor(s, 'x_SomeNewColumn')).toBe('`x_SomeNewColumn`');
    expect(itemFor(s, 'x_SomeNewRepeated')).toBe('ANY_VALUE(`x_SomeNewRepeated`) AS `x_SomeNewRepeated`');
    expect(g).toContain('TO_JSON_STRING(`x_SomeNewRepeated`)');
  });

  it('rejects a column name that is not a plain identifier', () => {
    // Names arrive from INFORMATION_SCHEMA and are interpolated into SQL.
    expect(() => buildDailyProjection([{ name: 'a` , (SELECT 1) AS `b', dataType: 'STRING' }]))
      .toThrow(/column_name/);
  });
});

describe('buildTierSelect', () => {
  it('passes the hourly tier through untouched', () => {
    const sql = buildTierSelect('hourly', TABLE, LIVE_COLUMNS);
    expect(sql).toContain('SELECT *');
    expect(sql).not.toContain('GROUP BY');
    expect(sql).toContain('WHERE DATE(BillingPeriodStart) = @period');
  });

  it('emits a grouped projection for the daily tier', () => {
    const sql = buildTierSelect('daily', TABLE, LIVE_COLUMNS);
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('SUM(`BilledCost`) AS `BilledCost`');
    expect(sql).toContain('WHERE DATE(BillingPeriodStart) = @period');
    expect(sql).not.toContain('SELECT *');
  });

  it('filters by period through a PARAMETER, never interpolation', () => {
    for (const tier of TIERS) {
      expect(buildTierSelect(tier, TABLE, LIVE_COLUMNS)).toContain('= @period');
    }
  });

  it('rejects an unknown tier', () => {
    expect(() => buildTierSelect('monthly', TABLE, LIVE_COLUMNS)).toThrow(/Unknown tier/);
  });
});

describe('loadConfig', () => {
  const BASE = {
    FOCUS_TABLE: 'proj.ds.tbl',
    STATE_TABLE: 'proj.state.export_state',
    BUCKET: 'my-bucket',
  };

  it('applies the documented defaults', () => {
    const cfg = loadConfig({ ...BASE });
    expect(cfg).toMatchObject({ prefix: 'focus', tiers: ['daily'], location: 'EU', dryRun: false });
  });

  it('strips surrounding slashes from the prefix', () => {
    // `periodFolder` joins with a single slash; a prefix of `/focus/` would
    // otherwise produce a `//` key that GCS treats as a distinct folder.
    expect(loadConfig({ ...BASE, PREFIX: '/focus/' }).prefix).toBe('focus');
  });

  it('requires the three identifying variables', () => {
    for (const missing of ['FOCUS_TABLE', 'STATE_TABLE', 'BUCKET']) {
      const env = { ...BASE };
      delete env[missing];
      expect(() => loadConfig(env), missing).toThrow(new RegExp(missing));
    }
  });

  it('rejects identifiers that are not in the expected form', () => {
    expect(() => loadConfig({ ...BASE, FOCUS_TABLE: 'proj.ds' })).toThrow(/FOCUS_TABLE/);
    expect(() => loadConfig({ ...BASE, BUCKET: 'gs://my-bucket' })).toThrow(/BUCKET/);
    expect(() => loadConfig({ ...BASE, PREFIX: 'a b' })).toThrow(/PREFIX/);
  });
});

/** A `bigquery.query()` stand-in whose responses are keyed by a fragment of
 *  the SQL, so a test can drive `pendingExports`'s three queries (source scan,
 *  state read, INFORMATION_SCHEMA) without a real project. Every SQL string
 *  passed is recorded, so a test can assert on the query text itself as well
 *  as on the JS-side attribution of whatever rows it returns — the two are
 *  independent bugs (the wrong `IFNULL` default vs. mis-keying the result). */
function fakeBigQuery(responses) {
  const queries = [];
  // Params are recorded alongside the SQL because the SQL alone cannot show
  // what a placeholder was BOUND to, and a silently unbound parameter is a
  // real failure mode of the client — see `temporalParam`.
  const calls = [];
  return {
    queries,
    calls,
    query: async ({ query: sql, params, types }) => {
      queries.push(sql);
      calls.push({ sql, params, types });
      for (const [marker, rows] of responses) {
        if (sql.includes(marker)) return [rows];
      }
      throw new Error(`fakeBigQuery: no response registered for query containing none of the markers.\nSQL: ${sql}`);
    },
  };
}

const CONFIG = {
  focusTable: 'proj.ds.tbl',
  stateTable: 'proj.state.export_state',
  bucketName: 'b',
  prefix: 'focus',
  tiers: ['daily', 'hourly'],
  location: 'EU',
  dryRun: true,
};

describe('pendingExports — watermark tier attribution', () => {
  it('reads a legacy tier-less watermark row as HOURLY, not daily', async () => {
    // `scheduled-query.sql` — the standalone script this job supersedes —
    // publishes only the hourly tier, so a watermark table it created holds
    // hourly progress under a NULL `tier` column. Misreading that row as the
    // daily tier's watermark would mark a closed month's daily export as
    // already done, permanently skipping it: a closed month gains no new
    // x_ExportTime, so nothing would ever trip a re-check.
    const bigquery = fakeBigQuery([
      ['FROM `proj.ds.tbl`', [
        { period_label: '2026-03', period_start: '2026-03-01', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
      ['FROM `proj.state.export_state`', [
        // `fakeBigQuery` stands in for the query result, not the SQL — so this
        // is the shape `IFNULL(tier, 'hourly')` produces for a pre-tier-split
        // row (a real NULL `tier` column), not the NULL itself.
        { period_start: '2026-03-01', tier: 'hourly', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
    ]);
    const { pendingExports } = createExporter(CONFIG, { bigquery });
    const pending = await pendingExports();

    // The legacy row satisfies the HOURLY watermark (already caught up) but
    // says nothing about daily — daily for 2026-03 must still be pending.
    expect(pending).toEqual([
      { tier: 'daily', periodLabel: '2026-03', periodStart: '2026-03-01', watermark: '2026-03-15T00:00:00.000000Z' },
    ]);

    // And the query text itself: `fakeBigQuery` never runs real SQL, so the
    // behavioural assertion above alone would not catch a regression back to
    // `IFNULL(tier, 'daily')` — it only proves the JS-side keying is correct
    // once the right tier value arrives. This proves the query asks for it.
    const stateQuery = bigquery.queries.find(q => q.includes('FROM `proj.state.export_state`'));
    expect(stateQuery).toContain(`IFNULL(tier, 'hourly')`);
  });

  it('treats an up-to-date daily watermark as caught up once tagged', async () => {
    const bigquery = fakeBigQuery([
      ['FROM `proj.ds.tbl`', [
        { period_label: '2026-03', period_start: '2026-03-01', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
      ['FROM `proj.state.export_state`', [
        { period_start: '2026-03-01', tier: 'daily', watermark: { value: '2026-03-15T00:00:00Z' } },
        { period_start: '2026-03-01', tier: 'hourly', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
    ]);
    const { pendingExports } = createExporter(CONFIG, { bigquery });
    expect(await pendingExports()).toEqual([]);
  });

  it('backfills a newly-added tier for a period the other tier already published', async () => {
    const bigquery = fakeBigQuery([
      ['FROM `proj.ds.tbl`', [
        { period_label: '2026-03', period_start: '2026-03-01', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
      ['FROM `proj.state.export_state`', [
        { period_start: '2026-03-01', tier: 'daily', watermark: { value: '2026-03-15T00:00:00Z' } },
      ]],
    ]);
    const { pendingExports } = createExporter(CONFIG, { bigquery });
    expect(await pendingExports()).toEqual([
      { tier: 'hourly', periodLabel: '2026-03', periodStart: '2026-03-01', watermark: '2026-03-15T00:00:00.000000Z' },
    ]);
  });
});

describe('scheduled-query.sql (standalone hourly-only exporter)', () => {
  it('keys BOTH the change-detection join and the MERGE on the hourly tier', async () => {
    // The shared export_state table also holds the Cloud Run job's daily rows.
    // The read-side join must filter to the hourly tier the same way the MERGE
    // does, or a lagging daily watermark re-exports the whole month every run
    // (and a doubly-stale period would ARRAY_AGG twice). This pins the SQL copy
    // to the keying the JS pendingExports path is already tested for above.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, 'scheduled-query.sql'), 'utf-8');

    // The LEFT JOIN that selects which periods to export.
    expect(sql).toMatch(/LEFT JOIN[\s\S]*?export_state[\s\S]*?ON[\s\S]*?IFNULL\(st\.tier, 'hourly'\) = 'hourly'/);
    // The MERGE that records progress — already tier-keyed; assert it stays so.
    expect(sql).toMatch(/ON st\.billing_period = s\.bp AND IFNULL\(st\.tier, 'hourly'\) = s\.tier/);
  });
});

describe('normalizeTimestamp', () => {
  it('truncates the nanosecond precision BigQuery returns but will not accept', () => {
    // The exact value a live run read back from `MAX(x_ExportTime)`, which
    // BigQuery then refused as a TIMESTAMP parameter.
    expect(normalizeTimestamp('2026-08-07T23:59:43.834613000Z')).toBe('2026-08-07T23:59:43.834613Z');
    expect(normalizeTimestamp('2026-08-07T23:59:43.999999999Z')).toBe('2026-08-07T23:59:43.999999Z');
  });

  it('PADS the short form the client emits on a whole millisecond', () => {
    // `BigQueryTimestamp` renders `new Date(...).toJSON()` — three digits —
    // whenever the sub-millisecond component is zero, and nine otherwise. Both
    // widths therefore come off the same column.
    expect(normalizeTimestamp('2026-08-07T23:59:43.834Z')).toBe('2026-08-07T23:59:43.834000Z');
    expect(normalizeTimestamp('2026-03-15T00:00:00Z')).toBe('2026-03-15T00:00:00.000000Z');
  });

  it('makes lexicographic order agree with chronological order', () => {
    // The whole point of fixed width. `pendingExports` compares watermarks as
    // STRINGS, and with mixed widths this pair inverts: the raw values give
    // `'…43.834613Z' <= '…43.834Z'` === true, because 'Z' (0x5A) sorts above
    // every digit — so a period that genuinely moved reads as already-seen and
    // is skipped while the run logs "nothing changed since the last run".
    const stored = normalizeTimestamp('2026-08-07T23:59:43.834Z');
    const later = normalizeTimestamp('2026-08-07T23:59:43.834613000Z');
    expect('2026-08-07T23:59:43.834613Z' <= '2026-08-07T23:59:43.834Z').toBe(true); // the bug
    expect(later <= stored).toBe(false); // fixed
  });

  it('leaves an unparseable value alone rather than corrupting it', () => {
    expect(normalizeTimestamp('not-a-timestamp')).toBe('not-a-timestamp');
  });
});

describe('DATE and TIMESTAMP parameter binding', () => {
  /** A live run against a real project bound `@period` and `@watermark` to
   *  NULL and nobody noticed, because the client drops the value of a
   *  temporal parameter passed as a bare string and reports nothing. The
   *  export then wrote a 0-row schema-only shard — `WHERE
   *  DATE(BillingPeriodStart) = @period` matched nothing — and only the
   *  watermark MERGE failed, on the NOT NULL `billing_period`.
   *
   *  Asserting on the SQL text cannot catch this: the SQL is identical either
   *  way. The binding is the whole bug, so the binding is what is asserted. */
  // The exporter is run ONCE and both tests assert on the same recording —
  // they describe one run, and running it twice only duplicates the work and
  // the reasoning.
  let calls;
  beforeAll(async () => {
    // Markers are matched by FIRST substring hit, so the specific statements
    // must precede the table names: `buildTierSelect` embeds
    // "FROM `proj.ds.tbl`" inside the EXPORT DATA body, which would otherwise
    // shadow the EXPORT DATA entry and serve it the source-scan rows.
    const bigquery = fakeBigQuery([
      ['CREATE TABLE IF NOT EXISTS', []],
      ['ALTER TABLE', []],
      ['EXPORT DATA', []],
      ['MERGE', []],
      ['INFORMATION_SCHEMA.COLUMNS', LIVE_COLUMNS.map(c => ({
        column_name: c.name,
        data_type: c.dataType,
      }))],
      ['FROM `proj.ds.tbl`', [
        // The nine-digit shape the client ACTUALLY emits, not a hand-tidied
        // one — otherwise `timestampValue`'s normalization is never exercised
        // and could be deleted with the suite still green.
        { period_label: '2026-03', period_start: '2026-03-01', watermark: { value: '2026-03-15T00:00:00.834613000Z' } },
      ]],
      ['FROM `proj.state.export_state`', []],
    ]);
    const storage = { bucket: () => ({ deleteFiles: async () => undefined }) };
    const { run } = createExporter(
      { ...CONFIG, tiers: ['daily'], dryRun: false },
      { bigquery, storage },
    );
    await run();
    calls = bigquery.calls;
  });

  it('binds the export period as a DATE the client will actually send', () => {
    const exportCall = calls.find(c => c.sql.includes('EXPORT DATA'));
    expect(exportCall, 'no EXPORT DATA query was issued').toBeDefined();

    expect(exportCall.types).toEqual({ period: 'DATE' });
    // The wrapper, NOT the bare string: `{ period: '2026-03-01' }` with
    // `types.period = 'DATE'` reaches BigQuery as a parameter carrying a type
    // and no value, and the WHERE clause silently matches zero rows.
    expect(exportCall.params).toEqual({ period: { value: '2026-03-01' } });
  });

  it('binds both temporal params of the watermark MERGE', () => {
    const merge = calls.find(c => c.sql.includes('MERGE'));
    expect(merge, 'no MERGE query was issued').toBeDefined();

    expect(merge.types).toEqual({ period: 'DATE', tier: 'STRING', watermark: 'TIMESTAMP' });
    expect(merge.params).toEqual({
      period: { value: '2026-03-01' },
      // STRING is the one type the client binds correctly from a bare string,
      // so `tier` stays unwrapped — and that asymmetry is the reason the bug
      // presented as "billing_period cannot be null" with a valid tier beside it.
      tier: 'daily',
      // Normalized on the way through `timestampValue`, proving the read-path
      // half of the fix runs — the nine-digit source value is what BigQuery
      // rejects as an unparseable parameter.
      watermark: { value: '2026-03-15T00:00:00.834613Z' },
    });
  });

  it('wraps by declared type, so a future DATETIME param cannot be missed', () => {
    // The wrapping lives in `query()` and is derived from the `types` map, not
    // remembered at each call site — which is what let the original bug in.
    const merge = calls.find(c => c.sql.includes('MERGE'));
    expect(merge.params.tier).toBe('daily');
    expect(merge.params.period).toEqual({ value: '2026-03-01' });
  });
});
