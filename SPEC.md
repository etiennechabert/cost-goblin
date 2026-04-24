# CostGoblin — Product Specification v1

> Cloud cost visibility that runs on your machine. No servers, no SaaS fees, no sending your billing data to a third party.
>
> **For development instructions, see `CLAUDE.md`.** This document defines WHAT to build. CLAUDE.md defines HOW to work.

## Vision

CostGoblin is a desktop application that gives engineering and finance teams full visibility into their cloud spending. It syncs billing data locally, queries it with DuckDB, and renders an analytical UI — all on the user's laptop. No infrastructure to run, no accounts to create, no third-party dependencies.

Named after the mythical creatures who guard treasure vaults and account for every coin — CostGoblin knows every dollar in yours.

### Business Model (Future)

- **Free**: Desktop app. Full cost exploration, local data, runs on your machine.
- **Paid** (deferred): Cloud platform. Automated anomaly detection, collaborative triage, scheduled reports, AI insights, shared dashboards. Requires server infrastructure — that's what the user pays for.

This spec covers the **free desktop app** only. The architecture is designed so the core logic can be shared with a future web backend.

### Feature Tiering

This document tags every feature with one of:

- **MVP** — built, shipping today. Behavior must match this spec.
- **v1** — committed for the next milestone. Design is set, code is partial or planned.
- **Maybe Later** — designed for, not built. Documented so future work doesn't paint into a corner. May be deferred indefinitely.

When a feature changes tier (MVP → done means it stays MVP; v1 → MVP when shipped; Maybe Later → v1 when prioritized), update this spec in the same change.

---

## Architecture

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop shell | Electron | Cross-platform desktop app (macOS + Windows) |
| Frontend | React 19 + TypeScript | Shared UI components |
| Core library | TypeScript (npm package) | DuckDB queries, S3 sync, cost logic, config |
| Query engine | DuckDB (Node.js bindings) | Analytical queries over local Parquet files |
| Local config | YAML files | Organization-shared configuration (versionable in git) |
| Local preferences | JSON file | Per-user UI state (theme, last view, hidden columns) |
| App state | JSON files | Sync manifest, telemetry outbox |
| Data format | Apache Parquet | Cloud billing data stored locally |
| AWS | `@aws-sdk/client-s3`, `@aws-sdk/client-organizations` | S3 access + AWS Organizations sync |

### Monorepo Structure

```
costgoblin/
  data/                  # .gitignore'd — real data for development only
    .gitkeep
    .gitignore
    raw/                 # real Parquet files (NEVER committed)
  packages/
    core/                # @costgoblin/core — pure TypeScript, no framework dependency
      src/
        query/           # DuckDB query builder + execution + LRU cache
        sync/            # S3 sync engine + repartitioning
        config/          # YAML config loader + validator
        normalize/       # Tag normalization + alias resolution (query-time)
        models/          # Org tree traversal, cost math
        types/           # Shared TypeScript types, branded types
        logger/          # Structured logger
        __fixtures__/    # Synthetic Parquet + config + generator
        __tests__/       # Core logic tests
    desktop/             # Electron shell — imports @costgoblin/core
      src/
        main/            # Electron main process: IPC handlers, DuckDB, S3 sync, AWS Org client, auto-sync
        preload/         # IPC bridge (contextBridge.exposeInMainWorld)
        renderer/        # React app entry point
    ui/                  # @costgoblin/ui — shared React components
      src/
        views/           # Full page views
        components/      # Reusable chart, table, filter, modal components
        hooks/           # Data fetching hooks against CostApi interface
        api/             # CostApi interface re-export + provider
        lib/             # Palette, utils, dimension helpers
        __fixtures__/    # MockCostApi + fixture data
        __tests__/       # Component tests
    web-backend/         # (Maybe Later) Express/Fastify server — imports @costgoblin/core
```

### Data Access Layer

The frontend codes against an abstract `CostApi` interface. The desktop app implements it via Electron IPC. A future web mode would implement it via HTTP.

```typescript
interface CostApi {
  // Cost queries
  queryCosts(params: CostQueryParams): Promise<CostResult>;
  queryDailyCosts(params: DailyCostsParams): Promise<DailyCostsResult>;
  queryTrends(params: TrendQueryParams): Promise<TrendResult>;
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult>;
  querySavings(): Promise<SavingsResult>;
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult>;
  getFilterValues(dimensionId, filters, dateRange?): Promise<{ value, label, count }[]>;

  // Sync
  getSyncStatus(syncId?): Promise<SyncStatus>;
  syncPeriods(files, syncId?): Promise<{ filesDownloaded; rowsProcessed }>;
  cancelSync(syncId?): Promise<void>;
  getDataInventory(tier?: DataTier): Promise<DataInventoryResult>;
  deleteLocalPeriod(period, tier?): Promise<void>;
  openDataFolder(): Promise<void>;

  // Auto-sync
  getAutoSyncEnabled(): Promise<boolean>;
  setAutoSyncEnabled(enabled): Promise<void>;
  getAutoSyncStatus(): Promise<AutoSyncStatus>;

  // AWS Organizations
  syncOrgAccounts(profile): Promise<OrgSyncResult>;
  getOrgSyncResult(): Promise<OrgSyncResult | null>;
  getOrgSyncProgress(): Promise<OrgSyncProgress | null>;
  getAccountMapping(): Promise<AccountMappingStatus>;

  // Config / dimensions
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getDimensionsConfig(): Promise<DimensionsConfig>;
  saveDimensionsConfig(config): Promise<void>;
  getOrgTree(): Promise<OrgNode[]>;
  discoverTagKeys(): Promise<{ tags: TagDiscoveryEntry[]; samplePeriod }>;

  // Setup
  getSetupStatus(): Promise<{ configured: boolean }>;
  testConnection(params): Promise<{ ok; error? }>;
  listAwsProfiles(): Promise<string[]>;
  listS3Buckets(profile): Promise<{ buckets; error? }>;
  browseS3(params): Promise<{ prefixes; isCurReport; detectedType; missingColumns }>;
  scaffoldConfig(): Promise<void>;
  writeConfig(config): Promise<void>;

  // Savings preferences
  getSavingsPreferences(): Promise<SavingsPreferences>;
  saveSavingsPreferences(prefs): Promise<void>;
}

// Desktop implementation lives in the preload script via contextBridge.exposeInMainWorld.
// The renderer never sees ipcRenderer directly.
```

