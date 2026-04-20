# Simplification: Remove Unused Normalization Modes

## Problem

The tag normalization system supports 5 normalization modes: `lowercase`, `uppercase`, `lowercase-kebab`, `lowercase-underscore`, and `camelCase`. Analysis of all fixture configs, real configs, and test data shows that only 3 are actually used:

| Mode | Usage |
|------|-------|
| `lowercase` | 4 dimensions across configs |
| `lowercase-kebab` | 2 dimensions across configs |
| `uppercase` | 2 dimensions across configs |
| `lowercase-underscore` | **0 — never used** |
| `camelCase` | **0 — never used** |

The `camelCase` mode is additionally documented in the source as "approximate" — it just removes delimiters rather than implementing true camelCase conversion. This suggests it was speculatively added and never validated against real data.

## Current Implementation

In `packages/core/src/normalize/normalize.ts`, the `normalizeTagValue()` function (lines 14-32) switches on the normalization rule:

```typescript
export function normalizeTagValue(value: string, rule?: NormalizationRule): string {
  if (rule === undefined) return value;
  switch (rule) {
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'lowercase-kebab':
      return value
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    case 'lowercase-underscore':
      return value
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
    case 'camelCase':
      return value.replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase());
  }
}
```

The corresponding SQL generation in `buildNormalizeSql()` (lines 54-75) produces increasingly complex REGEXP_REPLACE expressions for each mode. For `lowercase-kebab`:

```sql
LOWER(REGEXP_REPLACE(REGEXP_REPLACE(tag_team, '([a-z])([A-Z])', '\1-\2'), '[_\s]+', '-', 'g'))
```

When combined with aliases, each normalization function is repeated N+1 times in the generated CASE expression (once per alias bucket plus the ELSE clause).

The `NormalizationRule` type is defined in `packages/core/src/types/config.ts`:

```typescript
export type NormalizationRule = 'lowercase' | 'uppercase' | 'lowercase-kebab' | 'lowercase-underscore' | 'camelCase';
```

## Proposed Change

Remove the `lowercase-underscore` and `camelCase` modes from the codebase.

### What to change

1. **`types/config.ts`**: Remove `'lowercase-underscore' | 'camelCase'` from the `NormalizationRule` union type

2. **`normalize/normalize.ts`**: Remove the two switch cases from both `normalizeTagValue()` and `buildNormalizeSql()`

3. **`config/validator.ts`**: Update validation to reject the removed modes (if they appear in a user's YAML, the validator should produce a clear error message suggesting the supported alternatives)

4. **Tests**: Remove test cases for the deleted modes

### What stays

- `lowercase`, `uppercase`, `lowercase-kebab` — all actively used
- Alias resolution — orthogonal, unaffected
- The overall normalization architecture — still needed for the 3 remaining modes

## Migration

- If a user has `normalize: lowercase-underscore` or `normalize: camelCase` in their dimensions.yaml, config validation will reject it on next load with a clear error message listing the supported modes.
- `lowercase-underscore` users should switch to `lowercase-kebab` (same concept, different delimiter).
- `camelCase` users should remove the normalize rule and rely on aliases for the specific values they want to canonicalize.

## Risks

- **Breaking config**: Any user who has configured one of the removed modes will get a validation error. Given zero usage in fixtures and real configs, this risk is near-zero. The error message makes the fix obvious.

## Estimated Impact

- **~40 lines deleted** across 3 files
- **Type narrowed** from 5 variants to 3
- **Generated SQL slightly simpler** (fewer code paths to reason about)
- **Minor** — this is a small cleanup, not a major simplification. Included because it removes dead code that adds maintenance burden and testing surface.
