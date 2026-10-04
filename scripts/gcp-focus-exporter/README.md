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

This is **your** infrastructure, running in **your** project — the exporter is
what talks to BigQuery. CostGoblin never calls BigQuery: it reads the bucket,
plus your project and bucket lists while the setup wizard runs. What it *could*
reach depends on how you sign it in — as yourself it acts as you; see
[Credentials](#credentials) for confining it to the bucket.

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

Then create the bucket in **exactly the same location as the export
dataset** — BigQuery refuses to export across locations. Find the dataset's in
**BigQuery → Explorer → your billing export dataset → Details → Data
location** (the dataset name usually ends in `_eu` or `_us`).

```bash
gcloud storage buckets create gs://cost-goblin \
  --location=EU --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=0
```

Creating it in the Console instead (**Cloud Storage → Buckets → Create**)? This is
what to pick on each screen:

| Screen | Choose |
|---|---|
| Get started | Any name. *Hierarchical namespace* off. |
| Choose where to store your data | The dataset's location: `EU` → **Multi-region** `eu`; `US` → **Multi-region** `us`; a single region such as `europe-west1` → **Region**, that same region. Never *Dual-region* or *Zone*; leave cross-bucket replication unchecked. |
| Choose how to store your data | **Standard**, Autoclass off. |
| Choose how to control access to objects | Keep *Enforce public access prevention* checked; access control **Uniform**. |
| Choose how to protect object data | **Untick *Soft delete policy*** (on by default). Object versioning, bucket retention and object retention off. Google-managed encryption key. |

**No soft delete, versioning or retention.** The exporter deletes and rewrites
the current month's folder on every run. Soft delete would bill you for a week
of superseded shards, versioning would keep them forever, and a retention
policy blocks the delete outright, so every run fails.

### Stop the bucket growing forever (recommended)

Nothing ever deletes a closed month from the bucket, so it grows by one
billing period per tier, every month. GCS **Object Lifecycle Management** caps
that with a Delete rule per tier folder, keyed on object age (days since the
file was written):

| Folder | Delete after | Why |
|---|---|---|
| `focus/daily/` | **400 days** | Daily `retentionDays` defaults to 365, plus a month of margin. |
| `focus/hourly/` | **60 days** | Hourly `retentionDays` defaults to 30, and hourly is where the volume is. |

```bash
cat > lifecycle.json <<'JSON'
{"rule": [
  {"action": {"type": "Delete"}, "condition": {"age": 400, "matchesPrefix": ["focus/daily/"]}},
  {"action": {"type": "Delete"}, "condition": {"age": 60, "matchesPrefix": ["focus/hourly/"]}}
]}
JSON
gcloud storage buckets update gs://cost-goblin --lifecycle-file=lifecycle.json
gcloud storage buckets describe gs://cost-goblin --format="yaml(lifecycle_config)"
```

How the ages behave:

- **Age is counted from the last export, not from the billing month.** The
  exporter rewrites the current month's folder whenever it changes, so those
  files stay young. A closed month starts ageing once Google stops correcting
  it. If a late correction does arrive, the exporter re-exports that month,
  which resets its age.
- **Keep each age at or above that tier's `retentionDays`**, and raise both
  together. Expiry never touches what CostGoblin has already downloaded: a
  period that disappears from the bucket stays on disk until it ages out of
  retention. But a fresh install, or a teammate, can only download what the
  bucket still holds.
- **The bucket may be your only long-term copy.** BigQuery deletes the FOCUS
  table's partitions after **730 days** (`timePartitioning.expirationMs` on the
  table), and the exporter only re-exports months that change. So once a month
  has expired from both BigQuery and the bucket, it is gone. If you want daily
  history beyond two years, give `focus/daily/` a longer age, or no rule at all.
- **Deletes are permanent.** With soft delete off, as recommended above,
  nothing can be recovered.
- `--lifecycle-file` **replaces** the bucket's whole lifecycle configuration.
  Merge in any rules you already have.

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
grants the four roles it needs, builds the image into a `costgoblin` Artifact
Registry repository as a separate `costgoblin-builder` service account (see
the top of `deploy.sh` for why), deploys the Cloud Run job, and wires up a
daily Cloud Scheduler trigger. Re-run it any time to pick up changes.

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
curl -fsSL -O ${BASE}/export-focus.mjs -O ${BASE}/package.json -O ${BASE}/package-lock.json \
  -O ${BASE}/Dockerfile -O ${BASE}/cloudbuild.yaml -O ${BASE}/cleanup-policy.json

