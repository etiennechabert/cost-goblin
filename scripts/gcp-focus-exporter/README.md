# GCP FOCUS exporter

Feeds CostGoblin's GCP provider. Copies the **FOCUS 1.2 BigQuery billing
export** into a GCS bucket, one folder per tier per billing period:

```
gs://<BUCKET>/<PREFIX>/daily/billing_period=2026-07/shard-000000000000.parquet
                             billing_period=2026-08/shard-000000000000.parquet
gs://<BUCKET>/<PREFIX>/hourly/billing_period=2026-08/shard-000000000000.parquet
```

CostGoblin lists those folders, downloads the periods that changed, and
canonicalizes them locally into contract-valid FOCUS 1.2 Parquet.

**Two grains, one upstream table.** The FOCUS export is delivered at **hourly**
grain — every row spans exactly 60 minutes. AWS users create one Data Export per
granularity; here one job produces both from the single billing table:

| Tier | What it holds | Typical size |
|---|---|---|
| `daily` | one row per day per dimension tuple, measures summed | ~24x smaller |
| `hourly` | the source rows, untouched | the full export |

`daily` is exported by default. Set `TIERS=daily,hourly` to publish both — and
only then, since hourly is what makes a billing export large. Point
`sync.daily.bucket` and `sync.hourly.bucket` at the matching folders, exactly as
an AWS provider points each tier at its own export prefix.

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

## Deploy it

Three ways to run the same deployment — all three produce an identical job, so
pick whichever suits you.

### 1. In Cloud Shell — nothing installed locally

gcloud, Docker and your credentials are already there.

[**Open in Cloud Shell**](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fetiennechabert%2Fcost-goblin&cloudshell_working_dir=scripts%2Fgcp-focus-exporter)
— it clones the repo and drops you in this directory. Edit the config block at
the top of `deploy.sh`, then run it.

### 2. Locally, if you already have the gcloud CLI

Edit the config block at the top of `deploy.sh` — at minimum `FOCUS_TABLE`,
`BUCKET` and `PROJECT_ID` — then:

```bash
cd scripts/gcp-focus-exporter
./deploy.sh
```

It enables the APIs, creates the watermark dataset and a service account,
grants the four roles it needs, builds and deploys the Cloud Run job, and wires
up a daily Cloud Scheduler trigger. Re-run it any time to pick up changes.

### 3. Copy-paste, if you would rather see exactly what runs

