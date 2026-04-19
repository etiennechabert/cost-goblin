# CostGoblin

Cloud cost visibility that runs on your machine. No servers, no SaaS fees, no third-party data sharing.

CostGoblin is a desktop app that syncs your AWS billing data locally and queries it with DuckDB. Filter, drill down, and slice costs by any dimension — from a plane at 10,000 meters.

## Quick Start

```bash
npm install
make dev
```

On first launch, the setup wizard guides you through connecting to your AWS CUR data.

## Prerequisites

- **Node.js** 22+
- **AWS CUR 2.0** report exported as Parquet to S3

### Setting Up a CUR Report

If you don't have a CUR report yet, create one in the [AWS Console](https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html):

| Setting | Value |
|---------|-------|
| Report type | CUR 2.0 |
| Time granularity | Daily |
| Additional content | Include resource IDs |
| Format | Parquet |

**Required columns:**

| Column | Purpose |
|--------|---------|
| `line_item_usage_start_date` | Date partitioning |
| `line_item_usage_account_id` | Account dimension |
| `line_item_usage_account_name` | Account display name |
| `line_item_unblended_cost` | Primary cost metric (Unblended) |
| `line_item_line_item_type` | Charge type (Usage/Fee/Credit/Tax) — drives Cost Scope exclusion rules |
| `line_item_line_item_description` | Line item description |
| `line_item_operation` | AWS operation |
| `line_item_usage_type` | Usage details |
| `line_item_usage_amount` | Usage quantity |
| `line_item_resource_id` | Resource ARN (missing tags analysis) |
| `product_servicecode` | AWS service (e.g. AmazonEC2) |
| `product_product_family` | Service family (e.g. Compute Instance) |
| `product_region_code` | AWS region |
| `pricing_public_on_demand_cost` | On-demand list price |
| `resource_tags` | Tag key-value pairs |

**Optional cost-metric columns** — enable these to unlock the full Cost Scope metric picker:

| Column | Unlocks | Notes |
|--------|---------|-------|
| `line_item_blended_cost` | **Blended** metric | Usually shipped by default; absent only in stripped-down exports. If missing, Blended silently falls back to Unblended. |
| `reservation_effective_cost` | **Amortized** metric (RI portion) | Ships only when **Include Resource IDs** is enabled on the CUR report. |
| `savings_plan_savings_plan_effective_cost` | **Amortized** metric (SP portion) | Ships only with **Include Resource IDs**. Note the double prefix — AWS's snake_case conversion of `savingsPlan/SavingsPlanEffectiveCost`. |

The app probes your parquet schema on first launch and shows a warning in the Cost Scope view if Amortized is degraded — no error, but the view falls back to Unblended for rows that would otherwise carry an effective-cost value.

**How to enable `Include Resource IDs`:**

AWS Billing → Cost and Usage Reports → your report → **Edit** → check *Include resource IDs*. CUR reports are immutable, so the edit typically requires creating a new report pointed at the same (or a fresh) S3 prefix. Allow one billing cycle for the columns to appear in the data.

The S3 export should look like:
```
s3://bucket/prefix/
  data/
    BILLING_PERIOD=YYYY-MM/
      *.snappy.parquet
  metadata/
    BILLING_PERIOD=YYYY-MM/
      manifest.json
```

### AWS Credentials

CostGoblin reads profiles from `~/.aws/config` and `~/.aws/credentials`. The wizard lists available profiles and lets you pick one.

**Using SSO:**
```bash
aws configure sso
aws sso login --profile your-profile-name
```

**Without giving the app S3 access:**
Skip the wizard and download CUR data manually:
```bash
aws s3 sync s3://your-bucket/path/to/cur/ ~/Library/Application\ Support/@costgoblin/desktop/data/raw/
```
Then use the Data tab to repartition the downloaded files.

## Features

- **S3 billing sync** — downloads CUR parquet files, repartitions into optimized daily Hive partitions
- **Interactive dashboard** — pie charts for accounts/services/tags, stacked daily histogram, drill-down
- **Filter by any dimension** — account, service, region, team, product, environment, or custom tags
- **Tag normalization** — aliases applied at query time, fix messy tags without re-processing
- **Service drill-down** — click through service → service family breakdowns
- **Period-over-period comparison** — vs previous period delta on the summary card
- **CSV export** — export any view for reporting
- **Works offline** — once synced, no internet needed

## Architecture

```
packages/
  core/     @costgoblin/core — DuckDB queries, S3 sync, config (no framework deps)
  ui/       @costgoblin/ui — React components (visx charts, Tailwind, shadcn/ui)
  desktop/  Electron shell — imports core and ui
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

## License

MIT
