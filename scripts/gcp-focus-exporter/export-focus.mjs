/**
 * CostGoblin GCP FOCUS exporter — the Cloud Run job.
 *
 * Keeps a GCS bucket in step with the FOCUS 1.2 BigQuery billing export, in
 * the layout CostGoblin syncs from:
 *
 *   gs://<BUCKET>/<PREFIX>/billing_period=YYYY-MM/shard-*.parquet
 *
 * Each run:
 *   1. finds the billing periods that gained rows since the last export
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
 * Plain ESM JavaScript on purpose: it runs in your container, not in
 * CostGoblin's toolchain, so there is no build step between what you read here
 * and what executes.
 *
 * Configuration — all via environment (see deploy.sh):
 *   FOCUS_TABLE     project.dataset.gcp_billing_export_focus_XXXXXX  (required)
 *   BUCKET          destination bucket name, no gs://                (required)
 *   PREFIX          key prefix inside the bucket        (default: focus)
 *   STATE_TABLE     project.dataset.table for watermarks             (required)
 *   BQ_LOCATION     dataset location, e.g. EU           (default: EU)
 *   DRY_RUN         "1" to log what would happen and change nothing
 */

import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';

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

function required(name) {
  const value = process.env[name];
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

const focusTable = checked(required('FOCUS_TABLE'), TABLE_REF, 'FOCUS_TABLE');
const stateTable = checked(required('STATE_TABLE'), TABLE_REF, 'STATE_TABLE');
const bucketName = checked(required('BUCKET'), BUCKET_NAME, 'BUCKET');
const prefix = checked((process.env.PREFIX ?? 'focus').replace(/^\/+|\/+$/g, ''), PREFIX_PATTERN, 'PREFIX');
const location = process.env.BQ_LOCATION ?? 'EU';
const dryRun = process.env.DRY_RUN === '1';

const bigquery = new BigQuery();
const storage = new Storage();

function log(message, extra) {
  // Cloud Logging picks up structured JSON on stdout.
  console.log(JSON.stringify({ severity: 'INFO', message, ...extra }));
}

async function query(sql, params, types) {
  const [rows] = await bigquery.query({
    query: sql,
    location,
    ...(params === undefined ? {} : { params }),
    ...(types === undefined ? {} : { types }),
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function ensureStateTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS \`${stateTable}\` (
      billing_period DATE NOT NULL,
      watermark TIMESTAMP NOT NULL
    )`);
}

/**
 * Periods that gained rows since we last exported them.
 *
 * The billing export is append-only and `x_ExportTime` strictly increases, so
 * comparing each period's MAX(x_ExportTime) against the stored watermark
 * catches late corrections to ANY closed month — not just the current one —
 * and converges to an empty result once nothing is changing.
 */
async function changedPeriods() {
  return query(`
    SELECT
      FORMAT_DATE('%Y-%m', src.p) AS period_label,
      FORMAT_DATE('%Y-%m-%d', src.p) AS period_start,
      src.w AS watermark
    FROM (
      SELECT DATE(BillingPeriodStart) AS p, MAX(x_ExportTime) AS w
      FROM \`${focusTable}\`
      GROUP BY 1
    ) src
    LEFT JOIN \`${stateTable}\` st ON st.billing_period = src.p
    WHERE st.watermark IS NULL OR src.w > st.watermark
    ORDER BY src.p`);
}

/** Empty the period's folder so the re-export cannot leave orphaned shards. */
async function clearPeriodFolder(periodLabel) {
  // Trailing slash matters: without it the prefix would also match sibling
  // folders that merely start with the same characters.
  const folder = `${prefix}/billing_period=${periodLabel}/`;
  if (dryRun) {
    log('would delete', { folder });
    return;
  }
  await storage.bucket(bucketName).deleteFiles({ prefix: folder, force: true });
}

async function exportPeriod(periodLabel, periodStart) {
  const uri = `gs://${bucketName}/${prefix}/billing_period=${periodLabel}/shard-*.parquet`;
  if (dryRun) {
    log('would export', { uri, periodStart });
    return;
  }
  // `SELECT *` is deliberate: CostGoblin canonicalizes the shape locally, so
  // you never maintain mapping SQL here and Preview-era column additions flow
  // through untouched. The period is a query PARAMETER; only the uri, which
  // BigQuery cannot parameterize, is interpolated — and it is built from a
  // label already matched against PERIOD_LABEL.
  await query(
    `EXPORT DATA OPTIONS(
       uri = '${uri}',
       format = 'PARQUET',
       compression = 'SNAPPY',
       overwrite = true
     ) AS
     SELECT * FROM \`${focusTable}\`
     WHERE DATE(BillingPeriodStart) = @period`,
    { period: periodStart },
    { period: 'DATE' },
  );
}

/**
 * Advance the watermark to the value we OBSERVED at the start of this run,
 * never to the current time: rows that landed while the export was running
 * would otherwise be marked as already-exported and never picked up.
 */
async function advanceWatermark(periodStart, watermark) {
  if (dryRun) {
    log('would advance watermark', { periodStart, watermark });
    return;
  }
  await query(
    `MERGE \`${stateTable}\` st
     USING (SELECT @period AS bp, @watermark AS w) s
     ON st.billing_period = s.bp
     WHEN MATCHED THEN UPDATE SET watermark = s.w
     WHEN NOT MATCHED THEN INSERT (billing_period, watermark) VALUES (s.bp, s.w)`,
    { period: periodStart, watermark },
    { period: 'DATE', watermark: 'TIMESTAMP' },
  );
}

/** BigQuery returns TIMESTAMP as a wrapper object; unwrap to an ISO string. */
function timestampValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && 'value' in raw && typeof raw.value === 'string') return raw.value;
  return String(raw);
}

async function main() {
  log('starting', { focusTable, bucket: bucketName, prefix, location, dryRun });
  await ensureStateTable();

  const periods = await changedPeriods();
  if (periods.length === 0) {
    log('nothing changed since the last run');
    return;
  }
  log('periods to export', { count: periods.length, periods: periods.map(p => p.period_label) });

  for (const row of periods) {
    const periodLabel = checked(String(row.period_label), PERIOD_LABEL, 'period_label');
    const periodStart = String(row.period_start);
    const watermark = timestampValue(row.watermark);
    if (watermark === null) {
      log('skipping period with no export timestamp', { periodLabel });
      continue;
    }

    // Order is load-bearing: the watermark is the record of "this period is
    // published". Advancing it before the export succeeds would mark a period
    // done that never landed, and nothing would ever retry it.
    await clearPeriodFolder(periodLabel);
    await exportPeriod(periodLabel, periodStart);
    await advanceWatermark(periodStart, watermark);
    log('exported', { periodLabel, watermark });
  }

  log('done', { exported: periods.length });
}

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