Set the five values at the top, then paste the rest into Cloud Shell or any
terminal with gcloud. Every variable is braced deliberately — in zsh
(macOS's default shell) an unbraced `$VAR:costgoblin_exporter` is parsed as the
`:c` history modifier and silently drops the `c`:

```bash
# ---- your settings ----
# PROJECT_ID is the project that RUNS the job. It only differs from the billing
# export's own project if you keep billing and ops separate.
PROJECT_ID=my-project
FOCUS_TABLE=${PROJECT_ID}.gcp_billing_immutable_XXXXXX_eu.gcp_billing_export_focus_XXXXXX
BUCKET=your-company-billing
LOCATION=EU          # must match the export dataset AND the bucket
REGION=europe-west1  # a region inside LOCATION

# ---- fetch the exporter ----
mkdir -p costgoblin-exporter && cd costgoblin-exporter
BASE=https://raw.githubusercontent.com/etiennechabert/cost-goblin/main/scripts/gcp-focus-exporter
curl -fsSL -O ${BASE}/export-focus.mjs -O ${BASE}/package.json -O ${BASE}/Dockerfile

# ---- one-time setup ----
JOB=costgoblin-focus-exporter
SA=costgoblin-exporter@${PROJECT_ID}.iam.gserviceaccount.com
gcloud config set project ${PROJECT_ID}
gcloud services enable bigquery.googleapis.com storage.googleapis.com \
  run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com
bq --location=${LOCATION} mk --dataset --force ${PROJECT_ID}:costgoblin_exporter
gcloud iam service-accounts create costgoblin-exporter \
  --display-name="CostGoblin FOCUS exporter"
# Running a BigQuery job is a project-level permission. On its own it grants
# no access to any data.
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member=serviceAccount:${SA} --role=roles/bigquery.jobUser --condition=None

# Data access is granted per DATASET. Project-level dataViewer/dataEditor
# would let this service account read and write every dataset in the project;
# it needs to read exactly one (the billing export) and write exactly one
# (its own watermark). Dataset ACLs rather than `bq add-iam-policy-binding
# --dataset`, which still fails with "This feature requires allowlisting".
# Takes the owning project explicitly — the billing export may live in a
# different project from the one running the job.
grant_dataset() {   # $1 = project, $2 = dataset, $3 = READER|WRITER
  TMP=$(mktemp)
  bq show --format=prettyjson "$1:$2" > "${TMP}"
  python3 - "${TMP}" "$3" "${SA}" <<'PYEOF'
import json, sys
path, role, member = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
access = d.setdefault('access', [])
entry = {'role': role, 'userByEmail': member}
if entry not in access:
    access.append(entry)
json.dump(d, open(path, 'w'))
PYEOF
  bq update --source "${TMP}" "$1:$2"
  rm -f "${TMP}"
}
grant_dataset "$(printf '%s' "${FOCUS_TABLE}" | cut -d. -f1)" \
              "$(printf '%s' "${FOCUS_TABLE}" | cut -d. -f2)" READER
grant_dataset "${PROJECT_ID}" costgoblin_exporter WRITER

# objectAdmin, not objectCreator — deleting each period's folder is the point
gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \
  --member=serviceAccount:${SA} --role=roles/storage.objectAdmin

# ---- deploy and schedule ----
# Semicolon-separated, and `^;^` tells gcloud so. TIERS=daily,hourly contains a
# comma, which is gcloud's DEFAULT delimiter — with it, TIERS would silently
# truncate to `daily` and an empty `hourly=` variable would appear beside it.
ENV_VARS=FOCUS_TABLE=${FOCUS_TABLE};BUCKET=${BUCKET};PREFIX=focus;TIERS=daily
ENV_VARS=${ENV_VARS};STATE_TABLE=${PROJECT_ID}.costgoblin_exporter.export_state
ENV_VARS=${ENV_VARS};BQ_LOCATION=${LOCATION}
gcloud run jobs deploy ${JOB} --source=. --region=${REGION} \
  --service-account=${SA} --tasks=1 --max-retries=1 --task-timeout=30m \
  --set-env-vars="^;^${ENV_VARS}"
gcloud scheduler jobs create http ${JOB}-trigger --location=${REGION} \
  --schedule="0 6 * * *" --http-method=POST \
  --uri=https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run \
  --oauth-service-account-email=${SA}
gcloud run jobs add-iam-policy-binding ${JOB} --region=${REGION} \
  --member=serviceAccount:${SA} --role=roles/run.invoker

# ---- run it now ----
gcloud run jobs execute ${JOB} --region=${REGION} --wait
gcloud storage ls gs://${BUCKET}/focus/
```

### After deploying

Run it once and watch the output:

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

### How often should it run?

`deploy.sh` schedules **daily at 06:00 UTC**, which is the right answer for
almost everyone. Two things make more frequent runs less useful than they look:

- **The upstream export is not real-time.** Google refreshes the billing export
  a few times a day, so most extra runs would find nothing changed. Those runs
  are nearly free — the change-detection query touches two columns — but they
  also achieve nothing.
- **A run that *does* find a change re-exports the whole period.** The current
  month is always the one changing, and it grows through the month, so by the
  28th every triggered run scans a full month of data. Four runs a day at
  month-end is roughly four times the scan cost of one.

Pick by what you actually need:

| You want | Schedule |
|---|---|
| Normal cost tracking | `0 6 * * *` — the default |
| Fresher numbers during the day | `0 6,18 * * *` — twice daily |
| A number *right now* (incident, spend spike) | leave the schedule alone and run it on demand: `gcloud run jobs execute costgoblin-focus-exporter --region=<REGION> --wait` |

Raising the schedule to hourly is the one option not worth it: it multiplies
the scan cost of the current month without making the data meaningfully
fresher, because the source only updates a few times a day.

Note there are **two** cadences between BigQuery and your dashboard — this
schedule (BigQuery → bucket) and CostGoblin's own sync interval (bucket →
your machine, `intervalMinutes` in `costgoblin.yaml`). End-to-end freshness is
whichever is slower.

### Why this has to be a deployed job

`EXPORT DATA` shards its output across N files and **BigQuery chooses N**,
based on data size and available slots. N is not stable between runs.

So when a period is re-exported after a correction and this time packs into
fewer files, the extra files from the previous run stay in the folder:

```
shard-000000000000.parquet   rewritten
shard-000000000001.parquet   rewritten
shard-000000000002.parquet   rewritten
shard-000000000003.parquet   ← orphan from the previous run
shard-000000000004.parquet   ← orphan from the previous run
```

Nothing downstream can tell an orphan from a live shard — same folder, same
shape, same naming. They are read alongside the new data and **the month
silently reads high**. No error, no warning, just wrong numbers, which for a
cost tool is the worst possible failure.

Fixing it requires deleting objects, and **SQL cannot delete GCS objects**.
That is the entire reason this runs as a job: it clears each period's folder
before rewriting it. Everything else here — the watermark, the export itself —
could live in a scheduled query.

### Running the export by hand

`scheduled-query.sql` contains the same change detection and export as the
job's **hourly** tier, as a standalone BigQuery script. Useful for a first look
at the data before you deploy anything. It writes to `…/hourly/`, so point
`sync.daily.bucket` there if you just want a look — it queries fine, at hourly
grain. The daily rollup is not reproduced: its `GROUP BY` is generated from
`INFORMATION_SCHEMA` at run time, and a second copy here would have to stay in
step with the first.

It is **not a complete setup**: on its own it accumulates the orphans described
above. If you leave it running as a scheduled query, clean up by hand whenever
a period is re-exported:

```bash
gcloud storage rm --recursive gs://<BUCKET>/<PREFIX>/<TIER>/billing_period=YYYY-MM/
```

## Point CostGoblin at it

The setup wizard is AWS-only for now, so a GCP provider is added by editing
`costgoblin.yaml` directly. Open the folder that holds it from
**Data Management → Generate config templates & open folder** — the button
scaffolds an AWS-shaped template and reveals the directory. Replace the
`providers` entry (or add a second one alongside your AWS provider):

```yaml
providers:
  - name: gcp-main
    type: gcp
    sync:
      daily:
        bucket: gs://cost-goblin/focus/daily/   # BUCKET + PREFIX + tier
        retentionDays: 365
      # Only if you deployed with TIERS=daily,hourly.
      # hourly:
      #   bucket: gs://cost-goblin/focus/hourly/
      #   retentionDays: 14
      intervalMinutes: 60

defaults:
  periodDays: 30
  costMetric: effective
  lagDays: 2
```

The config is read once at startup, so **restart the app** after editing.

Field by field:

| Field | Notes |
|---|---|
| `name` | Becomes the on-disk directory `{dataDir}/{name}/` and the value of the `provider` dimension. Letters, digits, hyphens and underscores; 64 chars max. Changing it later orphans the already-synced data. |
| `type` | `gcp`. This is the discriminator — `credentialsProfile` is an AWS-only field and is rejected here. |
| `sync.daily.bucket` | The **bucket, prefix and tier folder** the exporter writes under — i.e. `BUCKET` + `PREFIX` + `/daily/`, not the bucket alone. The `gs://` scheme is optional. An `s3://` URL is rejected outright rather than failing later as a mysteriously empty listing. |
| `sync.daily.retentionDays` | How long downloaded periods are kept locally. |
| `sync.hourly` | Same shape, pointed at `…/hourly/`. Omit it unless the exporter runs with `TIERS=daily,hourly`; CostGoblin refuses an hourly sync rather than quietly serving daily rows to the intraday views. The two buckets must differ. |
| `sync.intervalMinutes` | How often CostGoblin re-checks the bucket. The second of the two cadences described above. |

There is deliberately **no `costOptimization`** block — GCP has no Cost
Optimization Hub analogue, and the validator rejects it rather than silently
ignoring it. See "Differences from the AWS integration" below.

### Credentials

By default the provider uses **Application Default Credentials**, which is one
command and no key material on disk:

```bash
gcloud auth application-default login
```

For least privilege, create a read-only service account and impersonate it —
no long-lived key, and it can reach nothing but this bucket:

```bash
gcloud iam service-accounts create costgoblin-reader \
  --display-name="CostGoblin read-only"
gcloud storage buckets add-iam-policy-binding gs://cost-goblin \
  --member=serviceAccount:costgoblin-reader@PROJECT.iam.gserviceaccount.com \
  --role=roles/storage.objectViewer
gcloud auth application-default login \
  --impersonate-service-account=costgoblin-reader@PROJECT.iam.gserviceaccount.com
```

then name it in the config:

```yaml
  - name: gcp-main
    type: gcp
    impersonateServiceAccount: costgoblin-reader@PROJECT.iam.gserviceaccount.com
    sync:
      ...
```

Both halves are needed: the `gcloud auth` command covers the listing SDK, which
reads ADC, while the config field passes the same identity to the
`gcloud storage rsync` download, which uses gcloud's own credentials and would
otherwise run as the signed-in user.

A `keyFile: /path/to/key.json` is also accepted for environments that require a
service-account key, but impersonation is the better default — there is no
secret to leak or rotate.

### What GCP does not fill in

Two dimensions are empty for GCP rows, because the FOCUS export has no such
columns: **Service Category** and **Commitment Discount Status**. They are
materialized as NULL rather than omitted (a column missing from every file is a
query-time binder error, not a NULL fill), so those dimensions will show blank
values for GCP while still working for AWS. That is the export's shape, not a
sync failure.

## How change detection works

A watermark table in your own project:

```
costgoblin_exporter.export_state(billing_period DATE, tier STRING, watermark TIMESTAMP)
```

Each run compares every period's `MAX(x_ExportTime)` against its stored
watermark and re-exports only the periods that moved. The watermark is keyed by
**tier as well as period**, so turning `hourly` on later backfills it from the
beginning instead of waiting for the next upstream change. Because the billing table
is append-only and `x_ExportTime` strictly increases, this catches late
corrections to **any** closed month, not just the current one — and converges
to a no-op once nothing is changing, which is also what keeps the BigQuery
query cost bounded.

The watermark advances to the **observed** maximum, never to wall-clock now.
Advancing to "now" would mark rows that landed mid-run as already exported, and
they would never be picked up again.

## Differences from the AWS integration

If you already run the AWS side, three things are deliberately not the same:

- **Two tiers, not three.** AWS can feed a daily export, an optional hourly
  export, and Cost Optimization Hub. GCP has no Cost Optimization Hub analogue,
  so a `gcp` provider configures `daily` and optionally `hourly` — the config
  validator rejects `costOptimization` outright rather than silently ignoring
  it.
- **One export, two grains.** On AWS the two tiers are two separately
  configured Data Exports, each delivering its own granularity. GCP's FOCUS
  export is a single hourly-grained table, so this job derives the daily tier
  from it with a `GROUP BY` rather than asking Google for a second export. The
  rollup sums the additive cost and quantity measures, keeps every unit price
  and dimension as a group key, and concatenates `x_Credits` — so a day's
  totals match the hours that composed it exactly.
- **No savings recommendations.** Cost Optimization Hub has no equivalent
  here. GCP's Recommender API is a different shape and is out of scope.

Everything above the sync layer is shared: the same dimensions, views,
baselines and tag handling, with a `provider` dimension splitting the clouds
apart and totals summing across them.

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
`gcloud storage ls gs://<BUCKET>/<PREFIX>/daily/`.

**`Not found: Dataset` or a location error.** The billing export dataset, the
watermark dataset, and the bucket must all be in the same location, and the
BigQuery job must run there too. `LOCATION` in `deploy.sh` and the scheduled
query's processing location both have to match.

**A month's totals look too high.** Orphaned shards — see "Why this has to be a
deployed job". Check the folder's shard numbering for gaps at the top, delete the
folder, and re-export:

```bash
gcloud storage rm --recursive gs://<BUCKET>/<PREFIX>/<TIER>/billing_period=YYYY-MM/
```

**Permission denied deleting objects.** The service account needs
`roles/storage.objectAdmin`, not `objectCreator` — deletion is the point.
