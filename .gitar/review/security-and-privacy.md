# Security and privacy

Billing data, account names and cloud credentials sit on the user's machine, and shared config files can come from anyone. No lint rule or source scan catches a new spawn site, IPC handler, `shell.openExternal` call, CSV producer or regex built from config, so read those closely.

## Electron boundary

- One `BrowserWindow`, with `contextIsolation`, `sandbox` and no `nodeIntegration`. No webviews or extra windows: no IPC handler checks `senderFrame`, so a second webContents needs sender validation first.
- Navigation is denied, never turned into `shell.openExternal`. That happens only in `openExternally`, after `validateUrl` (`packages/desktop/src/main/window-guards.ts`). Permissions are denied by default. The renderer has no network access, so all network I/O lives in main.
- The preload exposes typed methods only, never `ipcRenderer` or a generic invoke (`packages/desktop/src/preload/preload.ts`). Untrusted HTML is never inserted as HTML; release notes render through an allow-listed tree (`packages/ui/src/lib/release-notes.ts`).
- An IPC handler types its payload as `unknown` and parses it before any fs, DuckDB, spawn or network work, then uses only the parsed value (model: `packages/desktop/src/main/handlers/dimensions-payload.ts`). Telemetry, MCP and update preferences each have their own handler and parser, and opt-ins fail closed. Never route them through the generic UI-preferences save.

## Processes and cloud calls

- CLIs are spawned only through `findAwsCli`, `findGcloudCli` and their siblings in `packages/core/src/sync/trusted-binaries.ts`, with argv arrays. When one isn't found, the feature is disabled; there is no PATH fallback. The only `shell: true` is gcloud on Windows, through `gcloudSpawnShape`.
- Validate identifiers from shared config before they reach an SDK or a spawn: GCS buckets with `assertValidGcsBucketName`, S3 keys against the configured prefix. Only `createGcsStorage` builds a GCS client.
- The app makes two cloud writes, both explicit user actions: uploading a config bundle to S3 and opening an AWS Support case. It never creates cloud resources.
- Config bundles carry no credentials (`toSharedProvider`). Keep any new credential-like provider field out of `SharedProviderConfig`.

## Listeners

- There are two: the MCP server on loopback and peer sharing on port 53178. A third needs opt-in, authentication and bounds.
- MCP: opt-in. It binds only 127.0.0.1 and ::1 and checks the Host allow-list first. The token comes only from `Authorization: Bearer`, is compared in constant time, and is checked on every request. All MCP SQL runs on the sandboxed DuckDB (`packages/desktop/src/main/mcp-sandbox.ts`, `packages/core/src/query/duckdb-sandbox.ts`), with `lock_configuration` set last. Every billing or config string in tool output goes through `toSingleLine` or `escapeMarkdownCell`.
- Peer sharing starts only from its Enable action. Before anything from a peer is used: the signature is verified, the publisher pinned, paths checked with `isSafePackPath`, reads contained by `readFileWithinRoot`, hashes checked and buffers capped. Config and enrichment need the user's consent.
- A secret file is written with mode `0600` plus a chmod (as `packages/desktop/src/main/mcp-token.ts` does) and listed in README's "Security & data at rest".

## Telemetry and other egress

- Sentry starts only when the user turned a channel on. Every event passes the channel gate, then `redactEventInPlace`, then the outbox. Never attach business data to scope, user, tags or extras, or enable screenshots or child-process arguments. A new context name goes into the allow-list in `packages/desktop/src/main/telemetry/scrub-event.ts`.
- `packages/core/src/telemetry/scrub.ts` only recognizes AWS-shaped values, so GCP buckets and projects, and labels that breadcrumbs pick up (the `aria-label` or `title` of a clicked element holding a filter value or account name), pass through. Flag new ones.
- The updater runs in packaged builds only: no automatic download or install, no install identifier, and both the preference and `COSTGOBLIN_DISABLE_UPDATE_CHECK` turn it off.
- CSV string cells go through the formula guard. Regexes from config or peers run only through `stripNamesBounded`; scrub regexes must be linear.

## Intentional, don't flag

- `rejectUnauthorized: false` in the peer client: it is TLS-PSK with no certificates, pinned by publisher key. It only becomes a bug if a non-PSK cipher is added.
- The `run_sql` regex guard is bypassable by design (`packages/mcp/src/tools/run-sql.ts`); the sandbox is the control. Report only escapes from the sandbox.
- The unauthenticated, Host-checked MCP `/health`; `http:` allowed in `validateUrl`, since it only opens the system browser; the update check being on by default.
- SPEC.md's Electron Security section is stale (it says `sandbox: false`). The code is right.
- Existing `as` casts on explorer payloads and missing `senderFrame` checks are tracked already; flag new ones only.
