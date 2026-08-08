/**
 * CostGoblin GCP FOCUS exporter — the Cloud Run job.
 *
 * Keeps a GCS bucket in step with the FOCUS 1.2 BigQuery billing export, in
 * the layout CostGoblin syncs from:
 *
 *   gs://<BUCKET>/<PREFIX>/<tier>/billing_period=YYYY-MM/shard-*.parquet
 *
 * Each run, per configured tier:
 *   1. finds the billing periods that gained rows since that tier last exported
 *   2. per period: DELETES the period's folder, then re-exports it
 *   3. advances that period's watermark
 *
 * Step 2's delete is the entire reason this is a deployed job rather than a
 * plain BigQuery scheduled query — everything else here could live in one.
 * `EXPORT DATA` shards its output across N files and chooses N itself; a
 * re-export producing FEWER shards than the previous run leaves the extras
 * behind. Nothing downstream can tell an orphaned shard from a live one — they
 * are the same shape, in the same folder — so they get read and counted
 * alongside the new data, and the month silently reads high. SQL cannot delete
 * GCS objects. This can.
 *
 * ## Tiers
 *
 * The GCP FOCUS export is delivered at HOURLY grain — every row spans exactly
 * 60 minutes. CostGoblin mirrors AWS, where you create one Data Export per
 * granularity and point a `sync.<tier>.bucket` at each; here one job produces
 * both grains from the single upstream table:
 *
 *   hourly  the source rows, untouched (`SELECT *`)
 *   daily   the same rows rolled up to one row per day per dimension tuple
 *
 * `daily` is the default because it is roughly 24x smaller, which is the whole
 * reason the tier split exists: you keep a year of daily and a fortnight of
 * hourly rather than a year of hourly.
 *
 * Plain ESM JavaScript on purpose: it runs in your container, not in
 * CostGoblin's toolchain, so there is no build step between what you read here
 * and what executes. The pure query-building helpers are exported and covered
 * by `export-focus.test.mjs`.
 *
 * Configuration — all via environment (see deploy.sh):
 *   FOCUS_TABLE     project.dataset.gcp_billing_export_focus_XXXXXX  (required)
 *   BUCKET          destination bucket name, no gs://                (required)
 *   PREFIX          key prefix inside the bucket        (default: focus)
 *   TIERS           comma list of daily,hourly          (default: daily)
 *   STATE_TABLE     project.dataset.table for watermarks             (required)
 *   BQ_LOCATION     dataset location, e.g. EU           (default: EU)
 *   DRY_RUN         "1" to log what would happen and change nothing
 */

import { fileURLToPath } from 'node:url';

// The two Google SDKs are imported lazily, inside `createExporter`, rather than
// at module scope. Everything above the runner is pure string-building, and
// keeping it importable WITHOUT the SDKs present is what lets the repo's test
// suite cover the generated SQL: `npm ci` at the repo root installs nothing
// from this directory, whose dependencies are resolved by the Dockerfile's own
// `npm install` at image build time.

// ---------------------------------------------------------------------------
// Configuration + validation
//
// Table names and the GCS uri are IDENTIFIERS: BigQuery has no parameter form
// for either, so they are interpolated and must be validated against a strict
// pattern first. Every VALUE (the period date, the watermark) goes through a
// query parameter instead.
// ---------------------------------------------------------------------------

/** project.dataset.table — each part letters/digits/underscores/dashes. */
const TABLE_REF = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._\-/]*$/;
const PERIOD_LABEL = /^\d{4}-(0[1-9]|1[0-2])$/;
/** BigQuery column identifiers. Applied to names read back from
 *  INFORMATION_SCHEMA before they are interpolated into generated SQL. */
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const TIERS = ['daily', 'hourly'];

