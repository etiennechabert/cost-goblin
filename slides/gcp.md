---
theme: none
title: GCP onboarding
titleTemplate: '%s · CostGoblin'
author: CostGoblin
info: Connect Google Cloud billing to CostGoblin, from the FOCUS BigQuery export to a local dashboard.
exportFilename: costgoblin-gcp-onboarding
colorSchema: dark
favicon: /favicon.png
fonts:
  sans: Outfit Variable
  mono: DM Mono
  provider: none
transition: fade
download: false
monaco: false
twoslash: false
drawings:
  persist: false
layout: cover
badge: Onboarding · Part 2 of 2
provider: gcp
pipeline: FOCUS export → Cloud Storage → your laptop
---

# Connect *Google Cloud* to CostGoblin

From the FOCUS billing export to your first cost dashboard. No third party ever sees your bill.

<!--
- Part 2: Google Cloud. Part 1 did AWS; both end up in the same views.
- GCP has one extra moving part, a small exporter job. We'll see why.
-->

---
kicker: If you're new here
---

# Cloud cost visibility, *on your machine*

<div class="grid grid-cols-[1fr_1.2fr] gap-8 items-center mt-5">
<div>

- **A desktop app** for macOS, Windows and Linux
- **Your billing data stays local**: Parquet files on your disk, queried with DuckDB
- **No servers, no SaaS fees**: free and open source
- **AWS and Google Cloud side by side**, in the same views

</div>

<Screenshot name="hero-final-service" />

</div>

<!--
- Watched part 1? Skip ahead to the plan.
-->

---
kicker: How it works
---

# Where your billing data goes

<Flow class="mt-8 justify-center cg-flow--tight">
  <Zone label="Your Google Cloud project">
    <FlowNode icon="i-lucide-receipt" title="Cloud Billing" sub="FOCUS export in BigQuery" />
    <FlowNode icon="i-lucide-workflow" title="Exporter job" sub="Cloud Run, daily" />
    <FlowNode icon="i-lucide-archive" title="Bucket" sub="Parquet, a folder per month" />
  </Zone>
  <Zone label="Your laptop" accent>
    <FlowNode icon="i-lucide-refresh-cw" title="CostGoblin" sub="read-only sync" accent />
    <FlowNode icon="i-lucide-database" title="DuckDB" sub="queries the local files" />
  </Zone>
</Flow>

<div class="grid grid-cols-3 gap-6 mt-10 cg-small">
<div>

**Your infrastructure.** The exporter runs in your project, under its own service account.

</div>
<div>

**CostGoblin never calls BigQuery.** It reads the bucket, and your project and bucket lists during setup.

</div>
<div>

**Offline once synced.** Every chart and filter runs on files on your disk.

</div>
</div>

<!--
- Google writes the FOCUS export to BigQuery; a small job copies it to Cloud Storage as Parquet.
- CostGoblin reads the bucket, plus your project and bucket lists while the wizard runs.
-->

---
kicker: The plan
---

# What we'll do in this video

<div class="grid grid-cols-2 gap-x-12 mt-7">
<div>

1. **Enable the FOCUS export**<br><span class="cg-muted cg-small">Today: the backfill only reaches last month</span>
2. **Create the bucket**<br><span class="cg-muted cg-small">In the same location as the export</span>
3. **Deploy the exporter**<br><span class="cg-muted cg-small">One script, from Cloud Shell</span>

</div>
<div>

4. **Grant read access**<br><span class="cg-muted cg-small">A read-only service account, or yourself</span>
5. **Connect and sync**<br><span class="cg-muted cg-small">The wizard, then the first download</span>

</div>
</div>

<Callout type="info" title="Plan for a wait">

The export backfills the current and previous month, and those take a few days to land in BigQuery.

</Callout>

<!--
- Five chapters, matching the YouTube chapters.
- Step 1 is the one not to postpone.
-->

---
kicker: Before we start
---

# What you need

<div class="grid grid-cols-2 gap-6 mt-6">
<div class="cg-card">

### <span class="i-lucide-building-2 cg-icon" /> In Google Cloud

- Access to the **billing account**'s export settings
- A **project** to host the export and the job, where you can enable APIs and grant IAM roles

