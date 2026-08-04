# GCP FOCUS exporter

Feeds CostGoblin's GCP provider. Copies the **FOCUS 1.2 BigQuery billing
export** into a GCS bucket, one folder per billing period:

```
gs://<BUCKET>/<PREFIX>/billing_period=2026-07/shard-000000000000.parquet
                       billing_period=2026-08/shard-000000000000.parquet
```

CostGoblin lists that bucket, downloads the periods that changed, and
canonicalizes them locally into contract-valid FOCUS 1.2 Parquet.

This is **your** infrastructure, running in **your** project — CostGoblin never
holds credentials that can reach BigQuery. It reads the bucket, nothing else.

## Before you start

Enable the FOCUS export first, and do it today:

**Console → Billing → Billing export → BigQuery export → FOCUS usage cost.**

- Pick the **FOCUS** export, not the older FOCUS *view* over the detailed
  export — that one is FOCUS 1.0 and CostGoblin does not support it.
- The **Projects** field is only where the dataset lives. The export is
  configured per *billing account* and covers every project linked to it.
- Prefer **Multi-region** (EU or US). It backfills the current + previous
  month; a single region starts completely empty. The location is **immutable**
  afterwards, and your bucket has to match it.

Then create the bucket in the same location, Standard class, uniform access,
and **object versioning off** — the exporter rewrites period folders, so
versioning would retain every superseded shard forever:

```bash
gcloud storage buckets create gs://cost-goblin --location=EU --uniform-bucket-level-access
```

## Which variant

Both do the same job with the same change detection and produce the identical
layout. The only difference is that **SQL cannot delete GCS objects and a
program can** — which matters because `EXPORT DATA` chooses how many shards to
write, and that number is not stable between runs.

| | **A** — `scheduled-query.sql` | **B** — `deploy.sh` (Cloud Run job) |
|---|---|---|
| Setup | ~5 min, no infrastructure | ~15 min, container + job + scheduler |
| Per period | `EXPORT DATA` | **delete folder** → `EXPORT DATA` |
| Orphaned shards | possible | impossible |

**A re-export that produces fewer shards than the previous run leaves the
extras behind**, and nothing downstream can tell an orphan from a live shard —
same folder, same shape. They get counted alongside the new data and the month
silently reads high. That is the one failure this whole design is arranged
around, and it is why B exists.

Recommended: **start with A** to get data flowing (a first export cannot hit
the problem — there is nothing to orphan), **move to B before you trust the
numbers.** Switching costs nothing: same watermark table, same bucket, same
layout, so CostGoblin cannot tell which one wrote the files.

## Variant B

Edit the config block at the top of `deploy.sh` — at minimum `FOCUS_TABLE`,
`BUCKET` and `PROJECT_ID` — then:

```bash
cd scripts/gcp-focus-exporter
./deploy.sh
```

It enables the APIs, creates the watermark dataset and a service account,
grants the four roles it needs, builds and deploys the Cloud Run job, and wires
up a daily Cloud Scheduler trigger. Re-run it any time to pick up changes.

First run, watching the output:

```bash
gcloud run jobs execute costgoblin-focus-exporter --region=europe-west1 --wait
gcloud storage ls gs://cost-goblin/focus/
```

To see what it *would* do without touching anything, run it locally against
your own credentials:

```bash
gcloud auth application-default login
npm install
FOCUS_TABLE=... BUCKET=cost-goblin STATE_TABLE=... DRY_RUN=1 npm start
```

## How change detection works

A watermark table in your own project:

```
costgoblin_exporter.export_state(billing_period DATE, watermark TIMESTAMP)
```

Each run compares every period's `MAX(x_ExportTime)` against its stored
watermark and re-exports only the periods that moved. Because the billing table
is append-only and `x_ExportTime` strictly increases, this catches late
corrections to **any** closed month, not just the current one — and converges
to a no-op once nothing is changing, which is also what keeps the BigQuery
query cost bounded.

The watermark advances to the **observed** maximum, never to wall-clock now.
Advancing to "now" would mark rows that landed mid-run as already exported, and
they would never be picked up again.

## Cost

Enabling the export is free, and the Google-managed billing table has no
storage charge. The recurring cost is **BigQuery bytes scanned** by
`EXPORT DATA ... SELECT *`, billed on-demand. Measure it before committing:

```bash
bq query --use_legacy_sql=false --dry_run --format=prettyjson \
  'SELECT * FROM `PROJECT.DATASET.FOCUS_TABLE` WHERE DATE(BillingPeriodStart) = DATE "2026-07-01"'
```

Take `totalBytesProcessed` × ~30 runs/month ÷ 2^40 × your per-TiB rate. A 1 GB
month is a few cents; the first 1 TiB scanned each month is free. If it comes
back large, drop the schedule to a few times a week — closed months look after
themselves via the watermark.

GCS storage is pennies. Cloud Run and Cloud Scheduler are effectively free at
one short run per day.

## Troubleshooting

**CostGoblin shows an empty bucket, with no error.** The period folders are
almost certainly not lowercase. `billing_period=2026-07` is matched
case-sensitively, deliberately, so that a leftover uppercase `BILLING_PERIOD=`
CUR-era tree in the same bucket stays invisible. Check with
`gcloud storage ls gs://<BUCKET>/<PREFIX>/`.

**`Not found: Dataset` or a location error.** The billing export dataset, the
watermark dataset, and the bucket must all be in the same location, and the
BigQuery job must run there too. `LOCATION` in `deploy.sh` and the scheduled
query's processing location both have to match.

**A month's totals look too high.** Orphaned shards — see the variant table
above. Check the folder's shard numbering for gaps at the top, delete the
folder, and re-export:

```bash
gcloud storage rm --recursive gs://<BUCKET>/<PREFIX>/billing_period=YYYY-MM/
```

**Permission denied deleting objects.** The service account needs
`roles/storage.objectAdmin`, not `objectCreator` — deletion is the point.
