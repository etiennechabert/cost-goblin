-- CostGoblin GCP FOCUS exporter — the export, as a standalone BigQuery script.
--
-- Same change detection and export as the deployed Cloud Run job's HOURLY tier,
-- runnable by hand. Useful for a first look at the data before you deploy
-- anything.
--
-- Hourly only: the daily tier is a rollup whose GROUP BY is generated from
-- INFORMATION_SCHEMA at run time, because the FOCUS export is Preview and gains
-- columns. Reproducing that here would mean maintaining a second copy of the
-- generator that has to stay in step with the first. Point sync.daily.bucket at
-- this folder if you only want a look; it queries fine, just at hourly grain.
--
-- THIS IS NOT A COMPLETE SETUP. `EXPORT DATA` shards its output across N files
-- and BigQuery chooses N; N is not stable between runs. A re-export that packs
-- into fewer files leaves the previous run's extra files behind, and nothing
-- downstream can tell an orphan from a live shard — so the month silently reads
-- high. Removing them requires deleting GCS objects, which SQL cannot do. That
-- is the one thing the deployed job adds, and the reason it exists:
--
--   cd scripts/gcp-focus-exporter && ./deploy.sh
--
-- If you do run this on a schedule anyway, clean up by hand whenever a period
-- gets re-exported:
--
--   gcloud storage rm --recursive gs://<BUCKET>/<PREFIX>/hourly/billing_period=YYYY-MM/
--
-- SETUP
--   1. Run the CREATE TABLE below once, in your billing project.
--   2. BigQuery -> Scheduled queries -> Create, paste everything under
--      "RECURRING", set a daily schedule, and set the processing location to
--      the billing export's location (EU / US — it must match).
--   3. Replace «FOCUS_TABLE», «BUCKET» and «PREFIX» throughout.

-- ===========================================================================
-- ONE-TIME
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS costgoblin_exporter;

-- `tier` is nullable to match the column the Cloud Run job adds via
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS tier STRING`, so the two can share
-- this table in either creation order. A NULL here is read as 'hourly' by both
-- (this script publishes only that tier); see the MERGE below.
CREATE TABLE IF NOT EXISTS costgoblin_exporter.export_state (
  billing_period DATE NOT NULL,
  tier STRING,
  watermark TIMESTAMP NOT NULL
);

-- ===========================================================================
-- RECURRING — this is the scheduled query body
-- ===========================================================================

DECLARE periods ARRAY<STRUCT<billing_period DATE, watermark TIMESTAMP>>;
DECLARE i INT64 DEFAULT 0;

-- Periods that gained rows since we last exported them. The billing export is
-- append-only and x_ExportTime strictly increases, so this catches late
-- corrections to ANY closed month — not just the current one — and settles to
-- an empty array once nothing is changing.
SET periods = (
  SELECT ARRAY_AGG(STRUCT(src.p AS billing_period, src.w AS watermark))
  FROM (
    SELECT DATE(BillingPeriodStart) AS p, MAX(x_ExportTime) AS w
    FROM `«FOCUS_TABLE»`
    GROUP BY 1
  ) src
  LEFT JOIN costgoblin_exporter.export_state st ON st.billing_period = src.p
  WHERE st.watermark IS NULL OR src.w > st.watermark
);

WHILE i < ARRAY_LENGTH(periods) DO
  -- EXPORT DATA's `uri` must be a constant, so a per-period path needs
  -- EXECUTE IMMEDIATE. The folder MUST be lowercase `billing_period=` —
  -- CostGoblin matches it case-sensitively on purpose, so that a leftover
  -- uppercase CUR-era tree in the same bucket stays invisible. Get this wrong
  -- and the app reports an empty bucket with no error.
  --
  -- `SELECT *` is deliberate: CostGoblin canonicalizes the shape locally, so
  -- you never maintain mapping SQL here, and Preview-era column additions flow
  -- through untouched.
  EXECUTE IMMEDIATE FORMAT("""
    EXPORT DATA OPTIONS(
      uri = 'gs://«BUCKET»/«PREFIX»/hourly/billing_period=%s/shard-*.parquet',
      format = 'PARQUET',
      compression = 'SNAPPY',
      overwrite = true
    ) AS
    SELECT * FROM `«FOCUS_TABLE»`
    WHERE DATE(BillingPeriodStart) = DATE '%s'
  """,
  FORMAT_DATE('%Y-%m', periods[OFFSET(i)].billing_period),
  FORMAT_DATE('%Y-%m-%d', periods[OFFSET(i)].billing_period));

  -- Advance to the OBSERVED max, never to CURRENT_TIMESTAMP(): rows landing
  -- while the export runs would otherwise be marked exported and never
  -- picked up again.
  --
  -- KEYED BY TIER, even though this script only ever publishes hourly. By
  -- default it shares `costgoblin_exporter.export_state` with the deployed
  -- Cloud Run job, and without the tier predicate `ON st.billing_period =
  -- s.bp` matches the job's DAILY row too — stamping it with an hourly
  -- watermark, after which the job sees daily as caught up and silently stops
  -- exporting that tier. Writing the tier explicitly also stops the job's
  -- `IFNULL(tier, 'hourly')` from having to guess at rows this script wrote.
  MERGE costgoblin_exporter.export_state st
  USING (
    SELECT periods[OFFSET(i)].billing_period AS bp,
           periods[OFFSET(i)].watermark AS w,
           'hourly' AS tier
  ) s
  ON st.billing_period = s.bp AND IFNULL(st.tier, 'hourly') = s.tier
  WHEN MATCHED AND s.w > st.watermark THEN UPDATE SET watermark = s.w, tier = s.tier
  WHEN NOT MATCHED THEN INSERT (billing_period, tier, watermark) VALUES (s.bp, s.tier, s.w);

  SET i = i + 1;
END WHILE;