# ---- one-time setup ----
JOB=costgoblin-focus-exporter
SA=costgoblin-exporter@${PROJECT_ID}.iam.gserviceaccount.com
gcloud config set project ${PROJECT_ID}
gcloud services enable bigquery.googleapis.com storage.googleapis.com \
  run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
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
# Quoted: unquoted, each `;` would end the assignment.
ENV_VARS="FOCUS_TABLE=${FOCUS_TABLE};BUCKET=${BUCKET};PREFIX=focus;TIERS=daily"
ENV_VARS="${ENV_VARS};STATE_TABLE=${PROJECT_ID}.costgoblin_exporter.export_state"
ENV_VARS="${ENV_VARS};BQ_LOCATION=${LOCATION}"
IMAGE=${REGION}-docker.pkg.dev/${PROJECT_ID}/costgoblin/${JOB}
gcloud artifacts repositories create costgoblin --repository-format=docker \
  --location=${REGION} --description="CostGoblin FOCUS exporter images"
# Keep the 5 newest images and delete the rest, so rebuilds don't pile up.
gcloud artifacts repositories set-cleanup-policies costgoblin --location=${REGION} \
  --policy=cleanup-policy.json --no-dry-run
# Build as a dedicated, narrowly-granted service account rather than Cloud
# Build's default (the Compute Engine default SA, which many organisations
# strip of the permissions a build needs). If a grant below fails with
# "Service account ... does not exist", wait a minute and repeat it.
BUILDER=costgoblin-builder@${PROJECT_ID}.iam.gserviceaccount.com
gcloud iam service-accounts create costgoblin-builder \
  --display-name="CostGoblin FOCUS exporter image builder"
gcloud projects add-iam-policy-binding ${PROJECT_ID} --condition=None \
  --member=serviceAccount:${BUILDER} --role=roles/logging.logWriter
gcloud artifacts repositories add-iam-policy-binding costgoblin --location=${REGION} \
  --member=serviceAccount:${BUILDER} --role=roles/artifactregistry.writer
gcloud storage buckets create gs://${PROJECT_ID}_cloudbuild --location=${REGION} \
  --uniform-bucket-level-access   # skip if it already exists
gcloud storage buckets add-iam-policy-binding gs://${PROJECT_ID}_cloudbuild \
  --member=serviceAccount:${BUILDER} --role=roles/storage.objectViewer
gcloud builds submit --region=${REGION} --config=cloudbuild.yaml \
  --substitutions=_IMAGE=${IMAGE} \
  --service-account=projects/${PROJECT_ID}/serviceAccounts/${BUILDER} .
gcloud run jobs deploy ${JOB} --image=${IMAGE} --region=${REGION} \
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

Easiest route: pick **Google Cloud** on the setup screen and choose **Find my
export**. The wizard lists your projects (via `gcloud projects list`) — or, when
your account can't list the project, takes its ID typed into **Project not
listed? Enter its ID** — then the buckets in that project, then walks the bucket
so you can select the tier folder — and writes the config itself. It won't let you select the `<PREFIX>`
folder above the tiers, which is the mistake that makes the daily tier read the
hourly shards too.

Already know the project ID? Type it into **Already know the project ID? Skip
the project list**, just under **Find my export**, and the wizard goes straight
to the bucket step without running `gcloud projects list` at all — the faster
route in an organisation with thousands of projects, where that listing is slow
and the list too long to scan. The project step has a similar field, **Project
not listed? Enter its ID**, usable while the list is still loading.

> **"Couldn't list the buckets in …" is expected with the read-only reader, not
> a misconfiguration.** Listing the buckets in a project is a *project-level*
> permission; `roles/storage.objectViewer` grants rights on the bucket and
> deliberately nothing above it, so the wizard reports that it could not list
> them and hides the empty list. Type the bucket name into the field below and
> press **Browse** — walking a bucket needs only `storage.objects.list`, which
> the reader already has, and every step after it behaves normally.
>
> If **Browse** fails too, the credential has no access to that bucket at all.
> GCP returns the same denial in both cases — the trailing "(or it may not
> exist)" is Google declining to say which — so expand **Details** on the bucket
> step to see the raw message, which names the principal that was refused. That
> is usually the tell that ADC resolved to a different account than you meant.
>
> To make the dropdown work instead, add a project-level grant, accepting that
> the reader can then see the name of every bucket in the project:
>
> ```bash
> gcloud projects add-iam-policy-binding PROJECT \
>   --member=serviceAccount:costgoblin-reader@PROJECT.iam.gserviceaccount.com \
>   --role=roles/storage.bucketViewer
> ```
>
> `roles/storage.bucketViewer` is exactly `storage.buckets.get` +
> `storage.buckets.list` — it adds no object access, so the reader stays unable
> to read anything it could not already read.
>
> The *project* step one screen earlier has the same least-privilege quirk.
> The wizard runs `gcloud projects list`, which authenticates as gcloud's
> **active account** — never ADC, never the impersonated service account — and
> an account whose only grant is `roles/iam.serviceAccountTokenCreator` on the
> reader — set up for you by an admin — holds nothing at the project level, so
> the project is not listed. That is expected: type the project ID into **Project not listed? Enter its ID** (or
> into the field under **Find my export**, which skips the list) and press
> **Continue**. The project is only used to list its buckets, which the
> reader can't do anyway, so the bucket step then asks for the bucket name as
> described above. If you would rather pick the project from the list, granting
> your account `roles/browser` on the project lists it — optional, not required.
>
> If the list is empty when you expected it to be populated, check which account
> is active — anyone signed into both a work and a personal account routinely
> has the wrong one active. Fix it with `gcloud auth login` or:
>
> ```bash
> gcloud config set account you@example.com
> ```

