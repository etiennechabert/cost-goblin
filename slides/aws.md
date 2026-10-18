---
theme: none
title: AWS onboarding
titleTemplate: '%s · CostGoblin'
author: CostGoblin
info: Connect AWS billing to CostGoblin, from a FOCUS 1.2 Data Export in S3 to a local dashboard.
exportFilename: costgoblin-aws-onboarding
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
badge: Onboarding · Part 1 of 2
provider: aws
pipeline: FOCUS 1.2 Data Export → S3 → your laptop
---

# Connect *AWS* to CostGoblin

From a FOCUS 1.2 billing export to your first cost dashboard. No third party ever sees your bill.

<!--
- Hi! In this video we connect an AWS organization to CostGoblin, end to end.
- Part 1 of 2: part 2 does the same for Google Cloud.
- By the end: billing data synced to your laptop, tags turned into dimensions.
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
- **Your tags become dimensions**: teams, products and environments, cleaned up at query time

</div>

<Screenshot name="hero-final-service" />

</div>

<!--
- One-minute pitch for newcomers; skip if the audience already knows the app.
- The point to land: nothing in between your AWS account and your laptop.
-->

---
kicker: How it works
---

# Where your billing data goes

<Flow class="mt-9 justify-center">
  <Zone label="Your AWS account">
    <FlowNode icon="i-lucide-receipt" title="AWS Billing" sub="FOCUS 1.2 Data Export" />
    <FlowNode icon="i-lucide-archive" title="S3 bucket" sub="Parquet, a folder per month" />
  </Zone>
  <Zone label="Your laptop" accent>
    <FlowNode icon="i-lucide-refresh-cw" title="CostGoblin" sub="read-only sync" accent />
    <FlowNode icon="i-lucide-database" title="DuckDB" sub="queries the local files" />
  </Zone>
</Flow>

<div class="grid grid-cols-3 gap-6 mt-10 cg-small">
<div>

**No third party.** CostGoblin reads your own bucket directly. Nobody else sees your bill.

</div>
<div>

**Read-only.** Syncing needs only `s3:ListBucket` and `s3:GetObject`, on one bucket.

</div>
<div>

**Offline once synced.** Every chart and filter runs on files on your disk.

</div>
</div>

<!--
- AWS writes the export to a bucket in YOUR account; CostGoblin downloads it.
- No SaaS in the middle, no role for a vendor to assume.
- Dashboards work on a plane once synced.
-->

---
kicker: The plan
---

# What we'll do in this video

<div class="grid grid-cols-2 gap-x-12 mt-7">
<div>

1. **Before you start**<br><span class="cg-muted cg-small">Tags, Cost Optimization Hub, the export quota</span>
2. **An AWS profile**<br><span class="cg-muted cg-small">The identity CostGoblin reads with</span>
3. **Create the exports**<br><span class="cg-muted cg-small">One CloudFormation stack, opened by the wizard</span>

</div>
<div>

4. **Connect and sync**<br><span class="cg-muted cg-small">Confirm the setup, download the data</span>
5. **Dimensions**<br><span class="cg-muted cg-small">Turn your tags into clean dimensions</span>

</div>
</div>

<Callout type="info" title="Plan for a wait">

About 15 minutes of clicking. Then AWS takes about a day, sometimes up to 72 hours, to deliver the first export.

</Callout>

<!--
- Five chapters (they match the YouTube chapters).
- Be upfront about the wait: the export is asynchronous on AWS's side.
-->

---
kicker: Before we start
---

# What you need

<div class="grid grid-cols-2 gap-6 mt-6">
<div class="cg-card">

### <span class="i-lucide-building-2 cg-icon" /> In AWS

- Admin access to the account that **owns the billing data**, usually the management (payer) account
- The right to create a CloudFormation stack, **including IAM resources**

</div>
<div class="cg-card">

### <span class="i-lucide-laptop cg-icon" /> On your laptop

