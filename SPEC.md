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

This spec covers the **free desktop app (v1)** only. The architecture is designed so the core logic can be shared with a future web backend.

---

## Architecture

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop shell | Electron | Cross-platform desktop app (macOS + Windows) |
| Frontend | React + TypeScript | Shared UI components |
| Core library | TypeScript (npm package) | DuckDB queries, S3 sync, cost logic, config |
| Query engine | DuckDB (Node.js bindings) | Analytical queries over local Parquet files |
| Local state | JSON + YAML files | Config (YAML, user-editable), state (JSON, app-managed) |
| Data format | Apache Parquet | Cloud billing data stored locally |
| Auto-update | electron-updater + GitHub Releases | Background update checks, user-controlled restart |

### Monorepo Structure

```
costgoblin/
  data/                  # .gitignore'd — real data for development only
    .gitkeep
    .gitignore           # ignores everything except .gitkeep and .gitignore
    raw/                 # real Parquet files (NEVER committed)
  packages/
    core/                # @costgoblin/core — pure TypeScript, no framework dependency
      src/
        query/           # DuckDB query builder + execution
        sync/            # S3 sync engine + repartitioning
        config/          # YAML config loader + validator
        normalize/       # Tag normalization + alias resolution (query-time)
        models/          # Cost aggregation, trends, missing tags
        types/           # Shared TypeScript types, branded types
        __fixtures__/    # Synthetic test data + generator
        __tests__/       # Core logic tests
    desktop/             # Electron shell — imports @costgoblin/core
      src/
        main/            # Electron main process (DuckDB + S3 sync in worker threads)
        preload/         # IPC bridge
        renderer/        # React app entry point
    ui/                  # @costgoblin/ui — shared React components
      src/
        views/           # Full page views (overview, trends, entity detail, etc.)
        components/      # Reusable chart, table, filter components
        hooks/           # Data fetching hooks against CostApi interface
        api/             # CostApi interface + DesktopCostApi implementation
        __fixtures__/    # Mock CostApi + fixture data for component tests
        __tests__/       # Component tests
    web-backend/         # (Future) Express/Fastify server — imports @costgoblin/core
```

### Data Access Layer

The frontend codes against an abstract `CostApi` interface. The desktop app implements it via Electron IPC. A future web mode implements it via HTTP.

```typescript
// packages/ui/src/api/CostApi.ts
interface CostApi {
  // Queries
  queryCosts(params: CostQueryParams): Promise<CostResult>;
  queryTrends(params: TrendQueryParams): Promise<TrendResult>;
  queryMissingTags(params: MissingTagsParams): Promise<MissingTagsResult>;
  queryEntityDetail(params: EntityDetailParams): Promise<EntityDetailResult>;

  // Sync
  getSyncStatus(): Promise<SyncStatus>;
  triggerSync(): Promise<void>;

  // Config
  getConfig(): Promise<CostGoblinConfig>;
  getDimensions(): Promise<Dimension[]>;
  getOrgTree(): Promise<OrgNode[]>;
}

// packages/desktop/src/main/DesktopCostApi.ts
class DesktopCostApi implements CostApi {
  async queryCosts(params) {
    return ipcRenderer.invoke('query:costs', params);
  }
}

// packages/web-backend/src/WebCostApi.ts (future)
class WebCostApi implements CostApi {
  async queryCosts(params) {
    return fetch('/api/costs', { method: 'POST', body: JSON.stringify(params) });
  }
}
```

### Worker Thread Architecture

DuckDB operations and S3 sync run in Electron worker threads to keep the UI responsive.

```
Main Process
  ├── DuckDB Worker Thread    # All query execution
  ├── S3 Sync Worker Thread   # Download + incremental sync
  └── Window (Renderer)       # React UI
```

---

## Data Pipeline

### Source: Cloud Billing Exports

v1 targets **AWS Cost and Usage Reports (CUR 2.0)**, exported as Parquet to S3.

The architecture supports future providers via a normalization layer:

| Provider | Export Format | Storage | Status |
|----------|-------------|---------|--------|
| AWS | CUR 2.0 (Parquet) | S3 | v1 |
| GCP | BigQuery billing export | BigQuery → Parquet | Future |
| Azure | Cost Management export | Blob Storage (Parquet/CSV) | Future |

Each provider has a sync module and a normalizer that maps provider-specific columns to CostGoblin's internal schema.

### S3 Sync

The user configures AWS credentials and bucket paths. The app syncs Parquet files to local storage.

**Two granularity tiers:**

| Tier | Granularity | Default Retention | Use Case |
|------|------------|-------------------|----------|
| Daily | 1 row per day per line item | 365 days | Long-term trends, baselines |
| Hourly | 1 row per hour per line item | 30 days | Short-term drill-down, incident analysis |

**Sync behavior (manifest-based):**
- AWS CUR 2.0 produces a `manifest.json` in each export listing every Parquet file with its content hash
- Sync always fetches the manifest first (tiny file)
- Compares against stored manifest from last sync (`state/sync-manifest.json`)
- Files with changed hashes → re-download. New files → download. Removed files → delete local copy.
- After download, repartition monthly files to daily Hive-style partitions (see Resolved Design Decisions)
- Track lineage: which source file produced which daily partitions, so changed months only rewrite affected dates
- Background sync while app is open (configurable interval, default: every 60 minutes)
- Manual sync trigger via UI button
- Progress indicator in UI during sync

**Local storage layout (Hive-partitioned after repartition):**

```
~/Library/Application Support/costgoblin/     # macOS
%APPDATA%/costgoblin/                          # Windows
  config/                   # YAML — user-editable, source of truth
    costgoblin.yaml         # Main configuration (providers, sync, defaults)
    dimensions.yaml         # Dimension + concept definitions, aliases, normalization
    org-tree.yaml           # Organizational hierarchy
    views.yaml              # View templates per concept type (optional)
  state/                    # JSON — app-managed, not user-edited
    sync-manifest.json      # S3 file hashes + partition lineage
    preferences.json        # Window size, last period, theme, color palette, UI state
    telemetry-outbox.json   # Pending telemetry events (auditable by user)
  data/
    aws/                    # Provider namespace
      daily/                # Hive-partitioned by date (post-repartition)
        date=2025-04-01/data.parquet
        date=2025-04-02/data.parquet
        ...
      hourly/               # Hive-partitioned by date (if hourly configured)
        date=2026-03-15/data.parquet
        ...
      staging/              # Raw monthly CUR files (temporary, deleted after repartition)
```