function required(name, env) {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function checked(value, pattern, name) {
  if (!pattern.test(value)) {
    throw new Error(`${name} is not in the expected form: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Which grains to publish. Defaults to `daily` alone: hourly is ~24x the
 * bytes, and a user who has not asked for intraday detail should not pay to
 * store or download it.
 *
 * Order is normalized rather than preserved so the run order — and therefore
 * the logs — do not depend on how the variable happened to be typed.
 */
export function parseTiers(raw) {
  if (raw === undefined || raw.trim() === '') return ['daily'];
  const requested = new Set(raw.split(',').map(t => t.trim().toLowerCase()).filter(t => t !== ''));
  for (const tier of requested) {
    if (!TIERS.includes(tier)) {
      throw new Error(`TIERS contains an unknown tier ${JSON.stringify(tier)} — expected ${TIERS.join(' and/or ')}`);
    }
  }
  if (requested.size === 0) return ['daily'];
  return TIERS.filter(t => requested.has(t));
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    focusTable: checked(required('FOCUS_TABLE', env), TABLE_REF, 'FOCUS_TABLE'),
    stateTable: checked(required('STATE_TABLE', env), TABLE_REF, 'STATE_TABLE'),
    bucketName: checked(required('BUCKET', env), BUCKET_NAME, 'BUCKET'),
    prefix: checked(((env.PREFIX ?? '').trim() || 'focus').replace(/^\/+|\/+$/g, ''), PREFIX_PATTERN, 'PREFIX'),
    tiers: parseTiers(env.TIERS),
    // `||`, not `??`: container env vars are routinely SET BUT EMPTY, and an
    // empty BQ_LOCATION reaches every query as `location: ''` — an EU dataset
    // then fails with "not found in location US" and nothing points at the
    // blank variable. Same hazard for PREFIX, which would produce a leading
    // slash and an unnamed top-level GCS folder.
    location: (env.BQ_LOCATION ?? '').trim() || 'EU',
    dryRun: env.DRY_RUN === '1',
  });
}

/** Where one tier's period lands. The tier segment is what lets a single
 *  bucket serve both `sync.daily.bucket` and `sync.hourly.bucket`; CostGoblin
 *  only ever looks for `billing_period=YYYY-MM/` directly beneath whatever
 *  prefix it is pointed at. Trailing slash included: without it a delete
 *  prefix would also match sibling folders sharing the same leading
 *  characters. */
export function periodFolder(prefix, tier, periodLabel) {
  return `${prefix}/${tier}/billing_period=${periodLabel}/`;
}

// ---------------------------------------------------------------------------
// Daily rollup
//
// The upstream rows are hourly, so the daily tier is a GROUP BY: one row per
// day per dimension tuple. Which column is a dimension and which is a measure
// is decided from INFORMATION_SCHEMA at run time rather than a hardcoded
// column list, because the FOCUS export is still Preview and gains columns.
//
// Every classification below is chosen so that DRIFT DEGRADES SAFELY. An
// unrecognized column becomes a GROUP BY key, which can only ever split a day
// into more rows than strictly necessary — totals stay exact. The failure mode
// that must never happen is the opposite one: silently summing something that
// is not additive, or collapsing rows that differ.
// ---------------------------------------------------------------------------

/** Columns that ADD across the hours of a day.
 *
 *  Note what is deliberately absent: every `*UnitPrice`, `x_Price*` and
 *  `x_CurrencyConversionRate` column is a per-unit RATE, not a quantity.
 *  Summing 24 hourly unit prices would report a rate 24x reality. They fall
 *  through to the group-key branch instead, which is also the correct FOCUS
 *  semantics — a price change mid-day genuinely splits the day into two rows. */
const ADDITIVE_MEASURES = new Set([
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'ConsumedQuantity',
  'PricingQuantity',
  'PricingCurrencyEffectiveCost',
  'x_CostAtEffectivePriceDefault',
  'x_CostAtListConsumptionModel',
]);

/** Repeated columns whose STRUCTs carry AMOUNTS rather than dimensions.
 *
 *  These cannot take the group-key treatment the other arrays get: grouping on
 *  `TO_JSON_STRING(x_Credits)` merges 24 hourly rows that each carry a -$0.01
 *  credit into one row still carrying -$0.01, losing 23/24 of the credit while
 *  `EffectiveCost` beside it sums all 24. `ARRAY_CONCAT_AGG` keeps every entry
 *  instead — redundant, but lossless, and it needs no knowledge of the struct's
 *  fields. */
const ADDITIVE_ARRAYS = new Set(['x_Credits']);

const CHARGE_START = 'ChargePeriodStart';
const CHARGE_END = 'ChargePeriodEnd';
const EXPORT_TIME = 'x_ExportTime';

/** Whether BigQuery can GROUP BY a column of this type. ARRAY, STRUCT, JSON
 *  and GEOGRAPHY are not groupable, so those columns need a scalar stand-in
 *  as the group key. */
export function isGroupableType(dataType) {
  const type = dataType.trim().toUpperCase();
  if (type.startsWith('ARRAY<') || type.startsWith('STRUCT<')) return false;
  return type !== 'JSON' && type !== 'GEOGRAPHY';
}

/**
 * The SELECT list and GROUP BY for the daily rollup.
 *
 * `columns` is `[{ name, dataType }]` in the table's own ordinal order, so the
 * daily tier's Parquet carries the same columns in the same order as the
 * hourly tier's.
 *
 * GROUP BY entries are ORDINALS, not names. `GROUP BY ChargePeriodStart` would
 * bind to the underlying column rather than the truncated select-list alias of
 * the same name, silently grouping by the hour and producing a "daily" tier
 * identical to the hourly one.
 */
export function buildDailyProjection(columns) {
  const select = [];
  const groupOrdinals = [];
  const groupExprs = [];

  const emit = (expr) => {
    select.push(expr);
    return select.length;
  };

  for (const { name, dataType } of columns) {
    const col = `\`${checked(name, COLUMN_NAME, 'column_name')}\``;

    if (name === CHARGE_START) {
      groupOrdinals.push(emit(`TIMESTAMP_TRUNC(${col}, DAY) AS ${col}`));
    } else if (name === CHARGE_END) {
      // Derived from the START, not truncated from the end: an hourly row
      // ending at 00:00 the next day truncates to the WRONG day.
      groupOrdinals.push(emit(
        `TIMESTAMP_ADD(TIMESTAMP_TRUNC(\`${CHARGE_START}\`, DAY), INTERVAL 1 DAY) AS ${col}`,
      ));
    } else if (name === EXPORT_TIME) {
      // The watermark column: the newest contributing row wins, so a reader
      // comparing export times sees the day as at least as fresh as its rows.
      emit(`MAX(${col}) AS ${col}`);
    } else if (ADDITIVE_MEASURES.has(name)) {
      emit(`SUM(${col}) AS ${col}`);
    } else if (ADDITIVE_ARRAYS.has(name)) {
      emit(`ARRAY_CONCAT_AGG(${col}) AS ${col}`);
    } else if (isGroupableType(dataType)) {
      groupOrdinals.push(emit(col));
    } else {
      // A repeated dimension (labels, tags, the project struct). The JSON text
      // is the group key so rows with different labels stay separate; within a
      // group every row then holds the identical value, which makes ANY_VALUE
      // exact rather than arbitrary.
      emit(`ANY_VALUE(${col}) AS ${col}`);
      groupExprs.push(`TO_JSON_STRING(${col})`);
    }
  }

  return { select, groupBy: [...groupOrdinals.map(String), ...groupExprs] };
}

/**
 * The body of one tier's export.
 *
 * The hourly tier is `SELECT *` on purpose: CostGoblin canonicalizes the shape
 * locally, so there is no mapping SQL to maintain here and Preview-era column
 * additions flow through untouched.
 */
export function buildTierSelect(tier, focusTable, columns) {
  const from = `FROM \`${focusTable}\`\n     WHERE DATE(BillingPeriodStart) = @period`;
  if (tier === 'hourly') {
    return `SELECT *\n     ${from}`;
  }
  if (tier !== 'daily') {
    throw new Error(`Unknown tier ${JSON.stringify(tier)}`);
  }
  const { select, groupBy } = buildDailyProjection(columns);
  return `SELECT\n       ${select.join(',\n       ')}\n     ${from}\n     GROUP BY ${groupBy.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function log(message, extra) {
  // Cloud Logging picks up structured JSON on stdout.
  console.log(JSON.stringify({ severity: 'INFO', message, ...extra }));
}

/** BigQuery TIMESTAMPs round-trip ASYMMETRICALLY: a query RETURNS up to
 *  nanosecond precision (`2026-08-07T23:59:43.834613000Z`, nine fractional
 *  digits) but the query-parameter parser accepts at most microseconds, and
 *  rejects its own output with "Unparseable query parameter ... Invalid
 *  timestamp". Since the watermark's whole job is to be read from one query
 *  and fed back into the next, every value has to pass through here.
 *
 *  TRUNCATED, never rounded. Truncation can only move a watermark EARLIER,
 *  whose worst case is re-exporting a period that did not change — idempotent
 *  and cheap. Rounding up could move it PAST a row that has not been exported
 *  yet, and that row would never be picked up again: the table is append-only,
 *  so nothing later would re-trip the comparison. */
export function normalizeTimestamp(iso) {
  return iso.replace(/(\.\d{6})\d+/, '$1');
}

/** BigQuery returns TIMESTAMP as a wrapper object; unwrap to an ISO string.
 *
 *  Normalizing HERE rather than at the point of use keeps the two sides of
 *  `watermark <= seen` in one canonical form — that comparison is a string
 *  compare, so a nanosecond-precision source value against a microsecond
 *  stored one would compare longer-is-greater and re-export every run. */
function timestampValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return normalizeTimestamp(raw);
  if (typeof raw === 'object' && 'value' in raw && typeof raw.value === 'string') {
    return normalizeTimestamp(raw.value);
  }
  return String(raw);
}

/** Re-wrap a scalar for a DATE or TIMESTAMP query parameter.
 *
 *  The BigQuery Node client SILENTLY DROPS the value of a DATE or TIMESTAMP
 *  parameter handed to it as a plain string alongside an explicit type: the
 *  request goes out carrying a `parameterType` and NO `parameterValue`, and
 *  the server binds it as NULL. STRING parameters are unaffected, which is
 *  exactly how this hid — in the watermark MERGE, `@tier` arrived intact
 *  while `@period` and `@watermark` both went NULL.
 *
 *  Both consequences are silent rather than loud. `WHERE
 *  DATE(BillingPeriodStart) = @period` compares against NULL and matches
 *  nothing, so a run publishes a 0-row, schema-only shard over a period that
 *  had data — a bucket that looks exported and reads as zero cost. Only the
 *  MERGE fails outright, and then just because `billing_period` is NOT NULL.
 *
 *  The client accepts the `{ value }` shape its own `BigQuery.date()` and
 *  `BigQuery.timestamp()` helpers produce, so wrapping by hand fixes it while
 *  keeping this module importable WITHOUT the SDKs — which is what lets the
 *  test suite cover any of this (see the import note at the top). */
function temporalParam(value) {
  return { value };
}

export function createExporter(config, deps = {}) {
  const { focusTable, stateTable, bucketName, prefix, tiers, location, dryRun } = config;

  /** Resolved once, on first use. Injected clients skip the import entirely,
   *  so a test never needs the SDKs on disk. */
  let clients = null;
  async function getClients() {
    if (clients === null) {
      const bigquery = deps.bigquery ?? new (await import('@google-cloud/bigquery')).BigQuery();
      const storage = deps.storage ?? new (await import('@google-cloud/storage')).Storage();
      clients = { bigquery, storage };
    }
    return clients;
  }

  async function query(sql, params, types) {
    const { bigquery } = await getClients();
    const [rows] = await bigquery.query({
      query: sql,
      location,
      ...(params === undefined ? {} : { params }),
      ...(types === undefined ? {} : { types }),
    });
    return rows;
  }

  async function ensureStateTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS \`${stateTable}\` (
        billing_period DATE NOT NULL,
        tier STRING,
        watermark TIMESTAMP NOT NULL
      )`);
    // Migrates a watermark table written before the tier split. Nullable, and
    // read back through IFNULL(tier, 'hourly') below: `scheduled-query.sql`,
    // the standalone script this job supersedes, publishes only the hourly
    // tier — so a table it created holds hourly watermarks, not daily ones.
    // Defaulting to 'daily' here would have misread a closed month's hourly
    // progress as the daily tier's, permanently skipping that month's daily
    // export (a closed month gains no new x_ExportTime to trip the mismatch).
    await query(`ALTER TABLE \`${stateTable}\` ADD COLUMN IF NOT EXISTS tier STRING`);
  }

  /** The table's columns, in ordinal order, excluding pseudo-columns like
   *  `_PARTITIONTIME` — which INFORMATION_SCHEMA lists but `SELECT *` does
   *  not return, so projecting it would make the two tiers disagree. */
  async function fetchColumns() {
    const [project, dataset, table] = focusTable.split('.');
    const rows = await query(
      `SELECT column_name, data_type
       FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
       WHERE table_name = @table AND is_hidden = 'NO'
       ORDER BY ordinal_position`,
      { table },
      { table: 'STRING' },
    );
    return rows.map(r => ({ name: String(r.column_name), dataType: String(r.data_type) }));
  }

  /**
   * Per (period, tier), whether the source has rows newer than what that tier
   * last published.
   *
   * The billing export is append-only and `x_ExportTime` strictly increases, so
   * comparing each period's MAX(x_ExportTime) against the stored watermark
   * catches late corrections to ANY closed month — not just the current one —
   * and converges to an empty result once nothing is changing.
   *
   * Keyed by tier as well as period so that ADDING a tier backfills it: a
   * bucket that has been publishing daily for months starts hourly from the
   * beginning rather than waiting for the next upstream change.
   */
  async function pendingExports() {
    const source = await query(`
      SELECT
        FORMAT_DATE('%Y-%m', p) AS period_label,
        FORMAT_DATE('%Y-%m-%d', p) AS period_start,
        w AS watermark
      FROM (
        SELECT DATE(BillingPeriodStart) AS p, MAX(x_ExportTime) AS w
        FROM \`${focusTable}\`
        GROUP BY 1
      )
      ORDER BY p`);

    const state = await query(
      `SELECT FORMAT_DATE('%Y-%m-%d', billing_period) AS period_start,
              IFNULL(tier, 'hourly') AS tier,
              watermark
       FROM \`${stateTable}\``);
    const published = new Map(
      state.map(r => [`${String(r.period_start)} ${String(r.tier)}`, timestampValue(r.watermark)]),
    );

    const pending = [];
    for (const tier of tiers) {
      for (const row of source) {
        const watermark = timestampValue(row.watermark);
        if (watermark === null) continue;
        const periodStart = String(row.period_start);
        const seen = published.get(`${periodStart} ${tier}`);
        if (seen !== undefined && seen !== null && watermark <= seen) continue;
        pending.push({
          tier,
          periodLabel: checked(String(row.period_label), PERIOD_LABEL, 'period_label'),
          periodStart,
          watermark,
        });
      }
    }
    return pending;
  }

  /** Empty the period's folder so the re-export cannot leave orphaned shards. */
  async function clearPeriodFolder(tier, periodLabel) {
    const folder = periodFolder(prefix, tier, periodLabel);
    if (dryRun) {
      log('would delete', { folder });
      return;
    }
    const { storage } = await getClients();
    await storage.bucket(bucketName).deleteFiles({ prefix: folder, force: true });
  }

  async function exportPeriod(tier, periodLabel, periodStart, columns) {
    const uri = `gs://${bucketName}/${periodFolder(prefix, tier, periodLabel)}shard-*.parquet`;
    const body = buildTierSelect(tier, focusTable, columns);
    if (dryRun) {
      log('would export', { uri, periodStart, tier, sql: body });
      return;
    }
    // The period is a query PARAMETER; only the uri, which BigQuery cannot
    // parameterize, is interpolated — and it is built from a label already
    // matched against PERIOD_LABEL.
    await query(
      `EXPORT DATA OPTIONS(
         uri = '${uri}',
         format = 'PARQUET',
         compression = 'SNAPPY',
         overwrite = true
       ) AS
       ${body}`,
      { period: temporalParam(periodStart) },
      { period: 'DATE' },
    );
  }

  /**
   * Advance the watermark to the value we OBSERVED at the start of this run,
   * never to the current time: rows that landed while the export was running
   * would otherwise be marked as already-exported and never picked up.
   */
  async function advanceWatermark(tier, periodStart, watermark) {
    if (dryRun) {
      log('would advance watermark', { tier, periodStart, watermark });
      return;
    }
    await query(
      `MERGE \`${stateTable}\` st
       USING (SELECT @period AS bp, @tier AS tier, @watermark AS w) s
       ON st.billing_period = s.bp AND IFNULL(st.tier, 'daily') = s.tier
       WHEN MATCHED THEN UPDATE SET watermark = s.w, tier = s.tier
       WHEN NOT MATCHED THEN INSERT (billing_period, tier, watermark) VALUES (s.bp, s.tier, s.w)`,
      { period: temporalParam(periodStart), tier, watermark: temporalParam(watermark) },
      { period: 'DATE', tier: 'STRING', watermark: 'TIMESTAMP' },
    );
  }

  async function run() {
    log('starting', { focusTable, bucket: bucketName, prefix, tiers, location, dryRun });
    await ensureStateTable();

    const pending = await pendingExports();
    if (pending.length === 0) {
      log('nothing changed since the last run');
      return 0;
    }
    log('periods to export', {
      count: pending.length,
      periods: pending.map(p => `${p.tier}/${p.periodLabel}`),
    });

    // Only the daily tier needs the schema, and only to build its GROUP BY.
    const columns = pending.some(p => p.tier === 'daily') ? await fetchColumns() : [];

    for (const { tier, periodLabel, periodStart, watermark } of pending) {
      // Order is load-bearing: the watermark is the record of "this period is
      // published". Advancing it before the export succeeds would mark a period
      // done that never landed, and nothing would ever retry it.
      await clearPeriodFolder(tier, periodLabel);
      await exportPeriod(tier, periodLabel, periodStart, columns);
      await advanceWatermark(tier, periodStart, watermark);
      log('exported', { tier, periodLabel, watermark });
    }

    log('done', { exported: pending.length });
    return pending.length;
  }

  return { run, fetchColumns, pendingExports };
}

async function main() {
  await createExporter(loadConfig()).run();
}

// Guarded so the helpers above can be imported by the test suite without the
// job running (and without the required-env check firing).
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({
      severity: 'ERROR',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }));
    // Non-zero so Cloud Run marks the execution failed and Cloud Monitoring can
    // alert on it — a silently "successful" no-op export is the failure mode
    // that leaves you looking at stale cost data without knowing.
    process.exit(1);
  });
}