The wizard writes neither `keyFile` nor `impersonateServiceAccount`. If you use
either (see [Credentials](#credentials)), add it to the provider the wizard
wrote — without `impersonateServiceAccount` the download runs as your own
gcloud account and is refused on a bucket granted only to the reader.

To write the entry by hand instead — a bare service-account key the wizard
can't browse with, for example — take the **Write the config by hand
instead** link on the GCP setup screen, or open the config folder from **Data Management → Generate
config templates & open folder**. Replace the `providers` entry (or add a
second one alongside your AWS provider):

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

CostGoblin only ever **reads the bucket** (plus your project and bucket lists
while the setup wizard runs). It never calls BigQuery, the billing account, or
any other API — the exporter is what talks to BigQuery, and it runs in your
project under its own service account. Two object permissions on the one bucket
are the entire requirement:

| Permission | Used for |
|---|---|
| `storage.objects.list` | finding the `billing_period=` folders |
| `storage.objects.get` | downloading the shards |

Both come from `roles/storage.objectViewer` on the bucket. Nothing at the
project level is needed — see the `storage.buckets.list` note under "Point
CostGoblin at it" for the one place that shows.

What the app *could* reach is a separate question, and it depends on how you
sign it in. By default the provider uses **Application Default Credentials**,
which is one command and no service-account key:

```bash
gcloud auth application-default login
```

Signed in like that, CostGoblin **acts as you**: the credential carries your
account's full `cloud-platform` access, so the app can reach whatever your
Google account can — BigQuery and the billing account included — even though
it never uses that reach. That is fine for a personal project. On a company or
shared laptop, confine it instead.

For least privilege — the recommendation for company and shared machines —
create a read-only service account and have CostGoblin impersonate it. No
long-lived key, and the identity CostGoblin reads the bucket with can reach
nothing but this bucket:

```bash
SA=costgoblin-reader@PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create costgoblin-reader \
  --display-name="CostGoblin read-only"
gcloud storage buckets add-iam-policy-binding gs://cost-goblin \
  --member=serviceAccount:${SA} \
  --role=roles/storage.objectViewer
# Impersonation needs permission to mint that account's tokens. It is NOT
# implied by roles/editor — only by Owner — so without this every read fails
# with "unable to impersonate … iam.serviceAccounts.getAccessToken denied",
# which is exactly the wall the least-privilege reader is most likely to hit.
gcloud iam service-accounts add-iam-policy-binding ${SA} \
  --member="user:$(gcloud config get-value account)" \
  --role=roles/iam.serviceAccountTokenCreator
```

Minting the reader's token is an IAM Service Account Credentials API call,
billed to your ADC **quota project** — the one `gcloud auth application-default
login` prints when it finishes, *not* necessarily the reader's project. If
CostGoblin reports that API as disabled, enable it in the project the message
names (or point ADC at a project where it is on with
`gcloud auth application-default set-quota-project PROJECT`):

```bash
gcloud services enable iamcredentials.googleapis.com --project=QUOTA_PROJECT
```

then name it on the provider — in the setup wizard's **Read-only service
account** field, or by hand in the config:

```yaml
  - name: gcp-main
    type: gcp
    impersonateServiceAccount: costgoblin-reader@PROJECT.iam.gserviceaccount.com
    sync:
      ...
```

Application Default Credentials stay your own plain
`gcloud auth application-default login` — do **not** pass
`--impersonate-service-account` to it. CostGoblin impersonates per provider, on
top of that login: the listing reads the bucket as the provider's
`impersonateServiceAccount`, and the `gcloud storage rsync` download passes the
same account to gcloud. ADC is a single file per machine, so impersonating
there would give every GCP provider the same reader; per provider, two
providers — a personal project's reader and a company project's, say — each
read as their own. Grant yourself `roles/iam.serviceAccountTokenCreator` on
each reader.

> Set up before this changed, with `application-default login
> --impersonate-service-account=…`? Nothing to redo: CostGoblin mints every
> provider's reader from *your* login underneath that file, so a second
> provider with a different reader works too. The app's **Sign in** button
> rewrites ADC as the plain login the next time you use it.

Two limits apply even then, so weigh them before telling an approver the app is
confined to the bucket:

- **Without `impersonateServiceAccount` (or a `keyFile`), both halves run as
  you** — the listing as your ADC login, the download as gcloud's signed-in
  account — and whatever those can reach, the app can too. And the wizard's
  project list (`gcloud projects list`) *always* runs as gcloud's active
  account, with or without impersonation — which is why a least-privilege
  account is not shown its project and types the ID instead.
- **Impersonation confines the identity used, not what is stored.** The ADC
  file still holds *your own* refresh token as the source credential every
  reader is minted from. Software running as you that reads that file can act
  as you — so full-disk encryption and an account nobody else uses still
  matter.

A `keyFile: /path/to/key.json` is also accepted for environments that require a
service-account key, but impersonation is the better default — there is no
secret to leak or rotate.

#### Checking which identities are in play

Because the two halves read two different credential stores, CostGoblin shows
both in a **Signed in as** panel on each GCP provider under **Data
Management**: the account behind **bucket listing** (the provider's `keyFile`,
or Application Default Credentials — with the file it was read from) and the
account **downloads** run as (gcloud's active account and configuration, or the
same `keyFile`). The setup wizard shows the short form: the account gcloud is
signed in as, which also lists your projects.

The panel is read-only: it reads the credential files and runs
`gcloud config list`, and asks Google to name the account behind ADC. No token
is displayed or stored. It warns when **downloads and listing run as two
different people** — typically after switching gcloud to an admin account to
make the wizard's project list work, which makes downloads run as that admin
too. Switch back with `gcloud config set account <you>` (after
`gcloud auth login <you>` if gcloud has never signed in as you).

Press **Re-check** after changing either sign-in.

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
`EXPORT DATA ... SELECT *`, billed on-demand.

Each export is bounded on the table's ingestion partition
(`_PARTITIONTIME >= <first day of the month>`). `BillingPeriodStart` is not the
partition column, so without that bound every export would scan the **whole
table**, up to two years of billing, on every run. With it, the current month
scans only what has been ingested since the 1st, and a closed month only what
has been ingested since it began. On a ~50M-row export a closed month scanned
2.4x fewer bytes than the unbounded query, and the gap widens as the table
fills. This is also why the exporter refuses a table that is not ingestion-time
partitioned (see Troubleshooting). Measure a month before committing:

```bash
bq query --use_legacy_sql=false --dry_run --format=prettyjson \
  'SELECT * FROM `PROJECT.DATASET.FOCUS_TABLE` WHERE DATE(BillingPeriodStart) = DATE "2026-07-01" AND _PARTITIONTIME >= TIMESTAMP "2026-07-01"'
```

Take `totalBytesProcessed` × ~30 runs/month ÷ 2^40 × your per-TiB rate, and
double it with `TIERS=daily,hourly`: each tier runs its own export query. A
1 GB month is a few cents; the first 1 TiB scanned each month is free. If it
comes back large, drop the schedule to a few times a week — closed months look
after themselves via the watermark.

Every run, including one that finds nothing to do, also checks which months
changed: `MAX(x_ExportTime)` per `BillingPeriodStart`, which reads those two
columns across the whole table (roughly 16 bytes a row). It is small next to an
export, but it grows with the table; dry-run
`SELECT DATE(BillingPeriodStart), MAX(x_ExportTime) FROM ... GROUP BY 1` to add
it to the estimate.

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

**`... is not ingestion-time partitioned`.** `FOCUS_TABLE` does not point
at the Google-managed FOCUS export, which BigQuery creates ingestion-time
partitioned. The exporter bounds every query on `_PARTITIONTIME`, so it refuses
any other table rather than scan all of it on every run. Check with
`bq show --format=prettyjson PROJECT:DATASET.TABLE | jq .timePartitioning`: the
managed table shows `"type": "DAY"` and no `field`. The check runs before
anything is deleted, so a refused run leaves the bucket untouched.

**Permission denied deleting objects.** The service account needs
`roles/storage.objectAdmin`, not `objectCreator` — deletion is the point.
If it already has that role, check the bucket for a retention policy or
retained objects (`gcloud storage buckets describe gs://<BUCKET>`): retention
blocks the delete for every principal.
