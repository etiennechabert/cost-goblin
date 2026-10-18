# What to look for in CostGoblin

People decide where cloud money goes from CostGoblin's numbers, and the app promises their billing data stays on their machine. Spend the review on, in this order:

1. **Wrong numbers.** A total, filter, grouping, date window or rollup that silently disagrees with the raw data (`sql-and-cost-math.md`).
2. **Data leaving the machine, or untrusted input reaching a sink** (`security-and-privacy.md`).
3. **Lost or corrupted user state**: config and state files, the data directory, files users already have (`sync-and-config.md`).
4. **Broken interaction**: a control that can't be clicked, a dialog that loses state, a view that stalls on a large account (`ui-and-tests.md`).

The other files in this directory hold the checks for each area.

## Don't comment on

- Anything `npm run check` already fails on, such as type errors and lint rules. CI runs it on every PR. Formatting and import order aren't enforced, so leave them alone too.
- Style, naming or comment length. The long comments are deliberate: they record why a guard exists, often citing the incident behind it.
- Fixes that would need a construct CLAUDE.md bans (`any`, `as`, `!`, `@ts-ignore`, `eslint-disable`, `localStorage`) or a library its "Frontend Stack" rules out.
- Coverage percentages, which SonarCloud gates. Do flag a test that doesn't exercise the behavior the PR changes.
- Cognitive complexity up to 25, the project's threshold (Sonar's profile still says 15).

## Do flag: bans that no lint rule enforces

CLAUDE.md bans `as` assertions and `eslint-disable` comments, but no lint rule enforces either, and dozens of `as` already exist. Nothing under `e2e/` is type-checked or linted at all. Flag new instances in the diff; leave existing ones alone.

## How to report

- Prefer one finding with a concrete failing input, state and wrong output over several speculative ones.
- Suggested code must do everything the finding says.
- PR descriptions here state the intent and design decisions at length. Check the code against what the description claims.
- When a `.gitar/` file names a helper or path that no longer exists, report the stale instruction rather than flagging the code.