- **CostGoblin**, from [costgoblin.com](https://costgoblin.com/#download)
- An **AWS CLI profile** in `~/.aws/config`, SSO or keys
- Optional: the **AWS CLI**, for SSO sign-in

</div>
</div>

<!--
- Management account: Data Exports there cover every member account.
- A member account's export only covers that account.
-->

---
layout: chapter
step: 1
of: 5
goblin: jeweler
---

# Before you start

Three things to do in the Billing console of the account that owns the billing data, before any export exists.

<!--
- All three happen in the management account.
- Order matters for tags: do them first.
-->

---
kicker: Step 1 · Before you start
---

# Prepare the billing account

<div class="grid grid-cols-3 gap-5 mt-6">
<div class="cg-card cg-card--accent">

### <span class="i-lucide-tags cg-icon" /> Activate tags

<Crumbs to="Billing and Cost Management > Cost allocation tags" />

Activate every tag you want as a dimension: `team`, `environment`, `service`…

</div>
<div class="cg-card">

### <span class="i-lucide-sparkles cg-icon" /> Enable the Hub

<Crumbs to="Billing and Cost Management > Cost Optimization Hub" />

Optional: feeds the savings recommendations. Enable it for this account **and all member accounts**.

</div>
<div class="cg-card">

### <span class="i-lucide-layers cg-icon" /> Make room

<Crumbs to="Billing and Cost Management > Data Exports" />

AWS allows **two FOCUS 1.2 exports** per account. Reuse an existing one, or delete it first.

</div>
</div>

<Callout title="Tags are not backfilled">

A tag only reaches the export from the day you activate it. Activate yours before anything else.

</Callout>

<!--
- Tags: only active tags appear in the export, and never retroactively.
- Hub: recommendations take up to 24 hours to appear; rightsizing ones also need Compute Optimizer.
- Without the Hub enabled, a stack that includes the Cost Optimization export fails.
-->

---
layout: demo
screen: AWS Console
where: Billing and Cost Management > Cost allocation tags
---

# Tags, the Hub, the quota

1. **Cost allocation tags**: select your tags, then <Ui>Activate</Ui>
2. **Cost Optimization Hub**: enable it for this account and all member accounts
3. **Data Exports**: check for existing FOCUS 1.2 exports

<!--
SCREEN: AWS Console, management account.
- Cost allocation tags → User-defined tab → tick team / environment / … → Activate.
- Cost Optimization Hub → "Enable Cost Optimization Hub for this account and all member accounts" → Enable.
- Data Exports → note any existing FOCUS 1.2 export (two max).
-->

---
layout: chapter
step: 2
of: 5
goblin: detective
---

# An AWS profile

CostGoblin reads your bucket through an AWS CLI profile, the same way the `aws` command does.

<!--
- No access keys typed into the app: it uses your existing AWS config.
-->

---
kicker: Step 2 · An AWS profile
---

# The identity CostGoblin reads with

<div class="grid grid-cols-[1.1fr_1fr] gap-8 mt-5">
<div>

- Profiles come from `~/.aws/config` and `~/.aws/credentials`, as for the AWS CLI
- The setup wizard lists them: pick one
- An expired SSO session? <Ui>Open SSO Login</Ui> runs `aws sso login` for you

```bash
aws configure sso    # once: creates the profile
aws sso login --profile billing
```

</div>
<div class="cg-card">

### <span class="i-lucide-key-round cg-icon" /> What the profile needs

- **To sync:** read access to the export bucket. The stack creates that policy for you: `ReadAccessPolicyArn`
- **To pick an existing bucket in the wizard:** `s3:ListAllMyBuckets`, since the wizard lists your buckets

</div>
</div>

<!--
- AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE are honoured, like the CLI.
- "default" follows the SDK chain: env vars and AWS_PROFILE work.
- For this demo I use my own SSO profile; for a team, attach the stack's read-only policy to a dedicated role.
-->

---
layout: chapter
step: 3
of: 5
goblin: alchemist
---

# Create the exports

One CloudFormation stack creates everything, and the setup wizard opens it with your answers filled in.

<!--
- Recommended path. The by-hand path comes right after, for those who can't run CloudFormation.
-->

---
kicker: Step 3 · Create the exports
---

# What the stack creates

<div class="grid grid-cols-2 gap-8 mt-5">
<div>

- **An S3 bucket**: private, encrypted, with lifecycle rules so it doesn't grow forever
- **The daily FOCUS 1.2 export**, plus the optional ones you tick
- **A read-only IAM policy** for CostGoblin, on that bucket only

</div>
<div class="cg-card">

### <span class="i-lucide-list-checks cg-icon" /> Your choices in the wizard

- <Ui>Bucket name</Ui><br><span class="cg-small">Keep the suggested one, or name your own</span>
- <Ui>Also export hourly data</Ui><br><span class="cg-small">For intraday drill-down. It's the large export</span>
- <Ui>Also export Cost Optimization Hub recommendations</Ui><br><span class="cg-small">Only once the Hub is on</span>

</div>
</div>

<Callout title="us-east-1 only">

AWS Data Exports only exist in US East (N. Virginia). The prefilled link opens CloudFormation there, and the stack refuses any other region.

</Callout>

<!--
- Lifecycle defaults: daily 400 days, hourly 60, recommendations 100.
- The wizard's answers become the stack parameters BucketName, CreateHourlyExport, CreateCostOptimizationExport.
- Cost Optimization Hub export: only if you enabled the Hub in step 1.
-->

---
layout: demo
screen: CostGoblin → AWS Console
where: AWS > AWS Profile > Daily FOCUS export > Create one with CloudFormation
---

# Launch the stack from the wizard

1. Pick <Ui>AWS</Ui>, choose your profile, <Ui>Next</Ui>
2. On **Daily FOCUS export**: <Ui>Create one with CloudFormation</Ui>
3. Name the bucket, tick the extra exports you want
4. <Ui>Open the prefilled stack in CloudFormation</Ui>
5. Acknowledge the IAM resources, then create the stack

<!--
SCREEN: CostGoblin first run → "Which cloud are you billing on?" → AWS.
- AWS Profile → pick it → Next.
- Bucket step: "No export yet? Create one with CloudFormation".
- "Create your AWS exports": bucket name is prefilled (costgoblin-billing-xxxxxx).
- Cost Optimization Hub ticked and the role already exists? Tick "This account already has the Data Exports service role".
- CloudFormation: check the answers, tick the IAM acknowledgement, Create stack. Wait for CREATE_COMPLETE.
- No access to the link? "Save the template…" and upload it in CloudFormation instead.
-->

---
kicker: Step 3 · Create the exports
---

# When the stack is done: its *Outputs*

<div class="cg-card mt-6">

| Output | What it's for |
|---|---|
| `DailyExportPath` | `s3://<bucket>/costgoblin/daily/costgoblin-daily/`, the folder CostGoblin syncs |
| `HourlyExportPath`, `CostOptimizationExportPath` | The optional exports, when you asked for them |
| `ReadAccessPolicyArn` | Attach it to the role or user your profile reads with |
| `BucketName` | The bucket the exports deliver to |

</div>

<Callout type="tip" title="The wizard already knows the paths">

Back in CostGoblin, <Ui>I’ve created the stack</Ui> fills in the export paths for you. Nothing to copy and paste.

</Callout>

<!--
- Attaching ReadAccessPolicyArn: IAM → the role or user behind your profile → Add permissions → Attach policies.
- Deleting the stack later removes the exports and the policy, but keeps the bucket and its data.
-->

---
kicker: Step 3 · Create the exports
---

# Ask AWS for your history

<div class="grid grid-cols-[1.4fr_1fr] gap-8 items-center mt-3">
<div>

A new export starts on the day you create it. **AWS Support can backfill it**, typically up to 12 months.

The wizard writes the request for you:

- <Ui>Copy the request</Ui> and paste it into a Support case
- <Ui>Open the Support Center form</Ui>
- <Ui>File it for me…</Ui> on a Business support plan or above

</div>

<Goblin name="hauler" size="250px" />

</div>

<!--
- Do it now: the sooner you ask, the sooner the history lands in the same bucket.
- Without a Business plan, the API isn't available: paste the request into the form instead.
-->

---
kicker: Option B · Without CloudFormation
---

# Creating the export by hand

<div class="grid grid-cols-[1fr_1.2fr] gap-7 mt-4">
<div>

<Crumbs to="Billing and Cost Management > Data Exports > Create export" />

1. <Ui>Standard data export</Ui>, table **FOCUS 1.2**
2. The settings on the right
3. A lifecycle rule per prefix, so the bucket doesn't grow forever

<Callout type="danger">

Not the legacy **Cost & Usage Reports** page, and not **CUR 2.0**: CostGoblin reads FOCUS 1.2.

</Callout>

</div>
<div class="cg-card">

| Setting | Value |
|---|---|
| Data table | FOCUS 1.2 (`FOCUS_1_2_AWS`) |
| Column selection | **All columns** |
| Time granularity | Daily (hourly: a second export) |
| Format | Parquet |
| File versioning | **Overwrite existing data export file** |
| S3 path prefix | `costgoblin/daily` |

</div>
</div>

<!--
- Same result as the stack, more clicks.
- Expire costgoblin/daily/ after 400 days, hourly after 60, cost optimization after 100.
- Optional Cost Optimization Hub export: "Cost optimization recommendations" table, "Include all recommendations", prefix costgoblin/cost-optimization.
-->

---
kicker: Option B · Without CloudFormation
---

# Connecting an existing export

In the wizard, pick the export's bucket, open the folder holding `data/` and `metadata/`, then <Ui>Use this location</Ui>. It checks the export first:

<div class="cg-card mt-5">

| If the wizard says | Fix it in Data Exports |
|---|---|
| This is a CUR 2.0 export — CostGoblin reads FOCUS 1.2 | Create a FOCUS 1.2 export instead |
| This export creates a new file on every refresh | <Ui>Edit</Ui>, then File versioning: **Overwrite existing data export file** |
| Missing required columns | Keep **all columns** in the export |

</div>

<!--
- "Create new data export file" puts each refresh in its own timestamped folder, which CostGoblin skips: nothing would sync.
- Months delivered before switching to Overwrite stay in those folders and are skipped.
-->

---
layout: chapter
step: 4
of: 5
goblin: dive
---

# Connect and sync

Finish the wizard, then pull the data down to your laptop.

<!--
- Back to CostGoblin.
-->

---
layout: demo
screen: CostGoblin
where: Confirm Setup > Complete Setup > Data & Sync
---

# Finish the setup, run the first sync

1. <Ui>I’ve created the stack</Ui> opens **Confirm Setup**
2. Keep `aws-main` as the provider name, and choose how long to keep the data
3. <Ui>Complete Setup</Ui>, then pick your telemetry choices and <Ui>Finish</Ui>
4. The app restarts on **Data & Sync**: click <Ui>Sync</Ui>

<!--
SCREEN: CostGoblin.
- Provider name becomes the data folder and the Provider dimension value.
- Keep: 3 months / 6 months / 12 months (default) / 2 years.
- Hourly and Cost Optimization cards are optional: skip now, add any time from Data & Sync.
- Error reports and performance metrics are both off by default.
- Brand-new export? The tier says "No data in the bucket yet." Come back tomorrow.
-->

---
kicker: Step 4 · Connect and sync
---

# What a sync does

<Flow class="mt-7 justify-center">
  <FlowNode icon="i-lucide-rocket" title="Stack created" sub="today" />
  <FlowNode icon="i-lucide-hourglass" title="First delivery" sub="within ~1 day, up to 72 h" />
  <FlowNode icon="i-lucide-download" title="Sync" sub="Parquet to your disk" accent />
  <FlowNode icon="i-lucide-chart-pie" title="Dashboards" sub="offline, instant" />
</Flow>

<div class="grid grid-cols-3 gap-6 mt-10 cg-small">
<div>

**Month by month.** Each billing month lands in its own local folder.

</div>
<div>

**Incremental.** AWS rewrites the current month on every refresh, so later syncs re-download just that.

</div>
<div>

**Manual by default.** Turn on <Ui>Auto-sync</Ui> under **Automatic schedule** to keep it fresh.

</div>
</div>

<!--
- First sync takes a few minutes, depending on how much history the bucket holds.
-->

---
layout: center
---

<div class="grid grid-cols-[1fr_1.5fr] gap-10 items-center">
<div>

<div class="cg-kicker">Meanwhile</div>

# A few months *later*

The same setup, in an account whose export has been running for a while.

</div>

<Screenshot name="cost-overview" />

</div>

<!--
- Cooking-show moment: switch to a workspace whose export has been running.
- Quick tour: Cost Overview → filter an account → drill into a service → Explorer.
-->

---
layout: chapter
step: 5
of: 5
goblin: polish
---

# Dimensions

Turn messy tags into clean dimensions, instantly, with no reprocessing.

<!--
- This is where CostGoblin shines.
-->

---
kicker: Step 5 · Dimensions
---

# Make your tags usable

<div class="grid grid-cols-3 gap-5 mt-6">
<div class="cg-card">

### <span class="i-lucide-merge cg-icon" /> Normalize

`prod`, `Prod` and `PROD` become one value: lowercase, kebab-case, snake_case…

</div>
<div class="cg-card">

### <span class="i-lucide-git-merge cg-icon" /> Aliases

Group values under one label: `production: prod, prd, live`

</div>
<div class="cg-card">

### <span class="i-lucide-building-2 cg-icon" /> Account fallback

Fill a missing resource tag from the account's own tag.

</div>
</div>

<Callout type="tip" title="Applied at query time">

Rules run when you query, not when you sync: change one, and every view updates. Nothing to re-download.

</Callout>

<!--
- Built-in dimensions are already there: Account, Region, Service, Service Category, Charge Category, SKU Meter.
- Tag discovery needs a first sync: the Resource Tag list comes from your data.
-->

---
layout: demo
screen: CostGoblin
where: Settings > Dimensions > Custom tag dimensions
---

# Map the `team` tag

1. Under **Custom tag dimensions**: <Ui>+ Add</Ui>
2. **Display Label**: Team · **Resource Tag**: `team`
3. Pick a **Normalization**, add **Alias Rules**
4. <Ui>Apply & rebuild rollup</Ui>

<!--
SCREEN: Settings → Dimensions.
- The Resource Tag picker shows each tag's coverage and number of distinct values.
- "Fallback (account)" fills missing values from an account tag.
- Then open a view and group by Team.
-->

---
kicker: When something's off
---

# Gotchas

<div class="grid grid-cols-[1fr_auto] gap-7 items-center mt-3">
<div class="cg-card cg-small">

| Symptom | Fix |
|---|---|
| Stack fails on the Cost Optimization export | Enable Cost Optimization Hub first, or untick that export |
| Stack fails: the service role exists | Tick **This account already has the Data Exports service role** |
| CloudFormation rejects the region | Switch the console to **us-east-1** |
| A tag is missing | Activate it: tags only appear from activation onwards |
| No data in the bucket yet. | Wait for the first delivery (up to 72 h), or backfill |
| The wizard can't list buckets | Use a profile allowed `s3:ListAllMyBuckets` |

</div>

<Goblin name="trap" size="210px" />

</div>

<!--
- A failed stack keeps its bucket (and the service role, if it got that far): delete both before retrying.
- Third FOCUS export refused: two per account, reuse one.
-->

---
kicker: Recap
---

# What we set up

<div class="grid grid-cols-[1.3fr_1fr] gap-10 items-center mt-4">
<div class="cg-checklist">

- Cost allocation tags activated, Cost Optimization Hub enabled
- A FOCUS 1.2 export, bucket and read-only policy, from one stack
- A backfill request for the past months
- CostGoblin connected, and the data synced to your laptop
- Tags mapped to clean dimensions

</div>
<div class="cg-card cg-card--accent">

### <span class="i-lucide-cloud cg-icon" /> Next: Google Cloud

Part 2 connects a GCP billing account. Both clouds land in the same views, split by the **Provider** dimension.

</div>
</div>

<!--
- Recap in ten seconds, then plug part 2.
-->

---
layout: end
goblin: throne
---

# Your bill, *your laptop*

Free and open source. Download it, star it, and tell us what you'd like next.

<!--
- Thanks for watching. Links in the description.
- Issues and ideas: GitHub.
-->
