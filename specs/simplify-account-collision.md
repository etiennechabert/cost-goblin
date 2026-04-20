# Simplification: Resolve Account Name Collisions at Config Time

## Problem

The account display-name collision handling system adds ~240 lines of branching logic across 5 files. It exists to handle the edge case where two AWS accounts collapse to the same display name after strip patterns are applied (e.g., two accounts both named "sre-default" after stripping the org prefix).

The current approach resolves collisions at query time: an `accountReverseMap` (mapping display names back to multiple account IDs) is threaded through every query builder function, every IPC handler, and every exclusion rule. Post-query, merge functions re-aggregate rows that collapsed to the same name.

This is the classic "pervasive optional parameter" anti-pattern — every function in the query stack carries an extra parameter that is only relevant in a rare edge case. The 240 LOC understates the real cost because it adds cognitive load to reading every query function.

## Current Implementation

### The reverse map pattern

A `ReadonlyMap<string, readonly string[]>` maps each display name to the account IDs it represents. It is:
1. Built in `query-utils.ts` → `buildAccountReverseMap()` (11 LOC)
2. Passed through every query handler in `handlers/query.ts` (7 call sites, ~28 LOC)
3. Passed through explorer handlers in `handlers/explorer.ts` (3 locations, ~21 LOC)
4. Used in `builder.ts` to expand `=` filters into `IN (...)` clauses for account_id (9 branches across buildFilterClauses, buildRuleMatchExpr, buildEntityDetailQuery — ~44 LOC)
5. Used in post-query merge functions: `mergeCostRowsByEntity()` (24 LOC) and `mergeTrendRowsByEntity()` (21 LOC)
6. The account map itself is built in `context.ts` → `getAccountMap()` (~93 LOC)

### Files touched

| File | LOC dedicated | Role |
|------|---------------|------|
| `core/src/query/builder.ts` | ~44 | SQL generation: expand display name to IN clause |
| `desktop/src/main/handlers/query.ts` | ~28 | Thread reverse map through every handler |
| `desktop/src/main/handlers/explorer.ts` | ~21 | Thread reverse map through explorer |
| `desktop/src/main/handlers/query-utils.ts` | ~56 | Build reverse map + merge result rows |
| `desktop/src/main/handlers/context.ts` | ~93 | Build account id→name map with normalization |

### Why the complexity isn't justified

- Account name collisions are extremely rare. Most AWS organizations have unique account names.
- The collision handling adds a branch and a parameter to every function in the query stack — even when there are zero collisions.
- The merge functions add a post-processing step to every query result, even when no merging is needed.
- The pattern requires keeping the SQL generation and result merging in sync — a maintenance burden.

## Proposed Change

Resolve collisions at config time instead of query time. When building the account map, detect duplicate display names and disambiguate them by appending a suffix.

### New approach

In `getAccountMap()` (context.ts), after applying strip patterns and normalization:

1. Build the name→IDs mapping as today
2. For any name that maps to multiple IDs, append the last 4 digits of the account ID as a disambiguator: `"sre-default"` → `"sre-default (…7842)"` and `"sre-default (…3196)"`
3. Return a 1:1 map (each display name is unique)

### What to delete

1. **builder.ts**: Remove all `accountReverseMap?` parameters and the `if (resolved.rawField === 'account_id' && accountReverseMap !== undefined)` branches from:
   - `buildFilterClauses()`
   - `buildRuleMatchExpr()`
   - `buildExclusionClauses()` (parameter only)
   - `buildCostQuery()`
   - `buildTrendQuery()`
   - `buildMissingTagsQuery()`
   - `buildNonResourceCostQuery()`
   - `buildDailyCostsQuery()`
   - `buildEntityDetailQuery()`

2. **query-utils.ts**: Delete `buildAccountReverseMap()`, `mergeCostRowsByEntity()`, and `mergeTrendRowsByEntity()`

3. **query.ts**: Remove all `buildAccountReverseMap()` calls and stop passing the map to builder functions

4. **explorer.ts**: Remove reverse map threading and the special account aggregation logic

### What to change

- **context.ts** `getAccountMap()`: Add collision detection + disambiguation after strip/normalize. ~10 lines of new code replacing ~240 lines of distributed handling.

### What stays

- Account normalization (strip patterns, normalize rules) — these are useful and orthogonal
- The account map itself (id → display name) — still needed for display

## Migration

- No user action needed. Accounts that previously appeared as "sre-default" (ambiguous) will now appear as "sre-default (…7842)" — slightly more verbose but unambiguous.
- Existing filter presets that reference the old ambiguous name will stop matching. This is acceptable because the old behavior was already broken (silently merging different accounts).

## Risks

- **Display name change**: Users who filter by a previously-colliding account name will need to re-select it. This is a one-time adjustment and only affects the rare collision case.
- **Longer display names**: The `(…XXXX)` suffix adds 8 characters. Truncation in narrow UI columns may clip it. Verify that pie chart legends, bar chart labels, and filter chips can accommodate.

## Estimated Impact

- **~240 lines deleted** across 5 files
- **~10 lines added** in context.ts
- **Every query builder function signature simplified** (one fewer parameter)
- **Every IPC query handler simplified** (no reverse map construction or threading)
- **Post-query merge step eliminated**
