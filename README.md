<p align="center">
  <img src="docs/goblin.png" alt="CostGoblin" width="128">
</p>

<h1 align="center">CostGoblin</h1>

<p align="center">
  Cloud cost visibility that runs on your machine.<br>
  No servers, no SaaS fees, and your billing data stays local.<br>
  Release builds check GitHub Releases for updates at launch (can be turned off).
</p>

<p align="center">
  <a href="https://github.com/etiennechabert/cost-goblin/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D%2024-339933.svg?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Electron-44-47848F.svg?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/DuckDB-1.5-FFF000.svg?logo=duckdb&logoColor=black" alt="DuckDB">
  <a href="https://github.com/etiennechabert/cost-goblin/actions/workflows/ci.yml"><img src="https://github.com/etiennechabert/cost-goblin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="https://sonarcloud.io/summary/new_code?id=etiennechabert_cost-goblin"><img src="https://sonarcloud.io/api/project_badges/measure?project=etiennechabert_cost-goblin&metric=security_rating" alt="Security Rating"></a>
  <a href="https://sonarcloud.io/summary/new_code?id=etiennechabert_cost-goblin"><img src="https://sonarcloud.io/api/project_badges/measure?project=etiennechabert_cost-goblin&metric=reliability_rating" alt="Reliability Rating"></a>
  <a href="https://sonarcloud.io/summary/new_code?id=etiennechabert_cost-goblin"><img src="https://sonarcloud.io/api/project_badges/measure?project=etiennechabert_cost-goblin&metric=sqale_rating" alt="Maintainability Rating"></a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/etiennechak"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buymeacoffee&logoColor=white" alt="Buy Me A Coffee"></a>
  <a href="https://sentry.io"><img src="https://img.shields.io/badge/Sponsored%20by-Sentry-362D59?logo=sentry&logoColor=white" alt="Sponsored by Sentry"></a>
</p>

<h3 align="center">
  <a href="https://costgoblin.com">costgoblin.com</a>
</h3>

<p align="center">
  <a href="https://costgoblin.com/#download">Download</a> &middot;
  <a href="#quick-start">Get Started</a> &middot;
  <a href="#features">Features</a>
</p>

<p align="center">
  <img src="docs/screenshots/hero-final-service.png" alt="CostGoblin dashboard" width="800">
</p>

CostGoblin is a desktop app that syncs your AWS billing data locally and queries it with DuckDB. Filter, drill down, and slice costs by any dimension — from a plane at 10,000 meters.

## Install

Download the latest release for your platform from [costgoblin.com](https://costgoblin.com/#download). macOS binaries are signed and notarized. See the [code signing policy](https://costgoblin.com/code-signing.html) for details.

Release builds check GitHub Releases for a new version once at launch and prompt you when one is out. Downloading and installing are one click each and never happen without your confirmation; **Check for updates** in Settings → General runs a check on demand. To turn the launch check off, choose **Manual only** under Settings → General → Update check (saved per workspace), or set `COSTGOBLIN_DISABLE_UPDATE_CHECK=1` in the app's environment, which covers every workspace (macOS GUI apps don't read shell profiles: use `launchctl setenv COSTGOBLIN_DISABLE_UPDATE_CHECK 1`, e.g. from an MDM LaunchAgent). Turning it off is advisable where github.com is blocked. The prompt is a notification, not a patching mechanism: fleets should enforce versions through MDM.

## Quick Start

```bash
make dev
```

`make dev` installs dependencies with `npm ci` on its first run, and again whenever `package-lock.json` changes (after a pull or a branch switch). On first launch, the setup wizard guides you through connecting to your AWS billing data.

## Prerequisites

- **Node.js** 24+
- At least one billing source:
  - **AWS** — a FOCUS 1.2 Data Export delivered as Parquet to S3 (below)
  - **GCP** — the native FOCUS BigQuery export, copied into a GCS bucket by [the FOCUS exporter](scripts/gcp-focus-exporter/README.md)

