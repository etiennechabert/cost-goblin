# Sync, files and config

Covers `packages/core/src/sync/`, `packages/core/src/config/`, `packages/core/src/aws-setup/`, the sync, setup and workspace code in `packages/desktop/src/main/`, and `scripts/gcp-focus-exporter/`.

## The data directory

- Queries read `{provider}/raw/{tier}-{YYYY-MM}/*.parquet` non-recursively, so a stray Parquet file in a period directory gets summed twice over. The AWS sync must keep its `--include *.parquet` filters and prune stale files only after a successful sync. GCP stages outside `raw/`, and no temporary name under `raw/` may start with a tier prefix.
- Delete raw periods only through `deleteLocalPeriodFiles`. Sync never deletes a period because it disappeared remotely: bucket lifecycle rules depend on that. Any name in a deleted path goes through `parseProviderName` or `parseWorkspaceName` first.
- DuckDB glob separators are `/`: a glob built with `path.join` breaks on Windows.
- Some lists exist in several copies that must change together: the tier-to-directory map (`packages/core/src/sync/tiers.ts`, `packages/core/src/peer/pack-manifest.ts`, `packages/desktop/src/main/cur-detection.ts`, the data-management view) and the required FOCUS columns (`packages/core/src/sync/focus-contract.ts`, `packages/desktop/src/main/setup-manifest.ts`).

## Sync state

- Only `saveEtags` and `pruneEtagPeriod` write etag sidecars, through `updateEtagSidecar` (temporary file, rename, re-read). An etag means "installed": it is written last, only for files that really synced, and a request with no usable file throws.
- Reading sync state, only ENOENT means "absent". Other errors become `LocalSyncStateError`, whose message must not contain a path. Never turn a failed read into `{}`.
- Every `S3Client` starts from `s3ClientConfig`. GCP listing and download must act as the same principal. gcloud runs one rsync at a time with capped parallelism.
- The manual and automatic sync completion paths (`packages/desktop/src/main/handlers/sync.ts`, `packages/desktop/src/main/handlers/auto-sync.ts`) repeat the post-sync work, so a change goes into both. `SYNC_ALREADY_RUNNING` and "Download cancelled" are compared by string across the worker boundary: never reword them.
- Credential errors are classified by substring. New error text must not contain a classifier marker such as "credential", and reworded messages must keep theirs ("AWS credentials", "aws sso login") or the sign-in button disappears.
- Timer delays above 2^31−1 ms fire after 1 ms in Node.

## Config and state files

- Users' YAML and shared bundles must keep loading. New fields are optional. A rename reads both keys and writes the new one (`packages/core/src/config/legacy-renames.ts`). A rule that could reject files already on disk is lenient on load and strict on save.
- A new field needs its validator, its type and its serializer, or the next save strips it. Serializers omit absent optional fields, which keeps bundle fingerprints stable. The `costgoblin.yaml` writers keep unknown keys and validate before writing.
- Read-modify-writes of shared JSON go through `updatePrefsFile` (`packages/desktop/src/main/handlers/prefs-file.ts`), and each writer sends only its own fields.
- Only etag sidecars, the rollup manifest and the boot-time app state are written with temp-file-plus-rename. Ask for it on new state whose truncation would be costly.
- Migrations run synchronously at boot, before any worker opens a file. They are idempotent and resumable, and they touch nothing when both the old and new layout exist.

## Time

Calendar windows (retention, default ranges, previews, baselines) use `IpcContext` or the injected `now`. Elapsed and audit times (scheduling, last sync, logs) use `Date` on purpose. Days are UTC, except retention's month math, which uses local time and is duplicated in the data-management view: change both together.

## Providers and exporters

- A new provider type touches: the provider union and `validateProvider`, `ProviderAuth` and `isProviderAuth`, the object-store handle, `resolveBucketPath`, the sync-worker dispatch, the error classifiers, config upsert, the sharing bundle and the e2e cloud sandbox. Many of these are `gcp ? … : aws` branches that tsc won't flag.
- GCP output, once canonicalized, keeps every required column, `Tags` as a VARCHAR map, DOUBLE costs and naive-UTC `ChargePeriodStart`.
- A change to the exports stack regenerates `scripts/aws-exports/costgoblin-exports.yaml` with `scripts/aws-exports/write-template.ts`. The GCP exporter's `billing_period=YYYY-MM` layout is a contract with core. Its DATE and TIMESTAMP parameters must be wrapped (`temporalParam`), since an unwrapped one binds as NULL and publishes an empty shard.

## Intentional, don't flag

`aws s3 sync` runs without `--delete`; prune errors are swallowed while etag I/O is strict; `billing_period=` is matched case-sensitively; `AWS_REGION` is ignored; `shell: true` launches gcloud.cmd on Windows; config fields the validator requires but nothing reads are kept for compatibility; a status of `repartitioned` means up to date.
