# GCP Provider — Design & Implementation Plan (#517)

> Implements [#517](https://github.com/etiennechabert/cost-goblin/issues/517) — roadmap step 4 of 4
> (#518 workspaces ✓ → #516 providers ✓ → #515 FOCUS 1.2 schema ✓ → **#517 GCP**).
> This document is the working plan for the implementation on this branch. Phases are ordered,
> independently verifiable (`npm run check` green after each), and follow the TDD workflow from
> CLAUDE.md. Sections marked **[LIVE-GATE]** require a real GCP FOCUS export and run before merge,
> once dataset access is provided — everything else is developed and validated against synthetic
> fixtures.

## 0. Corrections since drafting

Phases A–E are implemented. Four decisions in the original draft below turned out to be wrong when
checked against the code and against DuckDB, and were changed. They are recorded here rather than
edited away silently, because each one is a bug that would have shipped.

**C0 — The exporter is one deployed job, not a choice between two variants.**
§3 offered "variant A (scheduled query)" and "variant B (Cloud Run job)" as
alternatives. They are not alternatives: a scheduled query cannot delete GCS
objects, so on its own it accumulates orphaned shards and silently reports
inflated costs. The shipped recipe is the Cloud Run job; the standalone SQL is
the same export runnable by hand for a first look, documented as incomplete.

**C1 — Downloads shell out to `gcloud storage rsync`, not the SDK.** §4 sketched SDK streaming
through the handle. The adapter now mirrors AWS seam for seam instead: the vendor SDK
(`@google-cloud/storage`) lists the bucket for change detection, and the vendor CLI moves the
bytes — the sister of `aws s3 sync`. So the app expects the gcloud CLI exactly as it already
expects the AWS CLI, and it is the same binary the sign-in affordance shells out to, so a working
GCP setup already has it. `ObjectStoreHandle.downloadFile` survives for single-object reads (the
wizard's schema probe). `--delete-unmatched-destination-objects` also solves the stale-shard
problem on the app side for free.

**C2 — `ChargePeriodStart` must be normalized to naive UTC, from the *observed* type.** Absent
from the draft entirely. BigQuery writes TIMESTAMP with `isAdjustedToUTC=1`; DuckDB reads that back
as `TIMESTAMP WITH TIME ZONE`, and `::DATE` then resolves in the **session** timezone — verified
under `TimeZone='Europe/Berlin'`, a `2026-01-31 23:30 UTC` row reads as `2026-02-01`, silently
moving spend across a month boundary in both `usage_date` and the period-directory layout. The
conversion has to be selected from the footer type: applying `AT TIME ZONE 'UTC'` to an
*already-naive* TIMESTAMP shifts it the other way by the session offset, introducing the very bug
it prevents.

**C3 — §4's `map_from_entries` snippet is a hard runtime failure.** Verified:
`map_from_entries` raises `Invalid Input Error` on a duplicate key *or* a NULL key, failing the
whole period's `COPY`. Both occur in real exports — the same name can appear as a resource tag and
a project label, and a malformed label can carry a NULL key. Keys are now de-duplicated and
NULL-filtered first, each surviving key taking the value of its first occurrence, which makes the
source order (`Tags` → `x_Labels` → `x_ProjectLabels`) a **precedence rule**: resource tags outrank
labels. This resolves §5's `[LIVE-GATE: decide precedence]` marker — it was a correctness
precondition, not deferrable polish.

**C4 — `union_by_name` does not rescue a wholly-absent column.** It NULL-fills a column missing
from *some* file in a glob; a column missing from *every* file in one provider's glob is still a
binder error. So all 20 contract columns are physically materialized in each canonical file — the
`CAST(NULL AS VARCHAR) AS x_Operation` is load-bearing, not cosmetic.

Two smaller ones: `isCredentialError`'s bare `'credentials'` substring matched Google's *"Could not
load the default credentials"*, so every GCP auth failure was being rewritten into "run `aws sso
login --profile undefined`" — narrowed, with cross-negative tests in both directions. And
`resolveBucketPath` returned the **daily** bucket for an hourly request against a GCP provider
(`hourly?.bucket ?? daily.bucket`), which is worse than the missing throw the draft described.

Also: `saveEtags`/`pruneStaleFiles` are private to `selective-sync.ts`, not in `sync-utils.ts` as
§4 seam 5 claims — `saveEtags` was extracted; `pruneStaleFiles` is deliberately **not** reused,
since it compares remote basenames against local ones and would delete every canonicalized file.
And `duckdb-lazy.ts` is unusable from the sync worker (`createRequire(import.meta.url)` breaks once
esbuild bundles it as CJS), so the canonicalizer uses `await import('@duckdb/node-api')`.

## 1. Goal and ingest contract

The GCP adapter's only job: keep `{workspace}/data/{providerName}/raw/daily-YYYY-MM/*.parquet`
populated with **contract-valid FOCUS 1.2 Parquet**. Core and UI need zero GCP-specific changes
above the sync adapter (the setup/data-management surfaces gain a provider-type dimension, which is
part of the adapter's UX, not a leak).

Two corrections to the issue text, from the merged #515/#516 implementation:

1. **Local layout is `raw/{tier}-{period}/`, not `raw/BILLING_PERIOD=…/`.** Hive-style period
   folders exist only in *remote* object keys (`provider-paths.ts`, layout comment lines 5–15).
2. **Remote period extraction is case-sensitive on lowercase `billing_period=YYYY-MM`**
   (`sync-utils.ts:71-82` — deliberately, so leftover CUR 2.0 `BILLING_PERIOD=` trees are
   invisible). The GCS export recipe MUST emit lowercase `billing_period=YYYY-MM/` folders, not the
   uppercase form the issue sketch used.

Contract shape enforced by the query layer (all columns from
`REQUIRED_FOCUS_COLUMNS`, `packages/desktop/src/main/setup-manifest.ts:6-13`):

```
ChargePeriodStart, SubAccountId, SubAccountName,
BilledCost, EffectiveCost, ListCost, ContractedCost,
ServiceName, x_ServiceCode, ServiceCategory, RegionId,
ResourceId, ChargeCategory, PricingCategory,
CommitmentDiscountStatus, ChargeDescription, ConsumedQuantity,
SkuMeter, Tags, x_Operation
```

Physical types matter: `Tags` must be a Parquet **MAP(VARCHAR, VARCHAR)** — tag extraction is
`element_at(src.Tags, '<key>')[1]` (`packages/core/src/query/builder.ts:307,423`), which only works
on DuckDB MAP. Costs are read as numeric and unioned across providers with
`read_parquet(..., union_by_name=true)` (`builder.ts:427-439`), so keep them DOUBLE to avoid
DECIMAL/DOUBLE unification surprises.

## 2. Research findings (decisions locked)

Verified against Google's docs (2026-08):

- **Source: the native FOCUS 1.2 BigQuery export (Preview).** Enabled per billing account from
  Console → Billing → Billing export → BigQuery export → *Enable FOCUS export*. Google creates a
  managed, query-free-storage dataset `gcp_billing_immutable_<BILLING_ACCOUNT_ID>_<location>` with
  table `gcp_billing_export_focus_<BILLING_ACCOUNT_ID>`. This **answers the issue's open question**:
  the older FOCUS *view* over the detailed export is 1.0-only, but the native export is 1.2 — we
  need **no 1.0→1.2 SQL upgrade layer**. The 1.0 view path is out of scope (documented as
  unsupported).
- **The table is immutable/append-only.** `x_ExportTime` (TIMESTAMP) strictly increases with each
  append; corrections to closed periods arrive as new rows (FOCUS `ChargeClass` marks them). This
  gives the export pipeline a cheap, exact change signal: `MAX(x_ExportTime)` per
  `BillingPeriodStart`.
- **Backfill is minimal**: US/EU multi-region enablement backfills current + previous month (lands
  over ~5 days); single regions start empty. The dataset location is immutable after enablement.
  ⇒ setup docs must shout "enable this first, today".
- **2-year TTL** on the Google-managed table ⇒ the local Parquet mirror doubles as the long-term
  archive (a selling point — document it).
- **BigQuery cannot export Parquet MAP.** Tags arrive as `ARRAY<STRUCT<Key, Value, x_Inherited,
  x_Namespace>>` (list-of-struct in Parquet), costs as NUMERIC (Parquet DECIMAL). GCP labels /
  project labels may live in separate `x_Labels` / `x_ProjectLabels` repeated fields rather than
  `Tags` **[LIVE-GATE: verify]**. AWS-specific extension columns (`x_ServiceCode`, `x_Operation`)
  and possibly `SkuMeter` don't exist. ⇒ raw BQ export output can never be contract-valid on its
  own — see §4 canonicalization.
- **`EXPORT DATA` mechanics**: destination bucket must be co-located with the dataset
  (multi-region containment rules); `overwrite=true` does **not** guarantee removal of stale shards
  when a rerun produces fewer files; the `uri` option must be constant (dynamic per-period URIs
  require `EXECUTE IMMEDIATE FORMAT(...)`); zero-row exports still write one header-only file;
  shard names/counts are nondeterministic.

## 3. Cloud-side reference pipeline (user-deployed; we ship the recipe)

Deliverable: `scripts/gcp-focus-exporter/` + the `docs/setup-gcp.html` guide (§8). Two variants,
both documented; B is the reference.

**Change detection (both variants):** a tiny state table
`costgoblin_exporter.export_state(billing_period DATE, watermark TIMESTAMP)` in the user's own
project. Each run: compare `SELECT DATE(BillingPeriodStart), MAX(x_ExportTime) … GROUP BY 1`
against the state table → the set of periods with new rows. Re-export exactly those, then advance
watermarks **to the observed `MAX(x_ExportTime)`, not wall-clock now** (the FinOps-hubs race noted
in the issue). This handles late corrections to *any* old period, not just current+previous, and
converges to no-op runs.

- **Variant A — quick start (pure scheduled query).** A BigQuery scheduled query (daily) running a
  multi-statement script: detect changed periods → `EXECUTE IMMEDIATE` an
  `EXPORT DATA OPTIONS(uri='gs://<bucket>/<prefix>/billing_period=YYYY-MM/shard-*.parquet',
  format='PARQUET', compression='SNAPPY', overwrite=true) AS SELECT * FROM <focus_table> WHERE
  DATE(BillingPeriodStart) = <period>' per period. Zero infrastructure.
  *Documented caveat:* a SQL job cannot delete GCS objects, so a rerun that produces fewer shards
  can leave stale ones → double counting. Acceptable for evaluation; not the recommended steady
  state.
- **Variant B — reference (Cloud Scheduler → Cloud Run job).** A ~100-line Node script (repo
  language; `@google-cloud/bigquery` + `@google-cloud/storage`): detect changed periods → per
  period: **delete `gs://<bucket>/<prefix>/billing_period=YYYY-MM/` wholesale → `EXPORT DATA` that
  period → update watermark**. Ships with `Dockerfile` + `deploy.sh` (gcloud one-liners: create
  bucket co-located with the dataset, deploy job, create scheduler trigger, grant the job's service
  account `roles/bigquery.jobUser` + dataset read + bucket write). Solves stale shards at the
  source.

`SELECT *` is deliberate — the adapter canonicalizes locally (§4), so users don't maintain mapping
SQL, and preview-era schema additions flow through harmlessly.

## 4. App-side: the `gcp` sync adapter

### The pipeline per synced period

```
GCS list (change detect: crc32c as contentHash)
  → download period's shards to {meta}/staging-gcp/<period>/     (SDK streaming, resumable per-file)
  → canonicalize with DuckDB into a temp dir                     (one COPY … TO per period)
  → atomic swap into raw/daily-YYYY-MM/                          (rename, old dir removed)
  → save etags + timestamps (existing machinery, unchanged)
```

**Canonicalization is the load-bearing step** — it is what makes the contract satisfiable at all
(BQ cannot emit MAP tags), and it doubles as: the stale-shard defense on the app side (period
folder replaced wholesale from a consistent listing), the enforcement point for required columns
(missing column ⇒ canonicalize fails ⇒ classified sync error, mirroring the AWS wizard's
manifest check), the type normalizer (DECIMAL→DOUBLE, tags list→MAP), and the tolerator of
header-only shards (0-row input → 0-row canonical output, or skipped). One SQL statement per
period, roughly:

```sql
COPY (
  SELECT
    ChargePeriodStart, SubAccountId, SubAccountName,
    CAST(BilledCost AS DOUBLE) AS BilledCost, … ,
    map_from_entries(list_transform(Tags, t -> struct_pack(k := t.Key, v := t.Value))) AS Tags,
    COALESCE(x_ServiceId, ServiceName)         AS x_ServiceCode,   -- synthesized, see §5
    CAST(NULL AS VARCHAR)                      AS x_Operation,     -- synthesized
    COALESCE(SkuMeter, SkuId)                  AS SkuMeter,        -- synthesized fallback
    …
  FROM read_parquet('<staging>/<period>/*.parquet', union_by_name=true)
) TO '<tmp>/part-0.parquet' (FORMAT PARQUET, COMPRESSION SNAPPY);
```

(The exact tags expression — and whether `x_Labels`/`x_ProjectLabels` get merged into `Tags` — is
finalized at the live gate; the fixture encodes today's best understanding. The desktop sync worker
gains a DuckDB dependency for this step; `duckdb` is already a desktop dependency, and the vestigial
`'repartitioning'` progress phase in the worker protocol — emitted at `selective-sync.ts:305`,
rendered by `handlers/sync.ts:460` — is reused to surface it.)

SPEC's "no repartitioning" decision is about avoiding pointless rewrites of already-valid AWS
files; a shape-normalizing rewrite for a provider whose native output *cannot* meet the contract is
exactly what a provider adapter is for. SPEC §"Sync Layout" gets a clarifying sentence in Phase H.

### Seam-by-seam changes (from the pipeline survey)

| # | Seam | Change |
|---|------|--------|
| 1 | `core/src/types/config.ts:14-22` one-arm `ProviderConfig` union | add `GcpProviderConfig` arm: `{ name: ProviderName; type: 'gcp'; keyFile?: string; sync: GcpSyncConfig }` — `keyFile` absent ⇒ Application Default Credentials. `GcpSyncConfig` = `{ daily: { bucket: gs://…, retentionDays }, intervalMinutes }` (no hourly / cost-opt tiers in v1) |
| 2 | `core/src/config/validator.ts:129-131` hard-rejects `type !== 'aws'` | validate the `gcp` arm; `gs://` bucket paths accepted for gcp, `s3://` for aws |
| 3 | `core/src/sync/data-inventory.ts:158-160` hardcodes `createS3Handle` + `parseS3Path` | introduce `ObjectStoreHandle` (rename of the existing `S3Handle` shape — `listFiles`/`downloadFile` already transport-neutral) + a factory keyed on provider config; `parseGcsPath` mirrors `parseS3Path` |
| 4 | new `core/src/sync/gcs-client.ts` | `createGcsHandle(auth)` on `@google-cloud/storage` (new core dep, lazily imported like the S3 SDK at `s3-client.ts:33`): `listFiles` paginates, filters `.parquet`, maps `contentHash` ← CRC32C (+generation), `size`; `downloadFile` streams with byte progress + abort. Unlike AWS (CLI subprocess, `S3Handle.downloadFile` dead code), GCS downloads go through the handle — shard counts are small and the SDK validates CRC32C on the fly |
| 5 | `core/src/sync/selective-sync.ts` (AWS-CLI-specific throughout) | new `gcp-selective-sync.ts` implementing download→canonicalize→swap per period; shares `groupByPeriod`/`extractPeriodPrefix`/`saveEtags`/prune helpers from `sync-utils.ts` (all transport-neutral) |
| 6 | worker protocol: `sync-client.ts` `SyncOptions.profile: string`; `sync-worker.ts:127` | thread provider auth as a discriminated field (e.g. `auth: { kind: 'aws-profile'; profile } \| { kind: 'gcp'; keyFile? }`), keep legacy `profile` mapping for aws; worker branches to `syncSelectedFiles` vs the gcp path on it |
| 7 | `handlers/sync.ts:51` `resolveBucketPath` | per-arm: gcp exposes only `daily`; requesting other tiers throws like cost-opt does today |
| 8 | credential taxonomy: `s3-client.ts:43` `isCredentialError`, `context.ts:773-781` `toUserFriendlyError` (UI string-sniffs `'aws sso login'`) | add `isGcpCredentialError` (invalid_grant / could-not-load-default-credentials / 401/403 patterns); `toUserFriendlyError` branches on provider type, emitting `Run: gcloud auth application-default login` — with a matching UI sniff + login-button variant next to the existing SSO one (`ui/src/views/data-management.tsx:434,672`, `sync-status-button.tsx:100`); `data:sso-login` (`handlers/sync.ts:357`) generalizes to spawn the right CLI |
| 9 | `handlers/setup.ts` (four inline S3 clients) | `setup:test-connection` accepts provider type → GCS list probe; `setup:browse-s3` gains a GCS sibling that detects `billing_period=` folders and validates columns by reading one shard's footer via DuckDB (`parquet_schema`) — GCS has no AWS-style manifest JSON, the footer *is* the truth |
| 10 | `ui/src/views/setup-wizard.tsx` + `ui/src/views/data-management.tsx:627` (hardcoded `aws` badge) | provider-type picker (AWS / GCP) on the add-provider step; GCP form: bucket/prefix + optional key file + test connection + link to the setup guide; badge renders `provider.type` |
| 11 | rollup validity keyed on daily etag sidecar (`context.ts:564-572`) | works unchanged — GCS handle produces stable `contentHash` values; rollup over a GCP-first workspace works because canonicalized files meet the contract |
| 12 | `auto-sync.ts` scheduler | no structural change — providers already iterate sequentially with per-provider failure isolation (`ProviderSyncError[]`) |

Reused unchanged: `provider-paths.ts`, `sync-timestamps.ts`, `retention.ts`, `manifest.ts`,
`sync-id.ts`, the whole status/progress/log plumbing, and the query layer (per-provider globs +
union + injected `provider` column already shipped in #516).

## 5. GCP → contract column mapping

| Contract column | GCP FOCUS export source | Note |
|---|---|---|
| `ChargePeriodStart` | same | granularity may be finer than daily — fine, `usage_date = ChargePeriodStart::DATE`; row volume **[LIVE-GATE: measure]** |
| `SubAccountId` / `SubAccountName` | same | project id / name |
| `BilledCost` `EffectiveCost` `ListCost` `ContractedCost` | same, CAST to DOUBLE | conformance gaps **[LIVE-GATE: verify all four populated]** |
| `ServiceName` / `ServiceCategory` / `RegionId` / `ResourceId` / `ChargeDescription` / `ConsumedQuantity` / `ChargeCategory` / `PricingCategory` / `CommitmentDiscountStatus` | same | `CommitmentDiscountStatus` covers CUDs **[LIVE-GATE: verify]** |
| `x_ServiceCode` | `COALESCE(x_ServiceId, ServiceName)` | AWS extension column, synthesized |
| `x_Operation` | `NULL` | AWS-specific; dimension shows empty for GCP rows |
| `SkuMeter` | `COALESCE(SkuMeter, SkuId)` | 1.2-conditional column **[LIVE-GATE: verify]** |
| `Tags` | list-of-struct → MAP; merge of `Tags` + `x_Labels` + `x_ProjectLabels` **[LIVE-GATE: decide precedence]** | the canonicalization step |

Currency: GCP bills in the billing account currency. Multi-currency workspaces remain the
documented #516 v1 caveat — not GCP-specific, no new work here.

## 6. Implementation phases (execute in order on this branch)

Each phase: types → failing tests → implementation → `npm run check` green → commit.

- **A. Config model** ✅ — `GcpProviderConfig` arm + validator + serializer + `config-upsert` /
  scaffold support. Tests: validator accept/reject matrix, legacy configs untouched.
- **B. Listing** ✅ — `ObjectStoreHandle` factory + `gcs-client.ts` + `parseGcsPath`;
  `data-inventory.ts` goes through the factory (aws behavior byte-identical — the existing
  `data-inventory.test.ts` assertions are unchanged and prove it). `getDataInventory`'s second
  parameter is now a `ProviderAuth` descriptor rather than a profile string.
- **C. Canonicalizer** ✅ — `gcp-canonicalize.ts`, schema-adaptive (the export is in Preview and
  ships `SELECT *`, so unknown columns pass through and the contract columns are normalized).
  Tests (Layer 2, real DuckDB, session TZ pinned to `Europe/Berlin`): MAP tags via `element_at`,
  DOUBLE costs, every `REQUIRED_FOCUS_COLUMNS` present, month-boundary row stays in its month,
  duplicate/NULL tag keys survive, header-only shard tolerated, union with an AWS-shaped file,
  missing required column ⇒ typed error.
- **D. Download path** ✅ — `gcp-selective-sync.ts` (rsync → canonicalize → dir swap → etags);
  `ProviderAuth` threaded through the worker protocol; `resolveBucketPath` per-arm. Tests exercise
  the *real* filesystem (only `gcloud` is faked): abort and canonicalize-failure both leave `raw/`
  byte-identical, and etags are written only after a period is installed.
- **E. Errors & login UX** ✅ — `isGcpCredentialError`, `toUserFriendlyError` per-arm, UI sniff +
  `GcloudLoginButton`, and a `data:gcloud-login` **sibling** channel (`ssoLogin(profile)`'s arity is
  frozen across `CostApi`/preload/UI, and ADC takes no profile).
- **F. Setup & data-management UI** — **explicit provider-type step first** (maintainer's call: the
  GCP path must be discoverable, and the six wizard tests that walk the literal AWS path are
  updated in the same commit). Plus GCS test-connection/browse with footer-based column validation
  (GCS has no `metadata/` manifest — the Parquet footer *is* the truth, and the raw BQ export
  legitimately lacks `x_ServiceCode`/`x_Operation`, so it must not be validated against
  `REQUIRED_FOCUS_COLUMNS`). Data-management is already arm-aware: `provider.type` badge,
  credentials chip, hourly/cost-opt panels and the AWS-only sections hidden for GCP.
- **G. Fixtures & integration** — a BQ-export-shaped emitter **derived** from the existing
  `synthetic` table (`CREATE TABLE … AS SELECT`, the exact inverse of the canonicalizer) rather
  than a parallel hand-written DDL, preserving `focus-fixture.ts`'s no-drift invariant. The shared
  `__fixtures__/config/costgoblin.yaml` **gains a gcp provider** (maintainer's call: real e2e and
  `npm run dev:fixtures` coverage of a mixed workspace, at the cost of updating the four suites
  that assert `providers.length === 1` or exact totals). `multi-provider-union.integration.test.ts`
  gains an aws+gcp case — and it must add a **tag dimension**, since its `dimensions` const has
  `tags: []` today, leaving `element_at` (the most GCP-fragile expression) uncovered there.
  Note: the `--fixture-mode` flag §6 originally cited does not exist; the mechanism is
  `COSTGOBLIN_DATA_DIR` + `COSTGOBLIN_CONFIG_DIR` (`e2e/helpers.ts`).
- **H. Cloud recipe & docs** — `scripts/gcp-focus-exporter/` (variants A+B, Dockerfile, deploy.sh);
  split the landing-page guide: `docs/index.html#get-started` becomes two provider cards linking to
  new `docs/setup-aws.html` (current steps 0–4 moved verbatim) and `docs/setup-gcp.html` (§3 recipe
  + app connection); SPEC.md provider table row flips to shipped + canonicalization sentence;
  README provider list.
- **I. [LIVE-GATE] Real-dataset validation** — run §7 checklist against the maintainer-provided
  export, resolve every `[LIVE-GATE]` marker above (tags precedence, SkuMeter, costs, granularity),
  adjust the canonicalizer + fixture to match reality, re-run G.

## 7. Live-dataset validation checklist (pre-merge)

1. Recipe deployed on the real billing account; files land as
   `gs://<bucket>/<prefix>/billing_period=YYYY-MM/shard-*.parquet`; rerun converges to no-op;
   correction to a closed period triggers exactly that period's re-export.
2. Footer inspection of real shards vs the fixture's assumptions (types, tags/labels fields,
   nullability) — update fixture where reality differs.
3. Full app pass: add gcp provider in the wizard → test connection → sync → canonicalize →
   Explorer shows data; aws+gcp workspace unions with `provider` splitting them; credential-expiry
   path (revoke ADC) shows the gcloud login affordance.
4. Row-volume sanity: if per-month canonical Parquet is disproportionate vs AWS daily tier,
   evaluate the recipe's optional daily pre-aggregation (documented but off by default).

## 8. Out of scope

- FOCUS 1.0 view upgrade path (superseded by the native 1.2 export).
- GCP org-hierarchy sync (Cloud Resource Manager) — the AWS-Organizations analogue; follow-up issue.
- Hourly tier and Cost-Optimization tier for GCP; multi-currency handling (#516 caveat).
- CUR 2.0 → FOCUS transformation of existing AWS datasets.

## 9. Versioning

`main` is at 0.6.4 with `v0.6.3` the latest tag — already one release ahead. **No version bump in
this PR.**