**AWS Credentials:**

The app reads from existing AWS configuration, in priority order:
1. AWS profile from `~/.aws/credentials` (user selects profile name in setup)
2. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
3. SSO / Identity Center (via AWS SDK's built-in SSO flow)

No credentials are stored by the app itself — it delegates to the AWS SDK for Node.js.

### Internal Schema

DuckDB queries are written against a normalized internal schema. The normalizer maps provider-specific columns at sync time.

| Column | Type | Description |
|--------|------|-------------|
| `usage_date` | `DATE` | Day of usage |
| `usage_hour` | `TIMESTAMP` | Hour of usage (hourly tier only) |
| `account_id` | `VARCHAR` | Cloud account/project/subscription ID |
| `account_name` | `VARCHAR` | Friendly account name |
| `region` | `VARCHAR` | Cloud region |
| `service` | `VARCHAR` | Cloud service (e.g., AmazonEC2, AmazonRDS) |
| `service_family` | `VARCHAR` | Service sub-category |
| `description` | `VARCHAR` | Line item description |
| `resource_id` | `VARCHAR` | ARN or resource identifier |
| `usage_amount` | `DOUBLE` | Quantity of usage |
| `cost` | `DOUBLE` | Primary cost metric (configurable) |
| `list_cost` | `DOUBLE` | Public on-demand price |
| `line_item_type` | `VARCHAR` | Billing line item type |
| `usage_type` | `VARCHAR` | Usage type code |
| `operation` | `VARCHAR` | Operation type |
| `tag_{name}` | `VARCHAR` | One column per configured tag dimension |

Tags are flattened into top-level columns during normalization, applying aliases and normalization rules (see Configuration).

---

## Configuration System

All configuration lives in YAML files. The app loads them on startup. The UI helps users make changes by showing which file to edit, the proposed content, and a diff view — but the YAML files are the source of truth.

### Main Config: `costgoblin.yaml`

```yaml
# Cloud provider connections
providers:
  - name: aws-main
    type: aws
    credentials:
      profile: my-aws-profile          # AWS CLI profile name
    sync:
      daily:
        bucket: s3://my-cur-bucket/daily/
        retentionDays: 365
      hourly:
        bucket: s3://my-cur-bucket/hourly/
        retentionDays: 30
      intervalMinutes: 60               # Background sync interval

# Query defaults
defaults:
  periodDays: 30                        # Default analysis window
  costMetric: unblended_cost            # Which CUR cost column maps to `cost`
  lagDays: 1                            # CUR consolidation delay

# Cache
cache:
  ttlMinutes: 30                        # Query result cache TTL
```

### Dimensions: `dimensions.yaml`

```yaml
# Built-in dimensions (always available, derived from billing data structure)
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

# Tag-based dimensions (organization-specific)
tags:
  - tagName: "org:team"                 # Actual AWS cost allocation tag name
    label: "Team"
    concept: owner                      # Behavioral hook (see Concepts below)
    normalize: lowercase-kebab          # Normalization rule
    aliases:
      core-banking:
        - core_banking
        - corebanking
        - CoreBanking
      platform:
        - platform-team
        - platform_team

  - tagName: "org:service-name"
    label: "Service"
    concept: product                    # Behavioral hook
    separator: "/"                      # payments/api → product hierarchy
    normalize: lowercase
    aliases:
      payments:
        - payment
        - pay

  - tagName: "org:environment"
    label: "Environment"
    concept: environment                # Behavioral hook
    normalize: lowercase
    aliases:
      production:
        - prod
        - prd
        - production-eu
        - production-us
      staging:
        - stg
        - stage
        - pre-prod
        - preprod
      development:
        - dev
        - develop
      sandbox:
        - sbx

  - tagName: "org:cost-center"
    label: "Cost Center"
    # No concept — just a regular groupable dimension
    normalize: uppercase
```

### Concepts

Three behavioral hooks that change how the app treats a dimension:

| Concept | Behavior | Limit |
|---------|----------|-------|
| `owner` | Gets the organizational tree. Costs roll up through hierarchy. Future: budget assignment, report recipient. The "who pays" axis. | One dimension only |
| `product` | Anomaly detection target (future). Cost driver analysis. Supports `separator` for lightweight hierarchy (e.g., `payments/api`). The "what costs" axis. | One dimension only |
| `environment` | Cross-cutting filter bar on every view. Not a primary grouping dimension. The "where it runs" axis. | One dimension only |

Dimensions without a concept are regular groupable dimensions — you can slice data by them, drill into them, see breakdowns. They just don't get special UI treatment.

### Organizational Tree: `org-tree.yaml`

Applies to whichever dimension is marked `concept: owner`.

```yaml
# Nodes map to tag values. Virtual nodes have no tag value — their cost is the sum of children.
tree:
  - name: "Company"                     # Display name
    virtual: true                       # No tag value — grouping only
    children:
      - name: "Engineering"
        virtual: true
        children:
          - name: "core-banking"        # Matches tag value after normalization
          - name: "payments"
          - name: "identity"
          - name: "platform"
      - name: "Data"
        virtual: true
        children:
          - name: "analytics"
          - name: "ml-platform"
      - name: "SRE"                     # Real node (matches tag value) AND has children
        children:
          - name: "sre-emea"
          - name: "sre-us"
```

**Resolution rules:**
- A real node (non-virtual) matches a tag value after normalization + alias resolution
- A virtual node's cost = sum of all descendant real nodes' costs
- Tag values not appearing in the tree are shown as "unassigned" in the UI
- If no tree is defined, costs display flat by tag value

### In-App Config Editing

The app does NOT have a built-in YAML editor. Instead, when the user wants to make a config change (e.g., add an alias, modify the tree), the app:

1. Shows which file needs to change (e.g., `dimensions.yaml`)
2. Shows the proposed new content
3. Shows a diff view (before → after)
4. Provides a "Copy to clipboard" button and opens the file in the system editor
5. After the file is saved externally, the app detects the change (file watcher) and reloads

**Smart suggestions:**
- On first sync, the app scans all unique tag values and suggests dimension configuration
- Fuzzy matching detects potential duplicates (e.g., "prod" and "production") and suggests aliases
- New tag values appearing in subsequent syncs that don't match any known value or alias trigger a notification: "New tag value `staging-2` found for dimension Environment — should this map to an existing value?"

---

## Features (v1)

### Feature 1: Setup Wizard

First-run experience that guides the user through initial configuration.

**Flow:**
1. **Welcome screen** — brief explanation of what CostGoblin does
2. **Cloud provider** — select AWS (future: GCP, Azure). Enter profile name or credentials.
3. **S3 buckets** — specify daily and hourly bucket paths. "Test Connection" button.
4. **Tag discovery** — after test connection, app samples Parquet files and lists all available tags. User selects which tags to track and assigns labels/concepts.
5. **Alias suggestions** — for each selected tag, show all unique values with fuzzy-match grouping. User confirms or adjusts.
6. **Initial sync** — full download with progress bar. Can take several minutes for large datasets.
7. **Ready** — navigate to the cost overview.

The wizard writes `costgoblin.yaml` and `dimensions.yaml`. The org tree is optional and can be added later.

### Feature 2: Cost Overview Page

The main page showing organization-wide cost data. Registered as the app's home screen.

**Layout:**
- Top bar: current period indicator ("Last 30 days, N days lag"), sync status, "Sync Now" button
- Dimension selector: toggle between any configured dimension (Owner teams, Products, Accounts, Regions, Services, or any tag dimension)
- Environment filter chips (if environment concept is configured): horizontal bar showing each environment with its cost (e.g., "Production · $14.5k"), clicking filters all views below
- Sortable table:
  - Entity name (clickable → drills into entity detail)
  - Warning icon for unresolved entities (tag values not in catalog/tree)
  - Total cost
  - Top N cloud service columns with costs (dynamically determined — e.g., EC2, RDS, CloudWatch)
- Header row: organization total and per-service totals
- CSV export button

**Behavior:**
- Table sorted by total cost descending by default
- Service columns are the top N services by total spend across all entities
- Clicking an entity navigates to its detail view
- If the owner dimension has an org tree, virtual nodes are shown with rollup costs and a drill-down arrow

### Feature 3: Cost Trends View

Compares costs between the current period and the previous equivalent period.

**Layout:**
- Filters: Owner dropdown (if configured), dimension toggle, direction toggle (Increases / Savings)
- Threshold controls: absolute delta slider ($), percentage change slider (%)
- Summary: total increase/decrease count and dollar amount above thresholds
- Scatter/bubble visualization: each bubble is an entity with significant cost change, sized by dollar impact

**Behavior:**
- Shows only items exceeding BOTH the delta and percentage thresholds
- Increases: items that cost more vs. previous period
- Savings: items that cost less
- Clicking a bubble navigates to entity detail

### Feature 4: Missing Tags View

Identifies cloud resources that lack cost allocation tags.

**Layout:**
- Filters: Owner dropdown, Account dropdown
- Threshold control: minimum cost slider ($)
- Summary: total untagged cost and resource count above threshold
- Table: Account, closest owner match, Resource ID, Service, Service Family, Cost

**Behavior:**
- Only shows resources above minimum cost threshold
- Sorted by cost descending
- "Closest owner match" uses account-level or other available tags to suggest likely ownership

### Feature 5: Entity Detail View

Deep-dive into costs for a specific entity (team, product, account, etc.). Reached by clicking any entity name in overview/trends/drill-downs.

**Layout (top to bottom):**

**Row 1: Summary + Daily Histogram**
- Left card: Total cost for period, percentage change vs. previous period
- Right card: Stacked bar chart of daily costs, with dimension toggle (by sub-entity, by service) and date range picker

**Row 2: Environment Filter Bar** (if environment concept configured)
- Chips showing each environment with its cost
- Clicking filters all views below to that environment only

**Row 3: Distribution Charts**
- Up to three pie/donut charts depending on context:
  - Accounts: cost by cloud account
  - Sub-entities: cost by children (sub-teams for owner, sub-products for product)
  - Services: cost by cloud service
- Clicking a slice drills down or navigates to that entity's detail

**Row 4: Breakdown Table**
- Full line-item detail: sub-entity, service, service family, description, cost (with percentage)
- Sorted by cost descending

**Row 5: CSV Export**

### Feature 6: Granularity Toggle

For any time-series visualization, the user can switch between daily and hourly granularity.

**Behavior:**
- Daily is the default (365 days available)
- Hourly is available for the most recent 30 days only
- When hourly is selected, the date range picker constrains to 7 days max to keep the chart readable
- Hourly is useful for investigating specific cost spikes

### Feature 7: Query Cache

DuckDB queries on local Parquet are fast, but caching avoids redundant scans.

**Behavior:**
- In-memory LRU cache keyed on query parameters (dimension, filters, date range, granularity)
- Configurable TTL (default: 30 minutes)
- Cache invalidated automatically after sync completes
- "Clear Cache" option in app menu for manual invalidation

---

## Features (Deferred — Designed For, Not Built)

These features are explicitly NOT in v1 but the architecture accounts for them. They represent the paid tier.

### Local Budgets (v1.x)
- Annual budget per owner team, stored in local SQLite
- Budget vs. actual comparison in entity detail view
- Uses the `owner` concept dimension

### Automated Anomaly Detection (Paid)
- Server-side scheduler running statistical analysis on (product × service) combinations
- Requires the `product` concept dimension
- P10/P90 bands, rolling averages, potential savings calculation
- Triage workflow with comments, status, Jira links

### Scheduled Reports (Paid)
- Monthly budget reports via email (SES)
- PDF generation stored in S3
- Requires budgets to be configured

### Collaborative Features (Paid)
- Shared baselines, comments, status workflows
- Shareable links to specific views
- Team dashboards

### Multi-Cloud (v2)
- GCP billing export sync + normalizer
- Azure cost management export sync + normalizer
- Unified view across providers

---

## Interaction Model

### Global Filter Bar

The filter bar is the single source of truth for the current view state. It sits at the top of every page (overview, detail, trends). Every widget on the page reflects the active filters.

**Layout:**
```
[Account ▾] [Region ▾] [Service ▾] [Svc Family ▾] [Team ▾] [Product ▾] [Env ▾] ... [✕ Clear all]
```

- One chip per dimension (both built-in and tag-based)
- Unset chips show the dimension label, muted style
- Active chips show the selected value, visually highlighted (filled/colored)
- Clicking an unset chip opens a dropdown with distinct values for that dimension, sorted by cost descending
- Dropdown values are computed from the *currently filtered* data — filters cascade (if Team is set to "core-banking", the Service dropdown only shows services core-banking uses)
- Clicking an active chip allows changing the value or clearing it
- Environment chips (if environment concept configured) are visually distinct but functionally identical to other filter chips

### Three Ways to Set a Filter

1. **Click a chip** in the filter bar → dropdown → select a value
2. **Click an element in a widget** (pie slice, histogram bar, bubble) → opens the entity pop-up (see below)
3. **Click a row in the breakdown table** → sets ALL dimension chips for that row simultaneously

All three methods update the same filter state. The page re-renders to reflect the new filters.

### Entity Pop-Up (Click on Widget Element)

When a user clicks any interactive element in a widget (pie slice, bar segment, bubble), a side panel or modal opens showing a quick preview of that entity:

**Pop-up contents:**
- Entity name and total cost for the current period
- Mini histogram: daily cost trend for this entity over the period
- Top 5 breakdown: highest cost sub-items (services for a team, sub-products for a product, etc.)

**Pop-up actions:**
- **"Set as filter"** — closes the pop-up, sets the corresponding filter chip, entire page updates
- **"Open full view"** — navigates to the full detail page for that entity
- **"✕ Close"** — dismisses the pop-up, no change

This pattern means clicking in a widget is never destructive — the user always gets a preview before committing to a filter or navigation change.

### Table Row Click (Precision Zoom)

The breakdown table shows rows that are intersections of multiple dimensions:

```
core-banking | AmazonEC2 | Compute Instance | m5.xlarge usage | $12,400
```

Clicking a row sets ALL dimension chips at once for that row's values. The entire page snaps to show that exact cost slice. The histogram shows its trend. Distribution charts show how it breaks down by remaining unfiltered dimensions.

**The power is in zooming back out.** After clicking a row, the user removes individual filter chips to broaden the view. "Is this EC2 spike just core-banking, or all teams?" → remove the Team chip. Investigation flows naturally from specific to broad.

### Table Cell Click

Individual cells in dimension columns are also clickable. Clicking "AmazonEC2" in the service column of a table row opens the entity pop-up for AmazonEC2 (same as clicking it in a pie chart). This allows the user to inspect one dimension value without setting all filters for the row.

### Default View (Pre-Configuration)

On first launch after sync, before any concepts are configured, the overview page shows:

**Always-available widgets** (work with built-in dimensions only):
- Summary card: total cost for period + delta vs previous period
- Histogram: daily cost over time (no stacking — just total)
- Distribution charts: by Account, by Service, by Region
- Breakdown table: all line items

**Concept widgets (grayed/disabled):**
Three placeholder widget areas, visually present but dimmed:

- **Owner widget**: "Configure an ownership dimension to see cost by team. Add `concept: owner` to a tag dimension in `dimensions.yaml`." Clicking shows the config assistant with an example.
- **Product widget**: "Configure a product dimension to see cost by application or service. Add `concept: product` to a tag dimension."
- **Environment widget**: "Configure an environment dimension to filter by prod/staging/dev. Add `concept: environment` to a tag dimension."

As concepts are configured, these widgets activate and replace the placeholder. The app is immediately useful with zero concept configuration, but clearly shows what's unlockable.

### View Templates

Different entity types benefit from different widget layouts. View templates define which widgets appear and how they're configured when viewing a specific concept type.

**Stored in config:** `views.yaml`

```yaml
viewTemplates:
  owner:
    rows:
      - widgets:
          - type: summary
            size: small
          - type: histogram
            groupBy: product
            size: large
      - widgets:
          - type: distribution
            groupBy: account
          - type: distribution
            groupBy: childOwner
          - type: distribution
            groupBy: service
      - widgets:
          - type: table
            columns: [product, service, serviceFamily, description, cost]

  product:
    rows:
      - widgets:
          - type: summary
            size: small
          - type: histogram
            groupBy: service
            size: large
      - widgets:
          - type: distribution
            groupBy: account
          - type: distribution
            groupBy: region
          - type: distribution
            groupBy: serviceFamily
      - widgets:
          - type: table
            columns: [owner, account, service, serviceFamily, description, cost]

  account:
    rows:
      - widgets:
          - type: summary
            size: small
          - type: histogram
            groupBy: owner
            size: large
      - widgets:
          - type: distribution
            groupBy: owner
          - type: distribution
            groupBy: product
          - type: distribution
            groupBy: service
      - widgets:
          - type: table
            columns: [owner, product, service, region, cost]
```

The app ships with sensible default templates. Users can customize via YAML (config assistant helps with changes).

---

## UI Design Principles

- **Desktop-native feel**: not a web app in a wrapper. Responsive to window resizing, keyboard shortcuts, fast navigation.
- **Data-dense**: tables and charts should maximize information density. No excessive whitespace or oversized cards.
- **Progressive disclosure**: overview → click to drill down → click for full detail. Never dump everything on one screen.
- **Instant feedback**: queries should feel fast (sub-second for cached, 1-3 seconds for uncached on 7GB dataset).
- **Dark mode default, light mode available**: user toggles in settings. Preference persisted in `preferences.json`.
- **Colorblind-friendly**: two color palettes available, switchable via a "Toggle Colors" button (same pattern as the terraform-aws-sp-autopilot simulator). Default palette uses standard categorical colors. Alternate palette uses a colorblind-safe palette (Okabe-Ito or similar). The active palette is persisted in preferences.

### Frontend Stack

| Library | Purpose |
|---------|---------|
| React 19 | UI framework |
| shadcn/ui + Radix primitives | Component library (copy-paste, fully owned) |
| Tailwind CSS v4 | Styling with design tokens |
| visx (Airbnb) | Charts — D3 primitives as React components, full visual control |
| TanStack Table | Headless table with sorting, filtering, virtual scrolling |
| Framer Motion | Subtle animations — pop-up entrance, filter chip transitions, page crossfades |
| Lucide React | Icons |
| class-variance-authority + clsx + tailwind-merge | Style composition utilities |

**Why these choices:**
- **shadcn/ui** over a prebuilt component library: you own every component, can customize to match the app's exact aesthetic. Produces the clean Linear/Vercel look.
- **visx** over Recharts: Recharts looks "charty" and is hard to style. visx gives full visual control — charts feel native to the app, not like embedded widgets.
- **TanStack Table** with virtual scrolling: breakdown tables can have thousands of rows. Only visible rows render.

### Color System

**Semantic colors (defined as CSS variables, swap between themes):**
- `--bg-primary`, `--bg-secondary`, `--bg-tertiary` — page and card backgrounds
- `--text-primary`, `--text-secondary`, `--text-muted` — text hierarchy
- `--border-default`, `--border-subtle` — borders and dividers
- `--accent` — primary action color (teal/emerald family)
- `--positive` / `--negative` — cost decrease / cost increase
- `--filter-active` — active filter chip background

**Chart palettes (two sets, togglable):**
```typescript
const PALETTE_STANDARD = [
  '#6366f1', '#06b6d4', '#f59e0b', '#10b981',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
];

const PALETTE_COLORBLIND = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
]; // Okabe-Ito palette — distinguishable by all forms of color vision
```

### Granularity Toggle

Daily resolution is mandatory. Hourly is optional — depends on config.

**If only daily configured:** No toggle shown anywhere. Histogram header just shows the date range. No mention of hourly — no grayed-out option, no "unlock" prompt. Clean.

**If both configured:** A segmented control on the histogram widget: `[ Daily | Hourly ]`. Switching to Hourly auto-constrains the date range picker to 7 days max (defaulting to most recent 7 days with hourly data). Subtle label: "Hourly data: last 30 days."

**Config detection:**
```yaml
# costgoblin.yaml — hourly section is entirely optional
providers:
  - name: aws-main
    sync:
      daily:
        bucket: s3://my-cur-bucket/daily/
        retentionDays: 365
      # Omit this entire block if you don't have hourly CUR:
      hourly:
        bucket: s3://my-cur-bucket/hourly/
        retentionDays: 30
```

The core library exposes `getAvailableGranularities(): ('daily' | 'hourly')[]`. The UI conditionally renders the toggle.

---

## Setup Requirements for Users

Before using CostGoblin, the user needs:

1. **AWS CUR export configured** — CUR 2.0, Parquet format, exported to S3. The user sets this up in the AWS Billing console.
2. **Cost allocation tags activated** — in AWS Billing → Cost Allocation Tags. The tags used for dimensions must be activated.
3. **IAM permissions** — the AWS profile/role used by CostGoblin needs:
   - `s3:ListBucket`, `s3:GetObject` on the CUR S3 bucket(s)
   - That's it. No Athena, no Glue, no database. Just S3 read access.
4. **Install CostGoblin** — download the app, run the setup wizard, point it at the bucket.

---

## Engineering Standards

### TypeScript Strictness

The project uses the strictest possible TypeScript configuration. No escape hatches.

**tsconfig.json (base):**
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
- `any` type — use `unknown` and narrow, or define a proper type
- `@ts-ignore` and `@ts-expect-error` — fix the type, not the linter
- `as` type assertions — use type guards and discriminated unions instead
- Non-null assertions (`!`) — handle the null case explicitly
- `eslint-disable` comments — no exceptions, no line-level overrides
- Implicit `any` in callbacks — all function parameters must be typed

**Domain types use branded types** to prevent accidental misuse:

```typescript
// packages/core/src/types/branded.ts
type Brand<T, B extends string> = T & { readonly __brand: B };

export type DimensionId = Brand<string, 'DimensionId'>;
export type EntityRef = Brand<string, 'EntityRef'>;
export type TagValue = Brand<string, 'TagValue'>;
export type BucketPath = Brand<string, 'BucketPath'>;
export type Dollars = Brand<number, 'Dollars'>;
```

**State uses discriminated unions** — no impossible states:

```typescript
// Bad — isLoading: true AND data present is representable
{ isLoading: boolean; error?: Error; data?: CostResult }

// Good — exactly one state at a time
type QueryState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }

type SyncState =
  | { status: 'idle'; lastSync: Date | null }
  | { status: 'syncing'; progress: number; filesTotal: number; filesDone: number }
  | { status: 'completed'; lastSync: Date; filesDownloaded: number }
  | { status: 'failed'; error: Error; lastSync: Date | null }
```

### Linting

**ESLint with strict configuration:**
- `@typescript-eslint/strict-type-checked` ruleset
- `@typescript-eslint/no-explicit-any`: error
- `@typescript-eslint/no-unsafe-assignment`: error
- `@typescript-eslint/no-unsafe-member-access`: error
- `@typescript-eslint/no-non-null-assertion`: error
- `no-console`: error (use a structured logger)
- Import sorting and organization enforced

**Formatting:** Biome or Prettier — configured once, never debated.

**The rule is simple:** if the linter or type checker fights you, the design is wrong. Fix the design, not the tooling.

---

## Testing Strategy

### Principles

- Every module is testable in isolation — no test requires Electron, a real S3 bucket, or user interaction
- Tests run fast — the full suite completes in under 30 seconds
- Test fixtures are deterministic and committed to the repo
- The `CostApi` interface is the testing boundary between core and UI

### Test Fixtures

A fixture generator script creates small, deterministic Parquet files committed to the repo:

```
packages/core/src/__fixtures__/
  generate-fixtures.ts      # Script to regenerate fixtures
  daily/
    2026-01.parquet         # ~500 rows, 31 days, 5 teams, 3 envs, 10 services
    2026-02.parquet         # ~500 rows, same shape
  hourly/
    2026-02-15.parquet      # ~200 rows, 24 hours, subset of teams/services
  config/
    costgoblin.yaml         # Test config matching fixture data
    dimensions.yaml         # Dimensions with aliases matching fixture tag values
    org-tree.yaml           # Small tree for rollup testing
```

Fixture data covers edge cases: missing tags, unknown tag values, multiple accounts, multiple regions, zero-cost rows, negative costs (credits).

### Layer 1: Core Logic (Pure Functions)

**Runner:** Vitest
**Scope:** Config loading, tag normalization, alias resolution, org tree traversal, cost aggregation math, period comparison, threshold filtering

These are pure functions with no I/O. Tests are trivial to write and run in milliseconds.

```typescript
// Example: normalize.test.ts
describe('normalizeTagValue', () => {
  it('applies lowercase-kebab normalization', () => {
    expect(normalizeTagValue('Core_Banking', 'lowercase-kebab')).toBe('core-banking');
  });

  it('resolves aliases after normalization', () => {
    const aliases = { 'core-banking': ['core_banking', 'corebanking'] };
    expect(resolveAlias('corebanking', 'lowercase', aliases)).toBe('core-banking');
  });
});
```

### Layer 2: DuckDB Queries

**Runner:** Vitest
**Scope:** Query builder generates correct SQL; queries return expected results against fixture Parquet files

A shared DuckDB instance loads once per test suite. Each test runs a real query against the fixture files. Fixtures are small enough that queries complete in milliseconds.

```typescript
// Example: query.test.ts
describe('queryCosts', () => {
  let db: DuckDBInstance;

  beforeAll(async () => {
    db = await createDuckDB();
    // Point at fixture directory
  });

  it('groups costs by owner dimension', async () => {
    const result = await queryCosts(db, {
      groupBy: 'tag_team' as DimensionId,
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: {},
    });
    expect(result.rows).toHaveLength(5); // 5 teams in fixture
    expect(result.rows[0].totalCost).toBeGreaterThan(result.rows[1].totalCost); // sorted desc
  });

  it('applies filters correctly', async () => {
    const result = await queryCosts(db, {
      groupBy: 'service' as DimensionId,
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: { tag_team: 'core-banking' as TagValue },
    });
    // All rows should only contain core-banking costs
    expect(result.totalCost).toBeLessThan(/* unfiltered total */);
  });
});
```

### Layer 3: React Components

**Runner:** Vitest + React Testing Library
**Scope:** Widget rendering, filter bar interactions, pop-up behavior, view template rendering

Components are tested against a mock `CostApi` that returns typed fixture data. No DuckDB, no Electron, no file system.

```typescript
// Example: filter-bar.test.tsx
describe('FilterBar', () => {
  it('displays all configured dimensions as chips', () => {
    render(<FilterBar dimensions={mockDimensions} filters={{}} onFilterChange={vi.fn()} />);
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Service')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
  });

  it('shows active filter value on chip', () => {
    const filters = { service: 'AmazonEC2' as TagValue };
    render(<FilterBar dimensions={mockDimensions} filters={filters} onFilterChange={vi.fn()} />);
    expect(screen.getByText('Service: AmazonEC2')).toBeInTheDocument();
  });

  it('calls onFilterChange when value selected from dropdown', async () => {
    const onChange = vi.fn();
    render(<FilterBar dimensions={mockDimensions} filters={{}} onFilterChange={onChange} />);
    await userEvent.click(screen.getByText('Service'));
    await userEvent.click(screen.getByText('AmazonEC2'));
    expect(onChange).toHaveBeenCalledWith({ service: 'AmazonEC2' });
  });
});
```

```typescript
// packages/ui/src/__fixtures__/mock-api.ts
export class MockCostApi implements CostApi {
  async queryCosts(params: CostQueryParams): Promise<CostResult> {
    // Return deterministic fixture data matching the params
    // This is the SAME types as the real API — type safety ensures fidelity
  }
}
```

### Layer 4: Electron Integration

**Runner:** Playwright (Electron mode)
**Scope:** End-to-end flows — app launch, sync from local fixture directory, navigation, IPC bridge

These tests launch the real Electron app pointed at a fixture data directory (not real S3). They're slower (seconds, not milliseconds) and run less frequently.

```typescript
// Example: e2e/overview.test.ts
test('overview page loads and shows cost data', async () => {
  const app = await electron.launch({ args: ['--fixture-mode'] });
  const page = await app.firstWindow();

  await expect(page.getByText('Last 30 days')).toBeVisible();
  await expect(page.getByText('AmazonEC2')).toBeVisible();

  // Click a service in the distribution chart
  await page.getByText('AmazonEC2').click();
  // Pop-up should appear
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Set as filter')).toBeVisible();
});
```

---

## Development Pipeline

### The Feedback Loop

When building CostGoblin (whether by a human developer or Claude Code), the feedback loop must be fast and reliable. Every code change should be verifiable in under 10 seconds.

**Single verification command:**

```bash
npm run check
# Runs in order, fails fast:
# 1. tsc --noEmit          (~2-3 seconds — type errors)
# 2. eslint --quiet         (~2-3 seconds — lint violations)
# 3. vitest run --reporter=verbose  (~3-5 seconds — test failures)
```

**Per-package commands (for focused work):**

```bash
# Working on core logic
cd packages/core
npm run check              # type + lint + test for core only

# Working on UI components
cd packages/ui
npm run check              # type + lint + test for UI only (uses mock API)

# Working on Electron integration
cd packages/desktop
npm run check              # type + lint + test for desktop shell
npm run dev                # launches Electron in dev mode with hot reload
```

### Claude Code Development Workflow

When Claude Code builds a feature, it should follow this sequence:

```
1. Read the spec section for the feature being built
2. Write types first (interfaces, branded types, discriminated unions)
3. Run: tsc --noEmit → fix type errors
4. Write tests for the expected behavior
5. Run: vitest run <test-file> → see tests fail (red)
6. Write the implementation
7. Run: vitest run <test-file> → see tests pass (green)
8. Run: npm run check → full verification
9. If working on UI: npm run dev in desktop/ to visually verify
```

**Key rules for Claude Code:**
- NEVER skip step 8. Every change must pass the full check before moving on.
- NEVER add `@ts-ignore`, `as any`, or `eslint-disable` to make code compile. Fix the actual problem.
- ALWAYS write tests before or alongside implementation, not after.
- If a test is hard to write, the code is probably too coupled. Refactor first.
- Use `vitest run <specific-file>` for fast iteration, `npm run check` for final verification.

### Fixture-Driven Development

For any feature that touches cost data, the development process is:

1. Check if the existing fixture covers the case. If not, extend `generate-fixtures.ts`.
2. Write a test against the fixture data that describes the expected behavior.
3. Implement the feature.
4. Verify with `vitest run`.

This avoids the need for real AWS credentials, real S3 buckets, or large datasets during development. The fixture is the contract.

### Pre-Commit Hook

A Git pre-commit hook runs `npm run check` automatically. Commits are blocked if types, lint, or tests fail. No broken code enters the repository.

```bash
# .husky/pre-commit
npm run check
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-3)
- Monorepo setup (Turborepo or Nx) with shared tsconfig (strict)
- ESLint + Biome configuration with zero-tolerance rules
- Vitest setup with fixture generator
- Core types: branded types, discriminated unions, CostApi interface
- DuckDB integration in worker thread + query builder with tests
- S3 sync engine with incremental download + tests against local fixture
- YAML config loader + validator + tests
- Tag normalization + alias resolution + tests
- `npm run check` pipeline working end-to-end
- Electron shell with React renderer (minimal — just proves the IPC bridge works)

### Phase 2: Core Views (Weeks 4-6)
- Setup wizard flow
- Global filter bar (filter state management, cascading dropdowns)
- Cost overview page with dimension switching
- Default view with grayed concept widget placeholders
- Entity pop-up (side panel on widget click)
- Breakdown table with row-click → set all filters
- Component tests for all widgets
- CSV export

### Phase 3: Analysis (Weeks 7-8)
- Entity detail view with view templates
- Cost trends view with bubble visualization
- Missing tags view
- Hourly granularity toggle
- Query cache

### Phase 4: Polish (Weeks 9-10)
- Org tree rollups and drill-down navigation
- Smart alias suggestions (fuzzy matching on first sync)
- Config change assistant (diff viewer, file watcher)
- Dark mode
- Playwright E2E tests for critical flows
- Packaging and distribution (electron-builder for macOS DMG + Windows installer)

---

## Technical Notes

### DuckDB Query Pattern

```typescript
// Example: cost by owner for last 30 days
const sql = `
  SELECT
    tag_team AS entity,
    SUM(cost) AS total_cost,
    SUM(CASE WHEN service = 'AmazonEC2' THEN cost ELSE 0 END) AS ec2_cost,
    SUM(CASE WHEN service = 'AmazonRDS' THEN cost ELSE 0 END) AS rds_cost
  FROM read_parquet('${dataDir}/aws/daily/**/*.parquet')
  WHERE usage_date BETWEEN ? AND ?
  GROUP BY tag_team
  ORDER BY total_cost DESC
`;
```

DuckDB reads Parquet files natively with glob patterns. No import step, no separate database to maintain.

### Org Tree Rollup Pattern

For virtual nodes, the query expands to include all descendant real nodes:

```typescript
function getDescendantTagValues(node: OrgNode): string[] {
  if (!node.virtual && !node.children) return [node.name];
  return (node.children || []).flatMap(getDescendantTagValues);
}

// "Engineering" virtual node → ['core-banking', 'payments', 'identity', 'platform']
// SQL: WHERE tag_team IN ('core-banking', 'payments', 'identity', 'platform')
```

### Tag Normalization Pipeline

Applied during sync (when writing normalized Parquet) OR at query time:

```
Raw tag value → lowercase/kebab/etc → alias lookup → final value
"Core_Banking" → "core_banking" → (alias: core_banking → core-banking) → "core-banking"
"prod"         → "prod"          → (alias: prod → production)          → "production"
```

### Electron IPC Bridge

```typescript
// Main process (main/ipc.ts)
ipcMain.handle('query:costs', async (event, params: CostQueryParams) => {
  return duckdbWorker.postMessage({ type: 'query:costs', params });
});

// Renderer (via preload)
const result = await window.costgoblin.queryCosts(params);
```

---

## Resolved Design Decisions

### Tag Normalization: At Query Time

Tag aliases and normalization rules are applied in SQL WHERE clauses and GROUP BY expressions, not during sync. This means:
- Sync downloads raw Parquet files as-is from S3 — no transformation step
- Changing an alias in `dimensions.yaml` takes effect immediately (no re-sync)
- No doubled storage from maintaining both raw and normalized copies
- Slight query overhead (CASE/COALESCE expressions) — negligible for DuckDB on local data

### CUR Repartitioning: Monthly → Daily

AWS CUR exports to monthly folders. CostGoblin repartitions to daily Hive-style partitioning after sync for query performance.

**Why:** DuckDB pushes date filters down to file-level with Hive partitioning. A "last 7 days" query reads ~230MB instead of scanning an entire 7GB monthly file.

**Sync pipeline:**
1. Download raw monthly Parquet files to a staging directory
2. Repartition into daily structure using DuckDB:
   ```sql
   COPY (
     SELECT * FROM read_parquet('staging/monthly/*.parquet')
     WHERE usage_date = '2026-03-15'
   )
   TO 'data/daily/date=2026-03-15/data.parquet' (FORMAT PARQUET);
   ```
3. Delete staging files after successful repartitioning
4. Incremental syncs only repartition new/changed months

**Local storage (post-repartition):**
```
data/
  aws/
    daily/
      date=2026-01-01/data.parquet
      date=2026-01-02/data.parquet
      ...
    hourly/
      date=2026-03-15/data.parquet
      date=2026-03-16/data.parquet
      ...
    staging/                # temporary, deleted after repartition
```

### Auto-Update

CostGoblin uses `electron-updater` for silent background updates.

**Behavior:**
- On app launch, check for updates in the background (no blocking UI)
- If an update is available, download it silently
- Show a subtle indicator on the settings wheel icon (top right) — a small badge/dot
- Clicking the settings wheel shows "Update available — restart to apply" with a button
- User controls when the restart happens — never forced
- Manual "Check for updates" option in the settings panel
- Update channel configurable: `stable` (default) or `beta`

### Telemetry

All telemetry is opt-in, defaulted to OFF, and can be changed anytime in settings.

**Opt-in UX:**
- After setup wizard completes, a clear screen: "Help improve CostGoblin"
- Three bullet points explaining what's collected in plain language
- Expandable "What exactly do we collect?" detail section
- Single toggle, defaulted to OFF
- Settings wheel → Privacy section to change at any time
- When OFF, zero network calls to any analytics service

**Three channels:**

**1. Usage analytics (anonymous, no PII):**
- Features opened (overview, trends, missing tags, entity detail)
- Number of dimensions configured, which concepts are active
- Dataset size (row count bucket: <100k, <1M, <10M, 10M+)
- Filter interactions per session (count only, not filter values)
- Session duration
- Implementation: PostHog (self-hostable, privacy-focused) or lightweight custom endpoint

**2. Crash and error reporting:**
- Unhandled exceptions with stack traces
- DuckDB query failures (error message only — NOT the query, which could contain tag values)
- Sync failures (error type, not credentials or bucket paths)
- Config validation errors (error type, not config content)
- Implementation: Sentry with a `beforeSend` hook that strips any potential PII
- Breadcrumbs: feature navigation trail (what the user was doing before the crash)
- Environment context: OS, Electron version, app version, DuckDB version

**3. Performance metrics:**
- App startup time (cold and warm)
- Query execution time by query type (overview, trends, detail, missing tags)
- Sync duration and file count
- Time-to-first-render for each view
- Repartition duration
- Implementation: Sentry performance monitoring (transactions + spans) or custom reporter

**Data principles:**
- No cost data, tag values, account IDs, team names, or any business data ever leaves the machine
- Telemetry payloads are logged locally (viewable in settings) so the user can audit exactly what's sent
- All telemetry endpoints are configurable (for orgs that want to self-host the collector)

---

## Test Fixture Generation

### Approach: Profile Real Data, Generate Synthetic

During development, the real company dataset is available locally. It is never committed to the repo. Instead, it's used to create realistic synthetic fixtures.

**Directory structure:**
```
costgoblin/
  data/                     # .gitignore'd — real data lives here during development
    .gitkeep
    .gitignore              # contains: *\n!.gitkeep\n!.gitignore
    raw/                    # real Parquet files (NEVER committed)
  packages/
    core/
      src/
        __fixtures__/
          generate.ts       # reads real data profile, writes synthetic Parquet
          profile.json      # statistical profile extracted from real data (committed)
          synthetic/        # generated Parquet files (committed)
            daily/
              date=2026-01-01/data.parquet
              ...
            hourly/
              date=2026-02-15/data.parquet
          config/           # test config files (committed)
            costgoblin.yaml
            dimensions.yaml
            org-tree.yaml
```

**Step 1: Profile (run once against real data, output committed):**
```typescript
// generate.ts --profile
// Reads real Parquet, extracts statistical fingerprint:
{
  "rowCount": 2400000,
  "dateRange": { "min": "2025-04-01", "max": "2026-03-31" },
  "services": [
    { "name": "AmazonEC2", "costShare": 0.34, "avgDailyCost": 4200 },
    { "name": "AmazonRDS", "costShare": 0.22, "avgDailyCost": 2700 },
    ...
  ],
  "accounts": { "count": 12, "topBySpend": 5 },
  "regions": ["eu-central-1", "us-east-1", "eu-west-1"],
  "tags": {
    "team": { "distinct": 15, "missingPercent": 0.08 },
    "service-name": { "distinct": 42, "missingPercent": 0.12 },
    "environment": { "distinct": 4, "missingPercent": 0.03 }
  },
  "costDistribution": { "p50": 0.02, "p90": 12.5, "p99": 340.0 },
  "lineItemTypes": { "Usage": 0.89, "Tax": 0.0, "Fee": 0.06, "Credit": 0.05 }
}
```

**Step 2: Generate (deterministic, reproducible):**
```typescript
// generate.ts --generate
// Uses profile.json to create synthetic Parquet files:
// - Service names are real (AmazonEC2 is not sensitive)
// - Account IDs are randomized (111111111111, 222222222222, ...)
// - Tag values replaced with fictional names (alpha-team, beta-team, ...)
// - Cost amounts follow same distribution shape with different values
// - Missing-tag percentage matches real data
// - ~1000 rows per daily file, ~200 rows per hourly file
// - Seeded random (same seed = same output = deterministic tests)
```

**Step 3: Protect real data:**
```gitignore
# /data/.gitignore
*
!.gitkeep
!.gitignore
```

Pre-commit hook additionally checks that no file from `data/raw/` is staged:
```bash
# .husky/pre-commit
if git diff --cached --name-only | grep -q "^data/raw/"; then
  echo "ERROR: Real data files must not be committed"
  exit 1
fi
npm run check
```
