import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBInstance } from '@duckdb/node-api';

import { FIXTURE_GCP_PROVIDER_NAME } from './layout.js';
import { canonicalizeGcpPeriod } from '../sync/gcp-canonicalize.js';

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

/**
 * Write the second provider's tree, in the shape a real GCP sync leaves
 * behind: BigQuery's delivered Parquet put through the actual canonicalizer.
 *
 * Shared by BOTH fixture generators — the vitest global setup and
 * `generate.ts --generate`, which is what CI runs before the e2e shards. They
 * each write the same synthetic tree by different routes, so a GCP provider
 * added to only one of them exists locally and is missing in CI.
 *
 * Derives from the caller's `synthetic` table rather than generating fresh
 * rows, deliberately: the two providers then share accounts and tag values, so
 * a mixed-workspace query has something to get WRONG. Only the SHAPE is
 * GCP-specific — tz-aware timestamps, DECIMAL costs, repeated-struct tags,
 * `x_ServiceId`/`SkuId`, and no ServiceCategory / CommitmentDiscountStatus /
 * x_ServiceCode / x_Operation / SkuMeter at all.
 */
export async function writeGcpProvider(
  conn: Conn,
  syntheticDir: string,
  months: readonly string[],
): Promise<void> {
  await conn.run(`
    CREATE OR REPLACE TABLE gcp_bq AS SELECT
      ChargePeriodStart AT TIME ZONE 'UTC' AS ChargePeriodStart,
      -- A GCP project, derived from the AWS account so the two providers stay
      -- correlated without pretending to share an account namespace.
      'proj-' || right(SubAccountId, 3) AS SubAccountId,
      SubAccountName,
      CAST(BilledCost AS DECIMAL(38,9)) AS BilledCost,
      CAST(EffectiveCost AS DECIMAL(38,9)) AS EffectiveCost,
      CAST(ListCost AS DECIMAL(38,9)) AS ListCost,
      CAST(ContractedCost AS DECIMAL(38,9)) AS ContractedCost,
      -- Switched on x_ServiceCode, not ServiceName: the latter is the display
      -- name ("Amazon Elastic Compute Cloud"), so matching on it silently
      -- collapsed every row into the ELSE branch.
      CASE x_ServiceCode
        WHEN 'AmazonEC2' THEN 'Compute Engine'
        WHEN 'AmazonRDS' THEN 'Cloud SQL'
        WHEN 'AmazonS3' THEN 'Cloud Storage'
        WHEN 'AWSLambda' THEN 'Cloud Run Functions'
        WHEN 'AmazonDynamoDB' THEN 'Firestore'
        WHEN 'AmazonVPC' THEN 'Networking'
        WHEN 'AmazonCloudWatch' THEN 'Cloud Monitoring'
        ELSE 'Cloud Logging'
      END AS ServiceName,
      'europe-west1' AS RegionId,
      ResourceId,
      ChargeCategory,
      PricingCategory,
      ChargeDescription,
      CAST(ConsumedQuantity AS DECIMAL(38,9)) AS ConsumedQuantity,
      list_transform(map_entries(Tags), e -> struct_pack(
        "Key" := e.key, "Value" := e.value, x_Inherited := false)) AS x_Tags,
      CAST([] AS STRUCT("Key" VARCHAR, "Value" VARCHAR)[]) AS x_Labels,
      'compute.googleapis.com' AS x_ServiceId,
      SkuMeter AS SkuId,
      TIMESTAMPTZ '2026-03-01 04:00:00+00' AS x_ExportTime
    FROM synthetic`);

  for (const month of months) {
    const staging = join(syntheticDir, '.gcp-staging', month);
    await mkdir(staging, { recursive: true });
    // `::DATE` on a TIMESTAMPTZ resolves in the SESSION timezone — the exact
    // trap `gcp-canonicalize.ts` exists to close. Nothing pins TZ for the test
    // run, so partitioning that way made the committed fixture tree depend on
    // the generating machine: west of UTC every midnight-UTC row slid into the
    // previous month and vanished from both partitions. Compare in UTC.
    await conn.run(`COPY (
      SELECT * FROM gcp_bq
      WHERE strftime(ChargePeriodStart AT TIME ZONE 'UTC', '%Y-%m') = '${month}'
    ) TO '${join(staging, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);

    const outDir = join(syntheticDir, FIXTURE_GCP_PROVIDER_NAME, 'raw', `daily-${month}`);
    await mkdir(outDir, { recursive: true });
    await canonicalizeGcpPeriod({
      stagingDir: staging,
      outputPath: join(outDir, 'part-0.parquet'),
      connection: conn,
    });
  }
  await rm(join(syntheticDir, '.gcp-staging'), { recursive: true, force: true });
}