A workspace can configure several providers at once; totals sum across them and a `provider` dimension splits them apart.

### Setting Up AWS Data Exports

CostGoblin reads AWS billing data from **AWS Data Exports** delivered to S3 as Parquet: the **FOCUS 1.2** table, plus, optionally, Cost Optimization Hub recommendations. Everything below happens in the account that owns the billing data, usually the management (payer) account.

#### Before you start

Whichever way you create the exports afterwards:

1. **Activate your cost allocation tags** under **Billing and Cost Management → Cost allocation tags**. Only active tags reach the export, and activating one later doesn't backfill it.
2. **Enable Cost Optimization Hub**, if you want its recommendations: open **Billing and Cost Management → [Cost Optimization Hub](https://console.aws.amazon.com/costmanagement/home#/cost-optimization-hub)**, in the management account choose *Enable Cost Optimization Hub for this account and all member accounts*, then **Enable**. Until you do, AWS refuses to create a Cost Optimization Hub export, so a stack that includes one fails too. Recommendations take up to 24 hours to appear, and the rightsizing ones need [Compute Optimizer](https://console.aws.amazon.com/compute-optimizer/home) enabled as well.
3. **Make room for the exports.** AWS allows [two FOCUS 1.2 exports per account](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-quotas.html). If [Data Exports](https://us-east-1.console.aws.amazon.com/costmanagement/home#/bcm-data-exports) already lists FOCUS 1.2 exports, connect CostGoblin to those instead, or delete them first: AWS refuses a third.

Then create the exports in **one** of the two ways below. Both produce the same exports with the same settings; use the stack unless you can't.

#### Recommended: one CloudFormation stack

The stack ([`costgoblin-exports.yaml`](scripts/aws-exports/costgoblin-exports.yaml)) creates everything with the settings CostGoblin needs:

- an S3 bucket (no public access, encrypted) with the lifecycle rules [below](#keep-the-bucket-from-growing-forever);
- the daily FOCUS 1.2 export, and optionally the hourly and Cost Optimization Hub exports;
- a read-only IAM policy granting exactly what CostGoblin needs on that bucket.

The setup wizard walks you through it: on the bucket step, choose **Create one with CloudFormation**. It opens the stack with your answers filled in and configures CostGoblin with the stack's paths. Without the app:

1. [**Launch the stack**](https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https%3A%2F%2Fcostgoblin-templates.s3.eu-central-1.amazonaws.com%2Ftemplates%2Flatest%2Fcostgoblin-exports.yaml&stackName=costgoblin-exports). It opens CloudFormation in us-east-1, the only region with AWS Data Exports, with the latest release's template loaded.
2. Fill in the parameters: a bucket name (leave it empty for `costgoblin-billing-<account id>`), and whether to add the hourly and Cost Optimization Hub exports. If the account already has the `AWSServiceRoleForBCMDataExports` role (**IAM → Roles**; creating a Cost Optimization Hub export adds it), set `CreateDataExportsServiceRole` to `no`.
3. Acknowledge that the stack creates IAM resources, and create it.
4. Attach the `ReadAccessPolicyArn` output to the role or user CostGoblin reads with, and point CostGoblin at the paths in the stack's **Outputs** (`DailyExportPath` and the others).

To read the template before running it, download [the raw file](https://raw.githubusercontent.com/etiennechabert/cost-goblin/main/scripts/aws-exports/costgoblin-exports.yaml), open [CloudFormation in us-east-1](https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create) and choose **Create stack → With new resources → Upload a template file**. Don't paste a GitHub link into the **Amazon S3 URL** field: it only accepts templates stored in S3.

AWS delivers the first data within about a day, sometimes up to 72 hours. A new export has no history: see [Historical data](#historical-data) for a backfill. Deleting the stack removes the exports and policies but keeps the bucket and the data already delivered. A stack that fails to create keeps its bucket as well, and the `AWSServiceRoleForBCMDataExports` role if it got that far: before retrying, delete the failed stack and that bucket (empty it first if AWS already wrote to it), and set `CreateDataExportsServiceRole` to `no` if the role now exists.

#### Or by hand

1. **Create the bucket**, or pick an existing one, and add the lifecycle rules [below](#keep-the-bucket-from-growing-forever). Each export gets its own prefix: `costgoblin/daily`, `costgoblin/hourly` and `costgoblin/cost-optimization`.
2. **Create the FOCUS 1.2 export.** In **Billing and Cost Management → [Data Exports](https://us-east-1.console.aws.amazon.com/costmanagement/home#/bcm-data-exports)**, click **Create export**, then choose **Standard data export** and the **FOCUS 1.2** table (`FOCUS_1_2_AWS`), with the settings below. For intraday drill-down, add a second export with Hourly granularity.
3. **Create the Cost Optimization Hub export**, if you want it and have [enabled the Hub](#before-you-start): one more **Create export**, with the **Cost optimization recommendations** table and **Include all recommendations** ticked, the same delivery settings, and the `costgoblin/cost-optimization` prefix.

> ⚠️ Don't create the report from the legacy **Cost & Usage Reports** page, and don't pick the CUR 2.0 table — CostGoblin's schema is FOCUS 1.2. A correct export delivers Parquet files under `data/` and `metadata/` folders, partitioned by `billing_period=`.

**Export settings:**

| Setting | Value |
|---------|-------|
| Export type | **Standard data export** (table: `FOCUS_1_2_AWS`) |
| Time granularity | Daily (create an optional second export with Hourly for intraday drill-down) |
| Column selection | **All columns** |
| Format | Parquet |
| Compression | Snappy |
| File versioning | **Overwrite existing data export file** |
| S3 path prefix | `costgoblin/daily` (`costgoblin/hourly` for the hourly export) |

> ⚠️ **File versioning must stay on _Overwrite existing data export file_.** With *Create new data export file*, AWS writes every refresh into its own `billing_period=YYYY-MM/<timestamp>-<execution-id>/` subfolder. CostGoblin only reads Parquet sitting directly in `billing_period=YYYY-MM/`, so it finds nothing to sync, and the setup wizard refuses such an export. If an existing export is on *Create new*, open it in **Data Exports → Edit** and switch it to Overwrite. Months delivered before the switch stay in their timestamped folders, which CostGoblin skips.

#### Keep the bucket from growing forever

The export never deletes anything: every month adds a billing period that stays in S3 indefinitely. The CloudFormation stack sets up the rules below itself. By hand, add an S3 **lifecycle rule** per export prefix (**S3 → your bucket → Management → Create lifecycle rule**, scope *Limit the scope of this rule using one or more filters*, prefix filter). The prefixes below are the stack's: `costgoblin/daily/`, `costgoblin/hourly/` and `costgoblin/cost-optimization/`. If your exports use other S3 path prefixes, use those, or the rules match nothing:

| Prefix | Expire current versions after | Why |
|--------|-------------------------------|-----|
| `costgoblin/daily/` | **400 days** | Daily `retentionDays` defaults to 365. A month's files are rewritten until its billing finalises, early the next month, so expiring at exactly 365 would drop the oldest month before it is a year old. |
| `costgoblin/hourly/` | **60 days** | Hourly `retentionDays` defaults to 30, and hourly is the large export, so this is where the rule actually saves money. |
| `costgoblin/cost-optimization/` | **100 days** | One snapshot folder per day; `retentionDays` defaults to 90. |

On each rule also tick **Delete incomplete multipart uploads** (7 days), and, if the bucket has S3 versioning enabled (unrelated to the export's *File versioning* setting), **Permanently delete noncurrent versions** (1 day): every overwrite turns the previous file into a noncurrent version that expiry never touches.

**Keep each expiry at or above that tier's `retentionDays`** (raise both together). Expiry never deletes anything CostGoblin has already downloaded — a period that disappears from the bucket stays on disk until it ages out of retention — but a fresh install or a teammate can only download what the bucket still holds.

<details>
<summary>Same rules from the CLI</summary>

`put-bucket-lifecycle-configuration` **replaces** the bucket's whole lifecycle configuration — merge in any rules you already have.

```bash
cat > lifecycle.json <<'JSON'
{"Rules": [
  {"ID": "costgoblin-daily", "Filter": {"Prefix": "costgoblin/daily/"}, "Status": "Enabled",
   "Expiration": {"Days": 400}, "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
   "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
  {"ID": "costgoblin-hourly", "Filter": {"Prefix": "costgoblin/hourly/"}, "Status": "Enabled",
   "Expiration": {"Days": 60}, "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
   "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
  {"ID": "costgoblin-cost-optimization", "Filter": {"Prefix": "costgoblin/cost-optimization/"}, "Status": "Enabled",
   "Expiration": {"Days": 100}, "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
   "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}
]}
JSON
aws s3api put-bucket-lifecycle-configuration --bucket your-company-billing --lifecycle-configuration file://lifecycle.json
```

</details>

#### Columns CostGoblin requires

Keeping **all columns** enabled is the simplest way to stay valid — the extras cost little in Parquet, and narrowing the export later leaves holes you can't backfill. For reference, these are the columns the app actually reads (a candidate export missing any of them is rejected by the setup wizard):

```
ChargePeriodStart, SubAccountId, SubAccountName,
BilledCost, EffectiveCost, ListCost, ContractedCost,
ServiceName, x_ServiceCode, ServiceCategory, RegionId, ResourceId,
ChargeCategory, PricingCategory, CommitmentDiscountStatus,
ChargeDescription, ConsumedQuantity, SkuMeter, Tags, x_Operation
```

All four FOCUS cost columns are always present in the export, so every cost metric is always available — there is no per-column "degraded metric" probing.

<details>
<summary><strong>Reference: which column backs which cost metric</strong></summary>

| Metric | Reads from | Meaning |
|--------|-----------|---------|
| Billed | `BilledCost` | The invoiced amount. Commitment-covered usage rows carry `0`; the invoiced fee sits on `ChargeCategory='Purchase'` rows. Use for invoice reconciliation. |
| Effective (amortized) | `EffectiveCost` | Amortized cost, including the **unused** portion of commitments (`CommitmentDiscountStatus='Unused'` rows). Matches Cost Explorer's amortized view. The default. |
| List price | `ListCost` | Hypothetical on-demand list price, restricted to `ChargeCategory='Usage'` rows (purchases/tax/credits have no list price). |
| Contracted | `ContractedCost` | Price after negotiated (e.g. EDP) discounts, before commitment discounts. `List − Contracted` is what your negotiated discount is worth. |

> **What happened to Unblended / Amortized / Net?** Those were CUR-era names: configs are migrated automatically (`unblended` → `billed`, `amortized`/`blended` → `effective`). The Net perspective is gone — FOCUS has no net cost columns; negotiated discounts are already netted into `BilledCost`/`ContractedCost`, with per-row detail in the `x_Discounts` map.

</details>

The S3 export should look like:
```
s3://bucket/prefix/<export-name>/
  data/
    billing_period=YYYY-MM/
      <export-name>-00001.snappy.parquet
  metadata/
    billing_period=YYYY-MM/
      <export-name>-Manifest.json
      <export-name>-Manifest-FOCUS.json
```

<a id="historical-data"></a>

> **Historical data:** a new export only includes data from creation day onward. Open an AWS Support case to request a backfill for the export — AWS can typically reload up to 12 months. The setup wizard's **Create one with CloudFormation** step shows the request ready to paste into the Support Center form, and on a Business support plan or above can file it for you.

### AWS Credentials

CostGoblin reads profiles from `~/.aws/config` and `~/.aws/credentials` — or from the files `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` point to, as the AWS CLI does. The wizard lists available profiles and lets you pick one.

**Using SSO:**

The app has a built-in SSO login button — click it next to your profile and CostGoblin will launch `aws sso login` for you. Or run it manually:
```bash
aws configure sso
aws sso login --profile your-profile-name
```

### GCP

GCP's billing data reaches CostGoblin through its native **FOCUS BigQuery export**. Because SQL cannot delete GCS objects — and stale export shards would silently inflate a month's totals — a small Cloud Run job in your own project copies each billing period into a bucket. CostGoblin then reads that bucket (plus your project and bucket lists while the wizard sets it up) and never calls BigQuery. Signed in as yourself with `gcloud auth application-default login`, though, it acts as you and can reach whatever your Google account can. On company or shared laptops, give it a read-only service account on the bucket and set `impersonateServiceAccount` — see [Credentials](scripts/gcp-focus-exporter/README.md#credentials) for how, and for what that does and does not confine.

[**scripts/gcp-focus-exporter**](scripts/gcp-focus-exporter/README.md) covers the whole path: enabling the export, deploying the job (Cloud Shell, local, or copy-paste), and the `costgoblin.yaml` entry that points the app at the result.

> On first run, pick **Google Cloud** on the setup screen. Once the exporter has run, the wizard browses your buckets the same way the AWS path browses S3 — pick the project (or type its ID, when your account can't list it or your organisation has too many to scan), the bucket, then the tier folder, and it writes the config for you. It refuses the exporter's parent prefix (pointing a tier there would read every tier's shards) and an `hourly` folder that overlaps `daily`. The wizard does not set `keyFile` or `impersonateServiceAccount`, so add those to the provider it wrote; hand-editing `costgoblin.yaml` stays available from the same screen.

## Features

- **S3 billing sync** — downloads FOCUS 1.2 parquet files into per-month partitions
- **Interactive dashboard** — pie charts, stacked bar charts, treemaps, and more, with drill-down into any dimension
- **Trends** — period-over-period comparison with bubble chart visualization, filterable by dimension with configurable thresholds
- **Findings** — surfaces AWS cost optimization recommendations (rightsize, delete unused, purchase SPs/RIs) with effort estimates and savings projections
- **Missing Tags** — identifies untagged resources by taggability, with Slack/Jira copy and CSV export
- **Explorer** — browse raw line items with configurable columns, filters, and sorting
- **Filter by any dimension** — account, service, region, team, product, environment, or custom tags
- **Custom dimensions** — map any AWS tag to a first-class cost allocation dimension
- **Tag normalization** — aliases applied at query time, fix messy tags without re-processing
- **Composable views** — drag-and-drop widget builder with 9 widget types (pie, bar, stacked bar, line, treemap, heatmap, bubble, table, summary)
- **Cost Scope** — configure cost metrics (effective, billed, list price, contracted) and exclusion rules
- **MCP server** — Model Context Protocol integration for querying cost data from AI assistants (opt-in, off by default: enable it under Settings → AI Assistant; clients authenticate with an `Authorization: Bearer` token). Tool results carry values that anyone who can tag your cloud resources or edit a shared config file can write, so treat them as untrusted input: markdown and CSV output escape `|` and line breaks to keep tables intact, but that does not stop prompt injection. Set your AI client to require approval before it runs tools with side effects.
- **Dark/light mode** — theme toggle with two chart color palettes (standard + colorblind-safe), each tuned for both themes; a series keeps its color across every chart
- **Update notifications** — release builds check GitHub Releases once at launch and prompt when a new version is out; download and install are one click each, never unconfirmed. Turn the launch check off under Settings → General or with `COSTGOBLIN_DISABLE_UPDATE_CHECK=1` (see [Install](#install))
- **CSV export** — export any view for reporting
- **Works offline** — once synced, no internet needed

## Security & data at rest

Everything CostGoblin keeps locally is **stored unencrypted** under its app data directory — for example the downloaded billing Parquet (`workspaces/<name>/data/<provider>/raw/<tier>-YYYY-MM/`) and the rollups built from it, DuckDB spill files in `workspaces/<name>/temp/`, cached account names and tags in `workspaces/<name>/state/`, and the YAML config in `workspaces/<name>/config/`. There is no application-level encryption: anyone who can read those files can read your billing history.

The app data directory of a release build is:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/costgoblin/` |
| Windows | `%APPDATA%\costgoblin\` |
| Linux | `~/.config/costgoblin/` (or `$XDG_CONFIG_HOME/costgoblin/`) |

A development run (`make dev`, `make prod` or `npm run dev`) uses a folder named `@costgoblin/desktop` in place of `costgoblin`. `COSTGOBLIN_USER_DATA_DIR` moves the whole directory elsewhere, and `COSTGOBLIN_DATA_DIR` / `COSTGOBLIN_CONFIG_DIR` switch to a pinned, non-workspace layout; everything below applies wherever the data ends up.

What protects that data is the operating system, so treat these as requirements:

- **Full-disk encryption** — FileVault (macOS), BitLocker (Windows) or LUKS (Linux). Without it, anyone holding a lost or stolen laptop's disk can read the billing data. Require it on every machine that runs CostGoblin.
- **A user-only data directory** — the app data directory is created readable only by your own account (on Windows, `%APPDATA%` is restricted to you by its ACLs). That keeps out other non-admin users of the same machine; it does not keep out an administrator or software running as you.
- **No unencrypted copies** — keep the directory out of unencrypted backups and out of cloud-sync folders, or they carry a readable copy somewhere else.

Secrets are written with file mode `0600` (owner read/write only): `mcp-auth-token` at the root of the app data directory, and in each workspace's `config/` the peer-sharing files `peer-identity.json`, `peer-sharing.json` and `peer-source.json` (your private key, your sharing access secret, and a teammate's sharing key). Windows ignores that mode, so there those files rely on the directory's ACLs alone. Every other file is written with default permissions.

Because `config/` holds those peer secrets, **share individual YAML files** (`costgoblin.yaml`, `dimensions.yaml`, …) with teammates or in version control — never the whole `config/` directory.

## Architecture

```
packages/
  core/     @costgoblin/core — DuckDB queries, S3 sync, config (no framework deps)
  ui/       @costgoblin/ui — React components (visx charts, Tailwind, shadcn/ui)
  desktop/  Electron shell — imports core and ui
  mcp/      @costgoblin/mcp — Model Context Protocol server for AI assistant integration
```

- **DuckDB** for analytical queries over local Parquet files
- **Electron** for cross-platform desktop app
- **React 19** + **visx** (D3 primitives as React components) for charts
- **Tailwind CSS v4** for styling

## Development

```bash
make help       # show available commands
make dev        # launch Electron in dev mode
make prod       # build, then launch the production bundle
make deps       # reinstall dependencies if package-lock.json changed
make test       # run vitest
make lint       # run tsc + eslint
make reset      # wipe app data, restart with wizard
```

## Backed by

CostGoblin is free and open source — kept that way with the help of companies that support open-source projects:

- **[Sentry](https://sentry.io)** — error monitoring, via their [open-source program](https://sentry.io/for/open-source/)
- **[SonarCloud](https://sonarcloud.io)** — code quality & static analysis
- **[Gitar](https://gitar.ai)** — AI code review, via their [free plan for open source](https://gitar.ai/pricing)
- **[GitHub](https://github.com)** — repository hosting & CI
- **[Cloudflare](https://www.cloudflare.com)** — website hosting & CDN

## Contributing

Pull requests are welcome. Contributors sign a short [Contributor License Agreement](./CLA.md) once, in their first pull request: you keep the copyright in your work, and the maintainer can keep offering the commercial license described below. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

CostGoblin is licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only). See [`LICENSE`](./LICENSE) for the full text.

In short:
- You can use, modify, and redistribute CostGoblin freely.
- If you distribute modified versions, or make them available over a network (e.g. host a fork as a service), you must publish your modifications under the same license.
- Commercial use is permitted; what the AGPL prevents is closed-source forks and undisclosed SaaS re-hosting.

If you want to embed CostGoblin in a closed-source product or ship it under different terms, a commercial license is available on request — contact the author.