The interface is exported from `@costgoblin/core/browser`. The renderer accesses it through a React context (`useCostApi()`) — never through globals — so component tests can swap in `MockCostApi`.

### Worker Thread Architecture

DuckDB and S3 sync run in dedicated worker threads so the main process stays responsive.

```
Main Process
  ├── DuckDB Worker Thread    # All query execution
  ├── S3 Sync Worker Thread   # Download + repartition
  └── Window (Renderer)       # React UI
```

- **DuckDB worker** owns the database exclusively. Queries arrive via structured-clone messages; results are serialized back to main. Connection pooling and prepared statement cache are internal to the worker.
- **Sync worker** runs S3 downloads and DuckDB repartitioning. Progress events stream back to main for UI updates. Cancellation propagates via `AbortController` signaling.
- Workers communicate via typed messages (`{ kind, id, ... }` discriminated unions). No `any` types cross the worker boundary.

### Electron Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: false` — target is `true` (v1) but blocked on tooling: `electron-vite` emits an ESM (`.mjs`) preload, and Electron's sandboxed loader is CJS-only. Switching requires either replacing the preload build with esbuild (which gets clobbered every time `electron-vite dev` rebuilds) or upstream electron-vite support for CJS preload output. The two flags above already prevent the main attack vectors; sandboxing is defense-in-depth on top.
- Preload uses `contextBridge.exposeInMainWorld` to expose only the typed `CostApi`.
- Renderer has zero Node imports. No `localStorage`/`sessionStorage` for app data — see Configuration System.

---

## Data Pipeline

### Source: Cloud Billing Exports

MVP targets **AWS Cost and Usage Reports (CUR 2.0)**, exported as Parquet to S3.

The architecture supports future providers via a normalization layer:

| Provider | Export Format | Storage | Status |
|----------|-------------|---------|--------|
| AWS | CUR 2.0 (Parquet) | S3 | MVP |
| AWS | Cost Optimization Hub recommendations (Parquet) | S3 | MVP |
| GCP | BigQuery billing export | BigQuery → Parquet | Maybe Later |
| Azure | Cost Management export | Blob Storage (Parquet/CSV) | Maybe Later |

### CUR 2.0 Report Configuration

When creating the CUR report in the AWS Console (Cost and Usage Reports → Create report), use these settings:

| Setting | Value |
|---------|-------|
| Table name | `CUR 2.0` |
| Time granularity | `Daily` (or `Hourly` for hourly tier) |
| Additional content | `Include resource IDs` |
| Billing view | `Primary View` |
| Format | `Parquet` |
| Compression | `Snappy` (default) |

**Required columns:**

| Column | Type | Purpose |
|--------|------|---------|
| `line_item_usage_start_date` | Timestamp | Date partitioning key |
| `line_item_usage_account_id` | String | Account dimension |
| `line_item_usage_account_name` | String | Account display name |
| `line_item_unblended_cost` | Number | Primary cost metric |
| `line_item_line_item_type` | String | Charge type |
| `line_item_line_item_description` | String | Line item description |
| `line_item_operation` | String | AWS operation |
| `line_item_usage_type` | String | Usage details |
| `line_item_usage_amount` | Number | Usage quantity |
| `line_item_resource_id` | String | Resource ARN |
| `product_servicecode` | String | AWS service |
| `product_product_family` | String | Service family |
| `product_region_code` | String | AWS region |
| `pricing_public_on_demand_cost` | Number | List price |
| `resource_tags` | Map | Tag key-value pairs |

CUR export structure in S3:

```
s3://bucket/prefix/
  data/
    BILLING_PERIOD=YYYY-MM/
      *.snappy.parquet
  metadata/
    BILLING_PERIOD=YYYY-MM/
      manifest.json
```

### S3 Sync

The user configures AWS credentials and bucket paths. The app syncs Parquet files to local storage.

**Three data tiers:**

| Tier | Granularity | Default Retention | Use Case |
|------|------------|-------------------|----------|
| Daily | 1 row per day per line item | 365 days | Long-term trends |
| Hourly | 1 row per hour per line item | 30 days | Short-term drill-down |
| Cost Optimization | One row per recommendation | Latest snapshot | Savings view (RI/SP, rightsizing) |

The hourly and cost-optimization tiers are optional. Daily is mandatory.

**Sync behavior (per-period, manifest-aware):**
- The Sync view computes a per-month inventory from S3 listings (file key + size + content hash).
- For each missing or stale period, the user (or auto-sync) triggers a per-period download via `syncPeriods()`.
- Download is delegated to `aws s3 sync` (subprocess), which handles concurrency, retries, and partial-file resume natively.
- Files land directly in `aws/raw/{tier}-{period}/` — **no repartitioning**, no DuckDB-side rewrite. The downloaded Parquet is the queried Parquet.
- Per-period etag manifests (`sync-etags-{tier}.json`) record what's locally present so re-sync can skip unchanged files.
- Tag columns are NOT pre-flattened at sync time. Queries extract from `resource_tags` map and apply aliases via SQL CASE expressions at query time.

