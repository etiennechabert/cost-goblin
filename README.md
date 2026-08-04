<p align="center">
  <img src="docs/goblin.png" alt="CostGoblin" width="128">
</p>

<h1 align="center">CostGoblin</h1>

<p align="center">
  Cloud cost visibility that runs on your machine.<br>
  No servers, no SaaS fees, no third-party data sharing.
</p>

<p align="center">
  <a href="https://github.com/etiennechabert/cost-goblin/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D%2024-339933.svg?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Electron-41-47848F.svg?logo=electron&logoColor=white" alt="Electron">
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

The app auto-updates when a new version is available.

## Quick Start

```bash
npm install
make dev
```

On first launch, the setup wizard guides you through connecting to your AWS billing data.

## Prerequisites

- **Node.js** 24+
- At least one billing source:
  - **AWS** — a FOCUS 1.2 Data Export delivered as Parquet to S3 (below)
  - **GCP** — the native FOCUS BigQuery export, copied into a GCS bucket by [the FOCUS exporter](scripts/gcp-focus-exporter/README.md)

A workspace can configure several providers at once; totals sum across them and a `provider` dimension splits them apart.

### Setting Up a FOCUS 1.2 Export

CostGoblin reads the **FOCUS 1.2** table via AWS Data Exports. To create one:

1. In the AWS console, open **Billing and Cost Management**.
2. In the left navigation, choose **Data Exports** ([direct console link](https://us-east-1.console.aws.amazon.com/costmanagement/home#/bcm-data-exports)).
3. Click **Create export** and select **FOCUS 1.2** as the data table (`FOCUS_1_2_AWS`), with the settings below.

> ⚠️ Don't create the report from the legacy **Cost & Usage Reports** page, and don't pick the CUR 2.0 table — CostGoblin's schema is FOCUS 1.2. A correct export delivers Parquet files under `data/` and `metadata/` folders, partitioned by `billing_period=`.

**Export settings:**

| Setting | Value |
|---------|-------|
| Export type | **Standard data export** (table: `FOCUS_1_2_AWS`) |
| Time granularity | Daily (create an optional second export with Hourly for intraday drill-down) |
| Column selection | **All columns** |
| Format | Parquet |
| Compression | Snappy |
| Overwrite | Overwrite existing data export file |

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

> **Historical data:** a new export only includes data from creation day onward. Open an AWS Support case to request a backfill for the export — AWS can typically reload up to 12 months.

### AWS Credentials

CostGoblin reads profiles from `~/.aws/config` and `~/.aws/credentials`. The wizard lists available profiles and lets you pick one.

**Using SSO:**

The app has a built-in SSO login button — click it next to your profile and CostGoblin will launch `aws sso login` for you. Or run it manually:
```bash
aws configure sso
aws sso login --profile your-profile-name
```

**Without giving the app S3 access:**
Skip the wizard and download the export data manually:
```bash
aws s3 sync s3://your-bucket/path/to/focus-export/ ~/Library/Application\ Support/@costgoblin/desktop/data/raw/
```
Then use the Data tab to register the downloaded files.

### GCP

GCP's billing data reaches CostGoblin through its native **FOCUS BigQuery export**. Because SQL cannot delete GCS objects — and stale export shards would silently inflate a month's totals — a small Cloud Run job in your own project copies each billing period into a bucket. CostGoblin then reads that bucket and never holds credentials that can reach BigQuery.

[**scripts/gcp-focus-exporter**](scripts/gcp-focus-exporter/README.md) covers the whole path: enabling the export, deploying the job (Cloud Shell, local, or copy-paste), and the `costgoblin.yaml` entry that points the app at the result.

> The setup wizard is AWS-only for now, so a GCP provider is added by editing `costgoblin.yaml` — use **Data Management → Generate config templates & open folder**, which scaffolds a template containing a commented-out GCP block.

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
- **Vault encryption** — optional AES-256-GCM at-rest encryption for local billing data, with system keychain integration
- **MCP server** — Model Context Protocol integration for querying cost data from AI assistants
- **Dark/light mode** — theme toggle with two chart color palettes (standard + Okabe-Ito colorblind-safe)
- **Auto-updates** — the app checks for new versions on startup and installs them automatically
- **CSV export** — export any view for reporting
- **Works offline** — once synced, no internet needed


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
make test       # run vitest
make lint       # run tsc + eslint
make reset      # wipe app data, restart with wizard
```

## Backed by

CostGoblin is free and open source — kept that way with the help of companies that support open-source projects:

- **[Sentry](https://sentry.io)** — error monitoring, via their [open-source program](https://sentry.io/for/open-source/)
- **[SonarCloud](https://sonarcloud.io)** — code quality & static analysis
- **[GitHub](https://github.com)** — repository hosting & CI
- **[Cloudflare](https://www.cloudflare.com)** — website hosting & CDN

## License

CostGoblin is licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only). See [`LICENSE`](./LICENSE) for the full text.

In short:
- You can use, modify, and redistribute CostGoblin freely.
- If you distribute modified versions, or make them available over a network (e.g. host a fork as a service), you must publish your modifications under the same license.
- Commercial use is permitted; what the AGPL prevents is closed-source forks and undisclosed SaaS re-hosting.

If you want to embed CostGoblin in a closed-source product or ship it under different terms, a commercial license is available on request — contact the author.