</div>
<div class="cg-card">

### <span class="i-lucide-laptop cg-icon" /> On your laptop

- **CostGoblin**, from [costgoblin.com](https://costgoblin.com/#download)
- The **gcloud CLI**: CostGoblin downloads through it
- Nothing else: the exporter deploys from **Cloud Shell**

</div>
</div>

<!--
- The export is configured per billing account and covers every project linked to it.
- Cloud Shell already has gcloud, Docker and your credentials: nothing to install for the deploy.
-->

---
layout: chapter
step: 1
of: 5
goblin: jeweler
---

# Enable the FOCUS export

Do it today: Google only backfills the current and the previous month.

<!--
- Every day you wait is a day of history you can't get back.
-->

---
kicker: Step 1 · Enable the FOCUS export
---

# Turn on *FOCUS usage cost*

<div class="grid grid-cols-[1.25fr_1fr] gap-8 mt-4">
<div>

<Crumbs to="Billing > Billing export > BigQuery export" />

- Enable **FOCUS usage cost**, not the older FOCUS *view*: that one is FOCUS 1.0
- Pick a **Multi-region** dataset, **EU** or **US**: it backfills the current and previous month. A single region starts empty
- The **project** is only where the dataset lives: the export covers every project on the billing account

</div>
<div class="cg-card">

### <span class="i-lucide-map-pin cg-icon" /> The location is for good

The dataset's location can't change later, and the bucket has to match it. Note it down: you need it in step 2.

</div>
</div>

<!--
- Google creates a managed dataset gcp_billing_immutable_<BILLING_ACCOUNT_ID>_<location>.
- Its table, gcp_billing_export_focus_<BILLING_ACCOUNT_ID>, is what the exporter reads.
- Google keeps two years in that table: your local copy becomes the long-term archive.
-->

---
layout: demo
screen: Google Cloud Console
where: Billing > Billing export > BigQuery export
---

# Enable the export

1. Open **Billing export**, tab **BigQuery export**
2. Edit **FOCUS usage cost**
3. Pick the project, and a **Multi-region** dataset: EU or US
4. Save, and note the dataset's location

<!--
SCREEN: Google Cloud Console, billing account.
- Not the "FOCUS view" over the detailed export: FOCUS 1.0, unsupported.
- The backfill lands over a few days.
-->

---
layout: chapter
step: 2
of: 5
goblin: vault
---

# Create the bucket

In exactly the export dataset's location: BigQuery refuses to export across locations.

<!--
- One bucket for the exporter's output; CostGoblin reads only this one.
-->

---
kicker: Step 2 · Create the bucket
---

# A bucket next to the dataset

<Crumbs to="BigQuery > your billing dataset > Details > Data location" />

```bash
gcloud storage buckets create gs://your-company-billing \
  --location=EU --uniform-bucket-level-access \
  --public-access-prevention --soft-delete-duration=0
```

<div class="grid grid-cols-2 gap-6 mt-5">
<div class="cg-card cg-small">

### <span class="i-lucide-ban cg-icon" /> No soft delete, versioning or retention

The exporter deletes and rewrites the current month on every run. A retention policy would block it.

</div>
<div class="cg-card cg-small">

### <span class="i-lucide-recycle cg-icon" /> Optional: lifecycle rules

Nothing deletes closed months. Expire `focus/daily/` after 400 days, `focus/hourly/` after 60.

</div>
</div>

<!--
- The dataset's location is in its Details page; the name usually ends in _eu or _us.
- Console instead? Multi-region eu or us, Standard class, uniform access, untick Soft delete.
- Lifecycle commands: the exporter README, "Stop the bucket growing forever".
-->

---
layout: demo
screen: Cloud Shell
where: BigQuery > billing dataset > Details > Data location
---

# Create the bucket

1. Read the dataset's **Data location**
2. Run `gcloud storage buckets create` with that location
3. Optional: add the lifecycle rules

<!--
SCREEN: Cloud Shell (or any terminal with gcloud).
- --location must be the dataset's: EU, US, or the same single region.
-->

---
layout: chapter
step: 3
of: 5
goblin: alchemist
---

# Deploy the exporter

A small daily job in your project copies changed months from BigQuery into the bucket.

<!--
- One script. Re-run it any time to pick up changes.
-->

---
kicker: Step 3 · Deploy the exporter
---

# Why a job, and not a scheduled query?

<div class="grid grid-cols-[1fr_1.1fr] gap-8 items-center mt-4">
<div>

BigQuery **picks how many files** each export writes. Re-export a corrected month into fewer files, and the extras from the last run **stay behind**.

Nothing can tell those orphans from live files. The month **silently reads high**.

**SQL can't delete files** in Cloud Storage, so the job clears each month's folder before rewriting it.

</div>

```text
billing_period=2026-09/
  shard-000000000000.parquet   rewritten
  shard-000000000001.parquet   rewritten
  shard-000000000002.parquet   rewritten
  shard-000000000003.parquet   ← orphan
  shard-000000000004.parquet   ← orphan
```

</div>

<!--
- No error, no warning, just wrong numbers: the worst failure for a cost tool.
- Everything else (change detection, the export itself) could live in a scheduled query.
-->

---
kicker: Step 3 · Deploy the exporter
---

# Set the values, run `deploy.sh`

```bash
# scripts/gcp-focus-exporter/deploy.sh, the values at the top
PROJECT_ID=""            # empty: the export table's project
FOCUS_TABLE="my-project.gcp_billing_immutable_XXXXXX_eu.gcp_billing_export_focus_XXXXXX"
BUCKET="your-company-billing"
TIERS="daily"            # or "daily,hourly"
LOCATION="EU"            # the dataset's and the bucket's location
REGION="europe-west1"    # a Cloud Run region inside LOCATION
```

<Flow class="mt-6 justify-center cg-flow--tight">
  <FlowNode icon="i-lucide-plug" title="APIs" sub="enabled" />
  <FlowNode icon="i-lucide-shield-check" title="Service account" sub="the four roles it needs" />
  <FlowNode icon="i-lucide-package" title="Image" sub="costgoblin Artifact Registry" />
  <FlowNode icon="i-lucide-workflow" title="Cloud Run job" sub="deployed" accent />
  <FlowNode icon="i-lucide-alarm-clock" title="Schedule" sub="daily, 06:00 UTC" />
</Flow>

<!--
- At minimum: FOCUS_TABLE, BUCKET (and PROJECT_ID if the job runs elsewhere).
- It also creates a small watermark dataset: how it remembers which months it exported.
- Hourly is the large tier: only add it if you want intraday charts.
- REGION must sit inside LOCATION.
- The build runs as a separate costgoblin-builder service account.
-->

---
layout: demo
screen: Cloud Shell
where: Exporter README > Open in Cloud Shell
---

# Deploy and run it once

1. <Ui>Open in Cloud Shell</Ui> from the exporter README
2. Edit the values at the top of `deploy.sh`
3. Run `./deploy.sh`
4. Run the job now, and wait for it
5. List `gs://<bucket>/focus/`

<!--
SCREEN: Cloud Shell, in scripts/gcp-focus-exporter.
- Run it now: gcloud run jobs execute costgoblin-focus-exporter --region=europe-west1 --wait
- Check: gcloud storage ls gs://your-company-billing/focus/
- Prefer seeing every command? The README has a copy-paste version.
-->

---
kicker: Step 3 · Deploy the exporter
---

# What lands in the bucket

<div class="grid grid-cols-[1.2fr_1fr] gap-8 mt-4">
<div>

```text
gs://your-company-billing/focus/
├── daily/
│   ├── billing_period=2026-09/
│   │   └── shard-000000000000.parquet
│   └── billing_period=2026-10/
│       └── shard-000000000000.parquet
└── hourly/    only with TIERS=daily,hourly
```

- **daily** is a rollup of Google's hourly rows, about 24 times smaller
- Only **months that changed** are exported again, late corrections included

</div>
<div class="cg-card">

### <span class="i-lucide-coins cg-icon" /> What it costs

- The export: **free**
- BigQuery bytes scanned per run: the first **1 TiB a month is free**
- Storage: pennies. Cloud Run and Scheduler: effectively free

</div>
</div>

<!--
- The job compares each month's newest export time with a watermark, per tier.
- Two cadences: this schedule (BigQuery → bucket) and CostGoblin's sync (bucket → laptop).
- Dry-run a month's scan cost: the exporter README, "Cost".
-->

---
layout: chapter
step: 4
of: 5
goblin: detective
---

# Grant read access

CostGoblin needs to read this one bucket, and nothing else.

<!--
- Two options: a read-only service account (company), or yourself (personal project).
-->

---
kicker: Step 4 · Grant read access
---

# Who CostGoblin reads as

<div class="grid grid-cols-2 gap-6 mt-5">
<div class="cg-card cg-card--accent">

### <span class="i-lucide-shield-check cg-icon" /> In an organisation

A **read-only service account**, `costgoblin-reader`, that can read only this bucket. An admin creates it once. You **impersonate** it: no key to leak.

</div>
<div class="cg-card">

### <span class="i-lucide-user cg-icon" /> In a personal project

Read **as yourself**. Simpler, but CostGoblin then has your account's full access, even though it only reads the bucket.

</div>
</div>

<Callout type="tip" title="Either way, sign in twice on your laptop">

`gcloud auth login` for downloads, and `gcloud auth application-default login` for listing the bucket.

</Callout>

<!--
- Downloads run through gcloud storage rsync, as gcloud's active account.
- Listing uses Application Default Credentials.
- With a reader set, both impersonate it.
-->

---
kicker: Step 4 · Grant read access
---

# The read-only reader, once

```bash
PROJECT_ID=your-project; BUCKET=your-company-billing
SA=costgoblin-reader@$PROJECT_ID.iam.gserviceaccount.com
gcloud iam service-accounts create costgoblin-reader --project=$PROJECT_ID
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$SA --role=roles/storage.objectViewer
gcloud projects add-iam-policy-binding $PROJECT_ID --condition=None \
  --member=serviceAccount:$SA --role=roles/storage.bucketViewer  # bucket names only
gcloud iam service-accounts add-iam-policy-binding $SA --project=$PROJECT_ID \
  --member="user:you@company.com" --role=roles/iam.serviceAccountTokenCreator
```

<div class="grid grid-cols-3 gap-5 mt-4 cg-small">
<div>

**objectViewer** on the bucket: list and download the export.

</div>
<div>

**bucketViewer** on the project: optional, lets the wizard list bucket names.

</div>
<div>

**Token Creator** for you: lets you read as the reader.

</div>
</div>

<!--
- Run by an admin, once. Your everyday account then only needs Token Creator on the reader.
- Right after the create, a binding can fail with "does not exist" while IAM catches up: wait a few seconds and re-run it.
- Skip bucketViewer if the reader shouldn't see other bucket names: you'll type the bucket name instead.
-->

---
layout: chapter
step: 5
of: 5
goblin: dive
---

# Connect and sync

The wizard browses your bucket, checks the download works, and writes the config.

<!--
- Back to CostGoblin.
-->

---
layout: demo
screen: CostGoblin
where: Google Cloud > Set up from Google Cloud > Daily FOCUS export
---

# Connect CostGoblin

1. Pick <Ui>Google Cloud</Ui>, type the **Google Cloud project**, <Ui>Continue</Ui>
2. Pick the bucket, or type its name and <Ui>Browse</Ui>
3. Open `focus/daily/`, then <Ui>Use this location</Ui>
4. Wait for the **Download check**, then <Ui>Complete Setup</Ui>
5. On **Data & Sync**: <Ui>Sync</Ui>

<!--
SCREEN: CostGoblin → "Which cloud are you billing on?" → Google Cloud.
- AWS already set up in this workspace? Start from Data & Sync → Add Provider instead: same steps, no restart.
- "Reads as costgoblin-reader@<project>.iam.gserviceaccount.com": Change to use another reader, clear it to read as yourself.
- Typing the project ID skips "gcloud projects list", which is slow in big organisations.
- Provider name defaults to gcp-main.
-->

---
kicker: Step 5 · Connect and sync
---

# What the wizard checks for you

<div class="grid grid-cols-2 gap-6 mt-5">
<div class="cg-card">

### <span class="i-lucide-user-round-check cg-icon" /> Who it reads as

Under the project field, **Reads as** names the reader: `costgoblin-reader`, in your project. <Ui>Change</Ui> names another, or clear it to read as yourself.

</div>
<div class="cg-card">

### <span class="i-lucide-folder-tree cg-icon" /> The right folder

It refuses the parent `focus/` folder: **This is the parent folder — go one level deeper**. Open `daily/`.

</div>
<div class="cg-card">

### <span class="i-lucide-cloud-download cg-icon" /> The download

Before saving, it checks that **gcloud can download the export** as the reader. A problem shows up here, not on the first sync.

</div>
<div class="cg-card">

### <span class="i-lucide-fingerprint cg-icon" /> Signed in as

Shows the Google accounts in play, with the command to run when one is wrong.

</div>
</div>

<!--
- Pointing the daily tier at focus/ would read every tier's files.
- Signed in as also lives on each GCP provider in Data & Sync.
-->

---
kicker: When something's off
---

# Troubleshooting

<div class="grid grid-cols-[1fr_auto] gap-7 items-center mt-3">
<div class="cg-card cg-small">

| If you see | Fix |
|---|---|
| costgoblin-reader can't list the buckets in … | Type the bucket name, then <Ui>Browse</Ui> |
| Can't read as costgoblin-reader | Create it, or grant Token Creator on it |
| No Google Cloud projects found | **Project not listed? Enter its ID** |
| IAM Credentials API disabled | Enable `iamcredentials.googleapis.com` |
| An empty bucket, and no error | Folders must read `billing_period=`, lowercase |
| A month reads too high | Delete its watermark row, run the job again |

</div>

<Goblin name="trap" size="210px" />

</div>

<!--
- Bucket list denied is normal for a least-privilege reader: Browse needs only object list.
- The IAM Credentials API is billed to your ADC quota project, the one application-default login prints: enable it there, not necessarily in the reader's project.
- "Can't read as" covers both causes: the reader doesn't exist in that project, or you lack Token Creator on it.
- Location errors: dataset, watermark dataset, bucket and job must share one location.
- Too high: the job only re-exports a month whose watermark moved, so deleting the folder alone leaves it missing. Delete the row instead (bq query --use_legacy_sql=false "DELETE FROM costgoblin_exporter.export_state WHERE billing_period = 'YYYY-MM-01'"), then run the job: it clears the folder before rewriting it.
-->

---
kicker: Good to know
---

# How GCP differs from AWS

<div class="grid grid-cols-3 gap-5 mt-6">
<div class="cg-card">

### <span class="i-lucide-layers cg-icon" /> Two tiers

Daily, and optional hourly. Google has no Cost Optimization Hub, so there's no savings tier.

</div>
<div class="cg-card">

### <span class="i-lucide-split cg-icon" /> One export

Google exports hourly rows. The job computes the daily tier from them.

</div>
<div class="cg-card">

### <span class="i-lucide-columns-3 cg-icon" /> Two blank columns

**Service Category** and **Commitment Discount Status** stay empty for GCP rows.

</div>
</div>

<Callout type="tip" title="The rest is shared">

Dimensions, views and tag rules work the same for both clouds. The **Provider** dimension splits them apart, and totals add up across them.

</Callout>

<!--
- Dimensions: see part 1, step 5. Same editor, same rules.
- The blank columns are the export's shape, not a sync failure.
-->

---
kicker: Recap
---

# What we set up

<div class="grid grid-cols-[1.3fr_1fr] gap-10 items-center mt-4">
<div class="cg-checklist">

- The FOCUS export, in a multi-region dataset
- A bucket in the same location
- The exporter job, scheduled daily
- A read-only reader, or your own sign-in
- CostGoblin connected, and the data synced to your laptop

</div>
<div class="cg-card cg-card--accent">

### <span class="i-lucide-tags cg-icon" /> Next: your tags

Map your labels to dimensions, exactly as in part 1, and both clouds land in the same views.

</div>
</div>

<!--
- Recap, then point back to part 1's Dimensions chapter.
-->

---
layout: end
goblin: throne
---

# Two clouds, *one laptop*

Free and open source. Download it, star it, and tell us which cloud you'd like next.

<!--
- Thanks for watching. Azure is on the roadmap.
-->