**Local storage layout:**

```
~/Library/Application Support/costgoblin/     # macOS
%APPDATA%/costgoblin/                          # Windows
  config/                   # YAML — organization-shared, versionable
    costgoblin.yaml         # Providers, sync, defaults
    dimensions.yaml         # Dimensions + concepts + aliases
    org-tree.yaml           # Optional organizational hierarchy
  state/                    # JSON — app-managed
    sync-manifest.json      # S3 file hashes
    org-sync-result.json    # AWS Org snapshot
    preferences.json        # Per-user UI state (theme, palette, hidden cols, auto-sync toggle)
  data/
    aws/
      raw/
        daily-YYYY-MM/                  # One directory per billing period, downloaded as-is from S3
          *.parquet
        hourly-YYYY-MM/
          *.parquet
        cost-optimization-YYYY-MM/
          usage_date=YYYY-MM-DD/data.parquet   # Cost-opt is split by export date during sync
      sync-etags-daily.json             # Per-period file etags for diff
      sync-etags-hourly.json
      sync-etags-cost-optimization.json
```

**AWS Credentials:**

The app reads from existing AWS configuration in priority order:
1. AWS profile from `~/.aws/credentials` (user selects profile name in setup)
2. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
3. SSO / Identity Center (via AWS SDK's built-in flow)

No credentials are stored by the app — it delegates to the AWS SDK.

### Internal Schema

DuckDB queries run against a normalized internal schema. The normalizer maps provider-specific columns at sync time.

| Column | Type | Description |
|--------|------|-------------|
| `usage_date` | `DATE` | Day of usage |
| `usage_hour` | `TIMESTAMP` | Hour of usage (hourly tier only) |
| `account_id` | `VARCHAR` | Cloud account/project/subscription ID |
| `account_name` | `VARCHAR` | Friendly account name |
| `region` | `VARCHAR` | Cloud region |
| `service` | `VARCHAR` | Cloud service |
| `service_family` | `VARCHAR` | Service sub-category |
| `description` | `VARCHAR` | Line item description |
| `resource_id` | `VARCHAR` | ARN or resource identifier |
| `usage_amount` | `DOUBLE` | Quantity of usage |
| `cost` | `DOUBLE` | Primary cost metric |
| `list_cost` | `DOUBLE` | Public on-demand price |
| `line_item_type` | `VARCHAR` | Billing line item type |
| `usage_type` | `VARCHAR` | Usage type code |
| `operation` | `VARCHAR` | Operation type |
| `tag_{name}` | `VARCHAR` | One column per configured tag dimension |

Tags are flattened into top-level columns during normalization. **Aliases and normalization rules are applied at query time in SQL** — see Resolved Design Decisions.

---

## Configuration System

CostGoblin separates **organization-shared config** (YAML, can be checked into git, the same across teammates) from **per-user preferences** (JSON, machine-local, never shared).

### Organization Config (YAML)

Lives in `config/`. Edited from the app's Dimensions Editor (see Features). Atomic file writes. **The app is the only writer.** External edits while the app is running will be silently overwritten on the next app-driven save — this is intentional.

#### `costgoblin.yaml`

```yaml
providers:
  - name: aws-main
    type: aws
    credentials:
      profile: my-aws-profile
    sync:
      daily:
        bucket: s3://my-cur-bucket/daily/
        retentionDays: 365
      hourly:                              # optional
        bucket: s3://my-cur-bucket/hourly/
        retentionDays: 30
      costOptimization:                    # optional, MVP
        bucket: s3://my-cur-bucket/cost-opt/

defaults:
  periodDays: 30
  costMetric: unblended_cost
  lagDays: 1

cache:
  ttlMinutes: 30
```

#### `dimensions.yaml`

```yaml
builtIn:
  - name: account
    label: "Account"
    field: account_id
    displayField: account_name
  - name: region
    label: "Region"
    field: region
  - name: service
    label: "Service"
    field: service
  - name: service_family
    label: "Service Family"
    field: service_family

tags:
  - tagName: "org:team"
    label: "Team"
    concept: owner
    normalize: lowercase-kebab
    fallbackTag: "team-from-account"      # When tag is missing on the row, fall back to this AWS-Org account tag
    missingValueTemplate: "no-team-{accountId}"
    aliases:
      core-banking: [core_banking, corebanking, CoreBanking]
      platform: [platform-team, platform_team]

  - tagName: "org:service-name"
    label: "Service"
    concept: product
    separator: "/"
    normalize: lowercase

  - tagName: "org:environment"
    label: "Environment"
    concept: environment
    normalize: lowercase
    aliases:
      production: [prod, prd]
      staging: [stg, stage, pre-prod]
      development: [dev, develop]
```

#### Concepts

Three behavioral hooks that change how the app treats a dimension:

| Concept | Behavior | Limit |
|---------|----------|-------|
| `owner` | Gets the organizational tree. Costs roll up through hierarchy. The "who pays" axis. | One dimension only |
| `product` | Cost driver analysis. Supports `separator` for lightweight hierarchy. The "what costs" axis. | One dimension only |
| `environment` | Cross-cutting filter chip on every view. Not a primary grouping dimension. | One dimension only |

Dimensions without a concept are regular groupable dimensions.

#### `org-tree.yaml`

Applies to whichever dimension is marked `concept: owner`.

```yaml
tree:
  - name: "Company"
    virtual: true
    children:
      - name: "Engineering"
        virtual: true
        children:
          - name: "core-banking"
          - name: "payments"
          - name: "platform"
      - name: "SRE"
        children:
          - name: "sre-emea"
          - name: "sre-us"
```

- A real (non-virtual) node matches a tag value after normalization + alias resolution.
- A virtual node's cost = sum of all descendant real nodes' costs.
- Tag values not in the tree show as "unassigned."
- If no tree is defined, costs display flat by tag value.

### Per-User Preferences (JSON)

Lives in `state/preferences.json`. Loaded at app startup. Read/written through IPC.

```json
{
  "theme": "dark",
  "colorPalette": "standard",
  "lastView": "overview",
  "windowSize": { "width": 1280, "height": 800 },
  "hiddenColumns": { "savings": ["region"] },
  "autoSync": true,
  "savings": { "hiddenActionTypes": ["Rightsize"] }
}
```

This file is **per-machine, per-user**. It is not shared across the team. It must not contain organization data.

> **Migration note (v1):** Theme is currently in `localStorage` ([App.tsx](packages/desktop/src/renderer/App.tsx)). Move to `preferences.json` via IPC. The renderer must not use `localStorage` or `sessionStorage` for any application state.

### File Editing Policy

- **Org config** — edited via the Dimensions Editor (see Features). Atomic writes. App is the sole writer at runtime; external edits during runtime will be silently overwritten on the next save. External edits while the app is closed are loaded normally on next startup.
- **Per-user preferences** — written through IPC handlers in the main process. Atomic writes.
- **No file watchers.** No file locks. No hot-reload.
- For shared org config across teammates, the workflow is git: commit YAML changes, others pull and restart the app.

---

## Features

### MVP — Shipping Today

#### Feature: Setup Wizard (MVP)

First-run experience that guides the user through initial configuration.

**Flow:**
1. **AWS profile selection** — list profiles from `~/.aws/credentials`. User picks one.
2. **S3 bucket discovery** — list buckets accessible to the selected profile. User picks the CUR bucket.
3. **Prefix browsing** — browse the bucket's prefixes. The app inspects each prefix and detects whether it looks like a CUR 2.0 export (presence of `manifest.json`, required columns in the Parquet schema). Detected type is shown: `daily`, `hourly`, `cost-optimization`, or `unknown`.
4. **Tier selection** — user assigns each detected prefix to a tier (daily required; hourly and cost-optimization optional).
5. **Tag discovery (optional)** — sample a Parquet file to list available tag keys with their coverage. User picks which to track and assigns labels.
6. **Initial sync** — full download with progress bar. Periods download in parallel within a configurable limit.
7. **Ready** — navigate to Sync view to confirm data is loaded, then to the Cost Overview.

The wizard writes `costgoblin.yaml` and a starter `dimensions.yaml`. The org tree is added later via the Dimensions Editor or by editing YAML.

#### Feature: Cost Overview Page (MVP)

The home screen — organization-wide cost data.

**Layout:**
- Top bar: current period indicator, sync status, "Sync Now" button.
- Dimension selector: toggle between any configured dimension.
- Environment filter chips (when an environment concept is configured).
- Sortable table with entity rows + cost columns (one per top-N service, plus total).
- Header row: organization total + per-service totals.
- CSV export.

**Behavior:**
- Default sort: total cost descending.
- Service columns are the top N services by total spend across all entities.
- Clicking an entity navigates to its detail view.
- Virtual org-tree nodes show with rollup costs and a drill-down arrow.

#### Feature: Cost Trends View (MVP)

Compares costs between the current period and the previous equivalent period.

**Layout:**
- Filters: owner dropdown, dimension toggle, direction toggle (Increases / Savings).
- Threshold controls: absolute delta slider ($), percentage change slider (%).
- Summary: count and dollar total of items above thresholds.
- Bubble visualization: each bubble is an entity with significant change, sized by dollar impact.

**Behavior:**
- Shows only items exceeding both thresholds.
- Clicking a bubble navigates to entity detail.

#### Feature: Missing Tags View (MVP)

Identifies cloud resources lacking cost-allocation tags.

**Layout:**
- Filters: owner dropdown, account dropdown.
- Threshold control: minimum cost slider ($).
- Summary: total untagged cost + resource count.
- Table: account, closest owner match, resource ID, service, family, cost.

**Behavior:**
- Sorted by cost descending.
- "Closest owner match" infers from account-level metadata when available.

#### Feature: Entity Detail View (MVP)

Deep-dive into one entity (team, product, account, etc.). Reached by clicking an entity name anywhere.

**Layout:**
- **Row 1:** Summary card (total + delta vs previous period) + daily histogram with dimension toggle (sub-entities, services).
- **Row 2:** Environment filter chips (when configured).
- **Row 3:** Up to three pie/donut charts (accounts, sub-entities, services).
- **Row 4:** Breakdown table (full line-item detail).
- **Row 5:** CSV export.

#### Feature: Granularity Toggle (MVP)

For any time-series visualization, switch between daily and hourly granularity when both tiers are configured.

**Behavior:**
- Daily is the default (365 days available).
- Hourly available only if configured. The toggle hides entirely if hourly is not configured (no grayed-out tease).
- Hourly auto-constrains the date-range picker to 7 days.

#### Feature: Query Cache (MVP)

In-memory LRU cache keyed on query parameters.

**Behavior:**
- Configurable TTL (default 30 minutes).
- Invalidated automatically after sync completes.
- "Clear Cache" option in the app menu.

#### Feature: Filter Bar + Entity Pop-up (MVP)

See [Interaction Model](#interaction-model) below.

#### Feature: Dark Mode + Color Palette (MVP)

Dark mode default, light available. Two chart palettes: standard and Okabe-Ito (colorblind-safe). Toggled in the title bar; persisted in `preferences.json` (v1 — currently `localStorage`).

#### Feature: Dimensions Editor (MVP)

In-app editor for `dimensions.yaml`. Replaces the spec's earlier "open YAML in your editor" flow.

**Layout:**
- One panel per tag dimension showing tag name, concept, normalize rule, aliases, fallback tag, and missing-value template.
- "Add tag dimension" picker populated by `discoverTagKeys()` — sampled from the most recent Parquet file with row count, distinct count, and coverage percentage.
- Aliases edited as plain text (`canonical: alt1, alt2`), parsed into the typed config on save.
- Fallback-tag picker shows available AWS-Org account tags (from the AWS Organizations sync) so the user can fill missing row-level tags from account-level metadata.

**Behavior:**
- Save writes the entire `DimensionsConfig` atomically through `saveDimensionsConfig()`.
- Query cache invalidates on save.
- No reload prompt — the new config takes effect immediately for subsequent queries.

#### Feature: AWS Organizations Integration (MVP)

Pulls account/OU/tag metadata from the AWS Organizations API. Used for:
- Account-name resolution in the UI (no need to memorize 12-digit account IDs).
- The `fallbackTag` mechanism in dimensions: when a row's owner tag is missing, the matching account-level tag fills in.
- The Sync view's account-mapping panel.

**Sync behavior:**
- Triggered manually from the Sync view.
- Discovers all accounts, OU paths, and tags via `ListAccounts` + `ListOrganizationalUnitsForParent` + `ListTagsForResource`.
- Stored in `state/org-sync-result.json`.
- Progress streamed by phase (`accounts`, `ous`, `tags`) and item count.
- Requires the `organizations:List*` and `organizations:Describe*` IAM permissions on the management or delegated-admin account.

#### Feature: Auto-Sync (MVP)

Background CUR sync while the app is open.

**Behavior:**
- Toggleable from the Sync view; persisted in `preferences.json`.
- When enabled, periodically (default 60 minutes — configurable in `costgoblin.yaml`) checks the inventory for missing or stale periods within the retention window and downloads them.
- Status surfaced in the title bar: `disabled`, `idle`, `checking`, `syncing` (with phase + progress), or `error`.
- Single-instance gate: only one auto-sync run at a time; manual sync interlocks.

#### Feature: Sync View / Data Inventory (MVP)

Replaces the spec's earlier "sync status indicator." A full view showing:
- Per-tier table of months (daily, hourly, cost-optimization) with local status (`missing`, `repartitioned`, `stale`).
- Per-month sync, delete, and inspect actions.
- Disk usage, oldest/newest period, total remote vs. local sizes.
- A nav badge on "Sync" shows the count of missing periods within the retention window.
- AWS Organizations panel (sync, view accounts, browse OU paths, inspect account tags).

#### Feature: Savings View + Cost Optimization Tier (MVP)

Surfaces AWS Cost Optimization Hub recommendations (Reserved Instances, Savings Plans, rightsizing) downloaded from the cost-optimization tier.

**Layout:**
- Sortable table: account, action type, resource, monthly cost, monthly savings, savings %, effort.
- Effort-coloured chips (Very Low / Low / Medium / High).
- Per-row expand panel: parsed recommendation `configuration` and `costCalculation.usages` (e.g., suggested instance config, current usage).
- "Hide action type" toggles per category (e.g., hide all Rightsize) — persisted in `preferences.json` via `SavingsPreferences`.

**Behavior:**
- Pulls from the latest cost-optimization Parquet snapshot.
- Recommendations are read-only — the app does not apply them.

### v1 — Planned Next

#### Worker Threads (v1)

Move DuckDB and S3 sync into Electron worker threads. See [Worker Thread Architecture](#worker-thread-architecture-v1).

#### Move Theme/Palette to `preferences.json` (v1)

Eliminate the renderer's `localStorage` usage. Add IPC handlers `getPreference(key)` / `setPreference(key, value)` and migrate theme + palette + any other UI prefs to the per-user preferences file.

#### Local Budgets (v1)

- Annual budget per owner team, stored in `state/budgets.json`.
- Budget-vs-actual card in entity detail view for owner entities.
- Visualization: progress bar with positive/negative coloring.
- Uses the dimension marked `concept: owner`.

### Maybe Later — Designed For, Not Built

These features are explicitly NOT planned but the architecture accounts for them. They represent the paid tier or future work.

#### View Templates (Maybe Later)

Pluggable widget layouts per concept (`views.yaml`). The default hardcoded layouts are working well; this becomes valuable when users want per-team customization or when we want to ship layouts as templates.

```yaml
viewTemplates:
  owner:
    rows:
      - widgets:
          - { type: summary, size: small }
          - { type: histogram, groupBy: product, size: large }
      - widgets:
          - { type: distribution, groupBy: account }
          - { type: distribution, groupBy: childOwner }
      - widgets:
          - { type: table, columns: [product, service, serviceFamily, description, cost] }
```

#### Smart Alias Suggestions (Maybe Later)

On first sync, fuzzy-match unique tag values to suggest aliases ("prod" + "prd" + "production" → group as `production`). Replaced for now by the manual Dimensions Editor, which works well.

#### Auto-Update via electron-updater (Maybe Later)

Silent background update checks against GitHub Releases. Subtle indicator on the settings icon. User-controlled restart.

#### Telemetry — Opt-in (Maybe Later)

Three channels (usage analytics, crash reporting, performance metrics). All opt-in, defaulted off, fully auditable. Implementations: PostHog (analytics) + Sentry (crashes + performance) with `beforeSend` hooks stripping PII.

Data principles when built:
- No cost data, tag values, account IDs, team names, or business data ever leaves the machine.
- Telemetry payloads are logged locally so the user can audit exactly what's sent.
- All endpoints configurable for self-hosted collectors.

#### Automated Anomaly Detection (Maybe Later — Paid)

Server-side scheduler running statistical analysis on (product × service) combinations. P10/P90 bands, rolling averages, potential savings. Triage workflow with comments, status, Jira links.

#### Scheduled Reports (Maybe Later — Paid)

Monthly budget reports via email. PDF generation stored in S3.

#### Collaborative Features (Maybe Later — Paid)

Shared baselines, comments, status workflows, shareable view links, team dashboards.

#### Multi-Cloud (Maybe Later)

GCP billing export and Azure cost-management export, with normalizers mapping into the internal schema.

---

## Interaction Model

### Global Filter Bar

The filter bar is the single source of truth for the current view state. It sits at the top of every page. Every widget on the page reflects the active filters.

**Layout:**
```
[Account ▾] [Region ▾] [Service ▾] [Svc Family ▾] [Team ▾] [Product ▾] [Env ▾] ... [✕ Clear all]
```

- One chip per dimension (built-in or tag-based).
- Unset chips show the dimension label, muted style.
- Active chips show the selected value, highlighted.
- Clicking an unset chip opens a dropdown with distinct values, sorted by cost descending.
- **Dropdown values cascade**: computed from currently filtered data, so picking Team narrows the Service dropdown.
- Active chips can change value or clear.

### Three Ways to Set a Filter

1. **Click a chip** → dropdown → select.
2. **Click a widget element** (pie slice, bar segment, bubble) → entity pop-up.
3. **Click a row in the breakdown table** → set ALL dimension chips for that row at once.

### Entity Pop-Up

When a user clicks any widget element, a side panel opens showing:

- Entity name + total cost for the period.
- Mini histogram: daily trend.
- Top 5 sub-items.

Actions:
- **"Set as filter"** — closes the pop-up, sets the chip, page updates.
- **"Open full view"** — navigates to entity detail.
- **"✕ Close"** — dismisses without changing state.

### Table Row Click (Precision Zoom)

Breakdown table rows are intersections of multiple dimensions. Clicking a row sets ALL chips at once, snapping the page to that exact slice. The user then removes individual chips to broaden the view ("Is this EC2 spike just core-banking, or all teams?" → remove the Team chip).

### Table Cell Click

Individual cells in dimension columns open the entity pop-up for that one value (same UX as clicking a pie slice).

### Default View (Pre-Configuration)

On first launch after sync, before any concepts are configured, the overview page shows:

**Always-available widgets** (built-in dimensions only):
- Summary card.
- Histogram (no stacking).
- Distribution charts: account, service, region.
- Breakdown table.

**Concept widgets (grayed/disabled):**
Three placeholder widget areas, visually present but dimmed, each pointing to the Dimensions Editor for activation:

- **Owner widget**: "Configure an ownership dimension to see cost by team. Open the Dimensions Editor."
- **Product widget**: "Configure a product dimension to see cost by application or service."
- **Environment widget**: "Configure an environment dimension to filter by prod/staging/dev."

As concepts are configured, these widgets activate.

---

## UI Design Principles

- **Desktop-native feel**: not a web app in a wrapper. Window resizing, keyboard shortcuts, fast navigation.
- **Data-dense**: tables and charts maximize information density. No oversized cards or excessive whitespace.
- **Progressive disclosure**: overview → drill-down → entity detail. Never dump everything at once.
- **Instant feedback**: queries should feel fast (sub-second cached, 1–3 seconds uncached on a 7GB dataset).
- **Dark mode default**, light mode available.
- **Colorblind-friendly**: two palettes (standard + Okabe-Ito), togglable, persisted in preferences.

### Frontend Stack

| Library | Purpose |
|---------|---------|
| React 19 | UI framework |
| shadcn/ui + Radix primitives | Component library (copy-paste, fully owned) |
| Tailwind CSS v4 | Styling with design tokens |
| visx (Airbnb) | Charts — D3 primitives as React components |
| TanStack Table | Headless table with virtual scrolling (Maybe Later — currently using ad-hoc tables) |
| Framer Motion | Subtle animations |
| Lucide React | Icons |
| `class-variance-authority` + `clsx` + `tailwind-merge` | Style composition |

### Color System

**Semantic colors (CSS variables):**
- `--bg-primary`, `--bg-secondary`, `--bg-tertiary`
- `--text-primary`, `--text-secondary`, `--text-muted`
- `--border`, `--border-subtle`
- `--accent` (teal/emerald)
- `--positive` / `--negative`
- `--warning`

**Chart palettes:**
```typescript
const PALETTE_STANDARD = [
  '#6366f1', '#06b6d4', '#f59e0b', '#10b981',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
];

const PALETTE_COLORBLIND = [  // Okabe-Ito
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
];
```

---

## Setup Requirements for Users

Before using CostGoblin:

1. **AWS CUR export configured** — CUR 2.0, Parquet format, exported to S3.
2. **Cost allocation tags activated** — in AWS Billing → Cost Allocation Tags.
3. **IAM permissions** — the AWS profile needs:
   - `s3:ListBucket`, `s3:GetObject` on the CUR bucket(s)
   - For AWS Organizations sync (optional but recommended): `organizations:List*`, `organizations:Describe*` on the management or delegated-admin account
   - For Cost Optimization Hub sync (optional): `cost-optimization-hub:List*` (or use the exported Parquet via S3)
4. **Install CostGoblin** — download the app, run the setup wizard, point it at the bucket.

---

## Engineering Standards

### TypeScript Strictness

The strictest possible TypeScript configuration. No escape hatches.

**tsconfig base:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  }
}
```

**Banned patterns (enforced by ESLint):**
- `any` type
- `@ts-ignore` and `@ts-expect-error`
- `as` type assertions (use type guards / discriminated unions)
- Non-null assertions (`!`)
- `eslint-disable` comments
- Implicit `any` in callbacks
- `console.log` (use the structured logger)

**Domain types use branded types** to prevent misuse:

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

export type DimensionId = Brand<string, 'DimensionId'>;
export type EntityRef = Brand<string, 'EntityRef'>;
export type TagValue = Brand<string, 'TagValue'>;
export type Dollars = Brand<number, 'Dollars'>;
export type DateString = Brand<string, 'DateString'>;
```

Brand constructors (`asDimensionId`, `asEntityRef`, etc.) are exported. Internal code should call these — not `as DimensionId`.

**State uses discriminated unions** — no impossible states:

```typescript
type QueryState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };

type SyncStatus =
  | { status: 'idle'; lastSync: Date | null }
  | { status: 'syncing'; phase: SyncPhase; progress: number; filesTotal: number; filesDone: number }
  | { status: 'completed'; lastSync: Date; filesDownloaded: number }
  | { status: 'failed'; error: Error; lastSync: Date | null };
```

**Wire-data validation:** anything crossing a trust boundary (JSON.parse, IPC, S3 manifest) must be validated by a type guard or codec — no `JSON.parse(x) as T`.

### Linting

- `@typescript-eslint/strict-type-checked`
- `@typescript-eslint/no-explicit-any`: error
- `@typescript-eslint/no-unsafe-assignment`: error
- `@typescript-eslint/no-unsafe-member-access`: error
- `@typescript-eslint/no-non-null-assertion`: error
- `no-console`: error

**Formatting:** Biome — configured once, not debated.

**The rule:** if the linter fights you, the design is wrong. Fix the design.

---

## Testing Strategy

### Principles

- Every module is testable in isolation — no test requires Electron, real S3, or user interaction.
- Full suite under 30 seconds.
- Test fixtures are deterministic and committed.
- The `CostApi` interface is the testing boundary between core and UI.

### Test Fixtures

```
packages/core/src/__fixtures__/
  generate.ts                  # Reads profile.json, writes synthetic Parquet
  profile.json                 # Statistical fingerprint of real data (committed)
  synthetic/
    aws/
      raw/
        daily-2026-01/data.parquet
        daily-2026-02/data.parquet
        hourly-2026-02/data.parquet
  config/
    costgoblin.yaml
    dimensions.yaml
    org-tree.yaml
```

Real company data lives in `data/raw/` — never committed (gitignored + pre-commit guard). The profile is committed; synthetic data is generated deterministically (seeded random) so output stays stable across machines.

### Layer 1: Core Logic (Vitest)

Pure functions: config loader, tag normalizer, alias resolver, org-tree traversal, cost math, query-builder, cache.

### Layer 2: DuckDB Queries (Vitest)

Real DuckDB queries against the synthetic Parquet fixtures. Shared instance per suite. Tests run in milliseconds.

### Layer 3: React Components (Vitest + React Testing Library)

Components tested against `MockCostApi`. No Electron, no DuckDB, no fs.

### Layer 4: Electron E2E (Playwright)

Full app launch with `--fixture-mode` pointing at fixture data. Slower (seconds). Run before commits and in CI.

### Coverage Floor

- **Sync engine** (currently 0 tests) — must reach meaningful coverage in v1.
- **Config validator** — must cover every error path.
- **AWS Org client** — at minimum a contract test against a recorded fixture.
- **UI L3 tests** — must include error states and empty states, not just happy-path renders.

---

## Development Pipeline

### The Feedback Loop

Single verification command:

```bash
npm run check
# 1. tsc --noEmit per package
# 2. eslint packages/*/src/
# 3. vitest run
```

Per-package:

```bash
cd packages/core && npm run check
cd packages/ui && npm run check
cd packages/desktop && npm run check && npm run dev
```

### Workflow

1. Read the relevant spec section.
2. Write types first (interfaces, branded types, discriminated unions).
3. `tsc --noEmit` → fix type errors.
4. Write tests for expected behavior.
5. `vitest run <test-file>` → see them fail.
6. Implement.
7. `vitest run <test-file>` → see them pass.
8. `npm run check` → full verification.
9. UI work: `npm run dev` for visual verification.

### Pre-Commit Hook

`.husky/pre-commit` blocks `data/raw/` files and runs `npm run check`. No broken code enters the repo.

---

## Technical Notes

### DuckDB Query Pattern

```typescript
const sql = `
  SELECT
    tag_team AS entity,
    SUM(cost) AS total_cost,
    SUM(CASE WHEN service = 'AmazonEC2' THEN cost ELSE 0 END) AS ec2_cost,
    SUM(CASE WHEN service = 'AmazonRDS' THEN cost ELSE 0 END) AS rds_cost
  FROM read_parquet('${dataDir}/aws/raw/daily-*/*.parquet')
  WHERE usage_date BETWEEN ? AND ?
  GROUP BY tag_team
  ORDER BY total_cost DESC
`;
```

DuckDB reads Parquet directly with glob patterns. No import step.

> **v1 hardening:** the query builder currently interpolates several values into the SQL string. Migrate user-controlled values (date ranges, dimension/tag values, `dataDir`) to `?` parameters where DuckDB supports them; for identifiers that can't be parameterized, validate them against allow-lists derived from the dimensions config.

### Org Tree Rollup

For virtual nodes, the query expands to all descendant real nodes:

```typescript
function getDescendantTagValues(node: OrgNode): string[] {
  if (!node.virtual) return [node.name, ...(node.children ?? []).flatMap(getDescendantTagValues)];
  return (node.children ?? []).flatMap(getDescendantTagValues);
}
```

### Tag Normalization Pipeline

Applied at query time (in SQL CASE expressions):

```
"Core_Banking" → lowercase-kebab → "core-banking"
"prod"         → lowercase       → alias lookup → "production"
```

When the configured tag is missing on a row and a `fallbackTag` is set, the query joins the AWS-Org account-tags table by `account_id` to fill the value. If still missing, `missingValueTemplate` is used (e.g., `no-team-{accountId}`).

### Electron IPC Bridge

```typescript
// preload/preload.ts
contextBridge.exposeInMainWorld('costgoblin', {
  queryCosts: (params) => ipcRenderer.invoke('query:costs', params),
  // ...
} satisfies CostApi);

// renderer
const result = await window.costgoblin.queryCosts(params);
// — but the renderer never reaches for `window.costgoblin` directly;
//   it uses the `useCostApi()` context so component tests can swap MockCostApi.
```

---

## Resolved Design Decisions

### Tag Normalization: At Query Time

Aliases and normalization rules are applied in SQL WHERE clauses and GROUP BY expressions, not during sync.

- Sync downloads raw Parquet as-is.
- Changing an alias takes effect on the next query — no re-sync.
- No doubled storage from maintaining raw + normalized copies.
- Slight query overhead from CASE/COALESCE — negligible on local DuckDB.

### Sync Layout: Per-Period, No Repartitioning

CostGoblin downloads CUR Parquet directly into `aws/raw/{tier}-{period}/` and queries them as-is via `read_parquet('.../raw/daily-*/*.parquet')` glob patterns. No staging, no DuckDB-side rewrite.

**Why no repartitioning:**
- DuckDB pushes date filters down to row groups within Parquet files via column statistics. For typical monthly files (~1GB), filtering "last 7 days" still reads only the relevant row groups, not the full file.
- Downloading raw avoids a CPU-heavy repartition step that would otherwise stall the UI on every sync.
- `aws s3 sync` (subprocess) handles concurrency, retries, partial-file resume, and etag-based incremental updates natively — much better than a hand-rolled S3 client.
- Tag columns are extracted at query time from `resource_tags` (a Map column), with normalization rules and aliases applied in SQL CASE expressions.

### Configuration: App is the Sole Writer

Org-shared YAML and per-user JSON are both written exclusively by the app. No file watcher, no file lock.

**Why no lock:** OS-level file locks fight too many legitimate workflows — git, backup tools (Time Machine, OneDrive), manual recovery if the app is broken, peeking at YAML in an editor, teammates editing the same file in their own checkout while another teammate runs the app.

**Why no watcher:** complicates state management, races with the app's own writes, and the existing in-app editors cover all routine config changes.

**Operational consequence:** if a user edits config externally while the app is running, those edits will be overwritten on the next app-driven save. External edits while the app is closed are loaded normally on next startup. This is the expected and documented behavior.

### Worker Threads — Committed for v1

Today, DuckDB and S3 sync run on the Electron main process. v1 moves them into worker threads. The IPC layer abstraction means the renderer is unaffected by the migration; only `packages/desktop/src/main/` changes.

### Storage Split: Org Config vs. User Preferences

- **Org config** (`config/*.yaml`) is shared across teammates via git. Edits go through the Dimensions Editor.
- **Per-user preferences** (`state/preferences.json`) are machine-local. Edits go through IPC.
- The renderer must not use `localStorage`/`sessionStorage` for any application state. (v1 cleanup task: migrate the theme toggle.)

---

## Test Fixture Generation

### Approach: Profile Real Data, Generate Synthetic

The real company dataset is available locally during development. It is never committed. Instead, it's used to create realistic synthetic fixtures.

**Step 1: Profile** (run once against real data, output committed):

```bash
npx tsx packages/core/src/__fixtures__/generate.ts --profile
```

Reads real Parquet, extracts a statistical fingerprint:
```json
{
  "rowCount": 2400000,
  "dateRange": { "min": "2025-04-01", "max": "2026-03-31" },
  "services": [
    { "name": "AmazonEC2", "costShare": 0.34, "avgDailyCost": 4200 }
  ],
  "accounts": { "count": 12, "topBySpend": 5 },
  "regions": ["eu-central-1", "us-east-1"],
  "tags": {
    "team": { "distinct": 15, "missingPercent": 0.08 },
    "environment": { "distinct": 4, "missingPercent": 0.03 }
  },
  "costDistribution": { "p50": 0.02, "p90": 12.5, "p99": 340.0 }
}
```

**Step 2: Generate** (deterministic, reproducible):

```bash
npx tsx packages/core/src/__fixtures__/generate.ts --generate
```

Synthetic Parquet:
- Service names are real (AmazonEC2 is not sensitive).
- Account IDs randomized (111111111111, 222222222222).
- Tag values fictional (alpha-team, beta-team).
- Cost amounts follow the real distribution shape.
- Missing-tag percentage matches reality.
- ~1000 rows per daily file, ~200 per hourly.
- Seeded random — same seed in, same output out.

**Step 3: Protect real data:**

```gitignore
# /data/.gitignore
*
!.gitkeep
!.gitignore
```

Pre-commit hook additionally blocks `data/raw/`:

```bash
# .husky/pre-commit
if git diff --cached --name-only | grep -q "^data/raw/"; then
  echo "ERROR: Real data files must not be committed"
  exit 1
fi
npm run check
```
