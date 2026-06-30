# Query fuzzer (Layer 2 — IPC param surface)

Brute-forces the cost-query path with adversarial-but-type-valid `CostQueryParams`
/ `DailyCostsParams` / `EntityDetailParams`, building each case with the **real**
query builders and executing it against the synthetic fixtures with a **real
prepared statement** — binding params exactly the way the DuckDB worker does in
production.

It targets the boundary the security model depends on: identifiers (`groupBy`,
filter keys) are guarded by the `resolveField` allow-list, dates/hours by the
format asserts, and **every other value is a bound parameter**. The fuzzer proves
no hostile value (SQL-injection payloads, unicode, 100k-char strings, malformed
dates, huge value lists) can hang a query or escape parameterization into the SQL
structure.

## Oracle

For each generated case exactly one acceptable outcome must hold — and two
outcomes are flagged as bugs:

| Outcome | Verdict |
|---|---|
| executed; columns ⊆ the query's known schema | ✅ ok |
| rejected by `SecurityError` (allow-list / format assert) | ✅ ok |
| rejected by DuckDB at prepare/run (clean error) | ✅ ok |
| **executed, but columns left the known schema** | ❌ injection |
| **no result within the per-case timeout** | ❌ hang |

The injection oracle is the crown jewel: a successful injection would change the
result's column set (e.g. a `UNION SELECT ... AS pwned`), so a column outside the
query's fixed schema is a programmatic proof that parameterization broke.

## Run it

```bash
# Deterministic regression batch (runs inside `npm run check`)
npx vitest run packages/core/src/__fuzz__/query-fuzz.test.ts

# Soak mode — large batch, fresh random seed each run
npx tsx packages/core/src/__fuzz__/run.ts --count 20000

# Replay a reported seed exactly
npx tsx packages/core/src/__fuzz__/run.ts --seed 49239 --count 5000
```

The soak runner exits non-zero when a bug is found and prints the exact case JSON
(`describeCase`) so any finding replays deterministically from its seed.

## Files

- `prng.ts` — seeded mulberry32 (replayable runs)
- `corpus.ts` — adversarial value pools (injection payloads, hostile dates/ids, unicode, huge strings)
- `generate.ts` — case generators; `intendedValid` tracks identifier/date well-formedness
- `fixture-config.ts` — dimensions config + synthetic-data discovery (mirrors the integration tests)
- `harness.ts` — build → real prepared-statement execute → classify + injection oracle
- `batch.ts` — seeded batch runner + tally, shared by the test and the soak runner
- `query-fuzz.test.ts` — deterministic regression test
- `run.ts` — standalone soak CLI
