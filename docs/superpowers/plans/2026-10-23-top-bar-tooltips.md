# Top-bar Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every top-bar button shows an instant, arrowed, styled tooltip (name + one short line) in place of its native `title`. Sync and Rollup keep their click-open popovers, which gain an arrow.

**Architecture:** A shared `ButtonTooltip` in `packages/ui` wraps Radix Tooltip (its own provider, `delayDuration={0}`) and can be held shut with `suppressed` while a button's popover is open. `PopoverContent` gains an opt-in `arrow` prop. The desktop header (`App.tsx` and `top-menu/*`) swaps every `title=` for `ButtonTooltip`.

**Tech Stack:** React 19, `@radix-ui/react-tooltip` 1.4.1 (new), Radix Popover, Tailwind v4 tokens, Vitest + RTL + user-event, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-top-bar-tooltips-design.md`

## Global Constraints

- Copy is exactly the spec's table (name / line). Settings' line reads `Update available` while an update is pending.
- No tooltip on the centre column (title, workspace chip, branch / PR link). No other `title=` in the app changes.
- No native `title` left on any of the 13 listed buttons. `aria-label`s stay as they are.
- Tooltip look: `bg-bg-secondary`, `border border-border`, `rounded-lg` (8px), `text-xs` (12px), `shadow-md`, name `font-semibold text-text-primary`, line `text-text-secondary`. The arrow uses the same fill and border.
- Placement: `side="bottom"`, `sideOffset={6}`, `collisionPadding={8}`.
- CLAUDE.md rules: no `as`, `!`, `any`, `eslint-disable`, `console.log`. Run `npm run check` after every task (build the worker first: `npm run build:worker --workspace=packages/desktop`).
- Version: `package.json` and `packages/desktop/package.json` are both `0.9.0` = latest tag `v0.9.0`, so this PR bumps both to `0.9.1`. Leave `package-lock.json`'s own version field alone.

## Review Focus

1. **Content under the header must stay clickable while a tooltip shows or fades.** Expect `pointer-events: none` on the tooltip and no hoverable content. This guards Playwright clicks and `clickability.test.ts` hit-tests. Pinned in Task 1.
2. **No tooltip over or beside an open popover/menu (Dashboards, Data sync, Rollup), even when the pointer re-enters the button.** Pinned in Tasks 1 and 2.
3. **After a click the tooltip stays shut while the pointer stays on the button.** A nav button re-renders wider when it becomes active. Pinned in Task 1.
4. **No double tooltip.** None of the 13 buttons may keep a native `title`. Pinned in Task 3.
5. **Keyboard.** Tab onto a button shows its tooltip, and Escape dismisses it. Pinned in Task 1.

---

### Task 1: `ButtonTooltip` and the popover arrow (`packages/ui`)

**Files:**
- Modify: `packages/ui/package.json` (dependency), `package-lock.json`
- Create: `packages/ui/src/components/ui/tooltip.tsx`
- Modify: `packages/ui/src/components/ui/popover.tsx`
- Modify: `packages/ui/src/index.ts:25` (exports)
- Test: `packages/ui/src/__tests__/button-tooltip.test.tsx`

**Interfaces:**
- Produces:
  - `ButtonTooltip(props: { name: string; description: string; suppressed?: boolean | undefined; children: React.ReactElement }): React.JSX.Element`. The child is used via `TooltipTrigger asChild`, so it may itself be a `PopoverTrigger asChild` wrapping the button.
  - `PopoverContent` accepts `arrow?: boolean | undefined` (default `false`).
  - Both are exported from `@costgoblin/ui`.

- [ ] **Step 1: Branch and dependency**

```bash
git switch -c feat/top-bar-tooltips
npm install @radix-ui/react-tooltip@^1.4.1 --workspace=packages/ui
```
Expected: the install succeeds with no `ESTRICTALLOWSCRIPTS`. The lockfile-integrity one-liner from CLAUDE.md prints `all entries verified`.

- [ ] **Step 2: Write the failing tests** in `button-tooltip.test.tsx`. Render `<ButtonTooltip name="Data sync" description="Billing data downloads"><button type="button" aria-label="Data sync">x</button></ButtonTooltip>`.
  - `shows the name and line on hover, with no delay`: `await user.hover(button)`. Then `within(screen.getByRole('tooltip'))` has the text `Data sync` and `Billing data downloads`, with no fake timers or waiting.
  - `shows on keyboard focus and Escape dismisses it`: `await user.tab()` makes the tooltip present. `await user.keyboard('{Escape}')` makes `queryByRole('tooltip')` null.
  - `closes on click and stays closed while the pointer stays on the button`: hover, click, and the tooltip is null. Then `await user.pointer({ target: button })` (a move within the button), and it is still null.
  - `never opens while suppressed`: render with `suppressed`. Hover and focus give `queryByRole('tooltip')` null. Rerender with `suppressed={false}`, unhover, then hover, and the tooltip is present.
  - `does not add a native title`: `button.getAttribute('title')` is `null` before and during hover.
  - `cannot take the pointer`: the visible content node (the closest `[data-side]` ancestor of the visible `Data sync` text) has class `pointer-events-none`.
  - `PopoverContent draws an arrow only when asked`: render a `Popover` with `open` and `<PopoverContent arrow>`. It contains the Radix arrow element (`svg` inside the content). Without `arrow`, it has none.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/ui/src/__tests__/button-tooltip.test.tsx`
Expected: FAIL, because `ButtonTooltip` is not exported.

- [ ] **Step 4: Implement `tooltip.tsx`.** Use the shadcn-style re-exports (`TooltipProvider`, `Tooltip`, `TooltipTrigger`) plus a `TooltipContent` forwardRef that wraps a Portal.
  - `TooltipContent` takes the Global Constraints card classes, plus `pointer-events-none`, `NO_DRAG` (as `PopoverContent` does: it can overlap the header's drag band), and `z-50`. It renders `TooltipPrimitive.Arrow` with the same fill and border.
  - `ButtonTooltip` renders `TooltipPrimitive.Provider delayDuration={0} disableHoverableContent`. It does this itself, so no App-level provider is needed and component tests need no wrapper. That is a deviation from the spec's single App provider, with the same behaviour at delay 0.
  - Inside it, `Tooltip` is controlled: `open={suppressed !== true && open}`, `onOpenChange={setOpen}`.
  - It renders the name in a `font-semibold text-text-primary` span and the line in a `text-text-secondary` span, stacked, at `max-w-[220px]`.

- [ ] **Step 5: Add `arrow` to `PopoverContent`.** Destructure `arrow = false` and render `PopoverPrimitive.Arrow` with the same arrow styling when true. Share one arrow class/element constant with `tooltip.tsx` so the two can't drift. Export `ButtonTooltip` from `index.ts`.

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npx vitest run packages/ui/src/__tests__/button-tooltip.test.tsx`, then `cd packages/ui && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit** the spec, plan, dependency, component and test: `feat(ui): ButtonTooltip and popover arrow`.

---

### Task 2: Sync, Rollup and Dashboards buttons (`top-menu/`)

**Files:**
- Modify: `packages/desktop/src/renderer/top-menu/sync-status-button.tsx` (drop `buttonTitle`, `:89-96`, and its use `:166,179`)
- Modify: `packages/desktop/src/renderer/top-menu/rollup-status-button.tsx` (drop `tooltipFor`, `:14-27`, and `months` if now unused; `:56`)
- Modify: `packages/desktop/src/renderer/top-menu/dashboards-dropdown.tsx:51`
- Test: `packages/desktop/src/__tests__/sync-status-button.test.tsx`, `rollup-status-button.test.tsx`, `dashboards-dropdown.test.tsx`

**Interfaces:**
- Consumes: `ButtonTooltip` and `PopoverContent arrow` from Task 1.

- [ ] **Step 1: Rewrite the failing tests.**
  - **sync-status-button:** the `shows $name` table keeps its `badge` column and loses `title`. Each row also asserts `trigger().getAttribute('title')` is `null`. Delete the `Syncing…` title test (`:88`). Add `explains itself on hover`: the hovered tooltip reads `Data sync` / `Billing data downloads`, including with `error: 'Network down'`, because status stays out of the hover. Add `hides the tooltip while its popover is open`: click opens the popover. Then unhover, re-hover, and `queryByRole('tooltip')` is null. The popover content is still shown.
  - **rollup-status-button:** replace the `describes a $status.state rollup` table with the same two tests, using `Rollup` / `Pre-aggregated data for fast dashboards`. Also assert that a `failed` status's message still appears in the popover (`RollupStatusDetail`) after a click.
  - **dashboards-dropdown (`:47`, `:54`):** both states give a `null` title. Hover gives `Dashboards` / `Switch or pin a dashboard`, and that holds while a dashboard is active too. Add the popover-open suppression test.
  - **All three:** the opened popover contains an arrow `svg` for Sync and Rollup.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/desktop/src/__tests__/sync-status-button.test.tsx packages/desktop/src/__tests__/rollup-status-button.test.tsx packages/desktop/src/__tests__/dashboards-dropdown.test.tsx`
Expected: FAIL on the `title` and tooltip assertions.

- [ ] **Step 3: Implement.** In each component, wrap `PopoverTrigger asChild` in `<ButtonTooltip name=… description=… suppressed={open}>`, remove `title=`, and pass `arrow` to the Sync and Rollup `PopoverContent`. Keep `aria-label`s. Leave the in-popover `title`s ("Check for new data", "Set as default", the last-sync time) alone.

- [ ] **Step 4: Run the tests and make sure they pass** (same command, then `cd packages/desktop && npm run check`). Expected: PASS.

- [ ] **Step 5: Commit**: `feat(desktop): tooltips on the sync, rollup and dashboards buttons`.

---

### Task 3: The rest of the header (`App.tsx`) and the e2e selector

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx:86-92` (`ANALYTICAL_NAV`), `:1151-1159` (Home), `:1189`, `:1200-1206` (Done), `:1231-1304` (Debug, Reload, Settings)
- Modify: `e2e/clickability.test.ts:201` (`gearWithUpdate`)
- Modify: `package.json`, `packages/desktop/package.json` (`0.9.0` → `0.9.1`)
- Test: `packages/desktop/src/__tests__/app-shell.test.tsx`

**Interfaces:**
- Consumes: `ButtonTooltip` from Task 1.
- Produces: `AnalyticalNavItem` gains `readonly description: string`. The Settings button carries `data-update-available="true"` while the update dot shows, so e2e can find it by CSS now that `title` is gone.

- [ ] **Step 1: Write the failing tests** in `app-shell.test.tsx`.
  - Add `describe('App shell — header tooltips')` with an `it.each` over the spec table. For Home, Dashboards, Trends, Findings, Baselines, Tags, Explorer, Debug panel, Reload data, Data sync, Rollup and Settings: hovering `headerButton(<aria-label>)` shows a tooltip containing exactly that name and line, and the button's `title` is `null`.
  - The active-page row: open Explorer (`:191-197`), and hovering it still shows `Explorer` / `Inspect the raw billing data`.
  - `Done`: enter settings, then hover the `Done, return to dashboards` button. It shows `Done` / `Back to dashboards`.
  - Rewrite the old title assertions:
    - `:178` and `:209`: assert the Home tooltip (`Home` / `Your default dashboard`).
    - `:390`: show that the new default stuck by clicking Home and checking which dashboard renders. The tooltip no longer names it.
    - `:426`: hover Settings, the line reads `Update available`, and the button has `data-update-available="true"`.
    - `:197`: drop the `title` check.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/desktop/src/__tests__/app-shell.test.tsx`
Expected: FAIL on the new tooltip rows.

- [ ] **Step 3: Implement.**
  - Add the spec's lines to `ANALYTICAL_NAV` as `description`.
  - Wrap each listed button in `ButtonTooltip` and remove its `title=`. The Home `tooltip` variable goes.
  - Settings: `description={showUpdate ? 'Update available' : 'App and workspace settings'}`, plus `data-update-available`.
  - Leave `renderBuildIndicator`'s titles and `WorkspaceChip` untouched.
  - Update `gearWithUpdate` to `button[aria-label="Settings"][data-update-available="true"]` and fix its doc comment.
  - Bump both `package.json` versions to `0.9.1`.

- [ ] **Step 4: Run the tests and make sure they pass**: the same vitest command, then `npm run build:worker --workspace=packages/desktop && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**: `feat(desktop): instant tooltips on every top-bar button`.

---

### Task 4: End-to-end and visual verification

- [ ] **Step 1: e2e.** Run `npx playwright test e2e/clickability.test.ts e2e/views-core.test.ts`. Expected: PASS. Any `intercepts pointer events` failure points back at Review Focus 1.
- [ ] **Step 2: Real app.** Use the `run-desktop` skill. In dark and light themes:
  - Hover across the whole bar: each tooltip appears instantly and switches without a flash.
  - The arrow points at the hovered button.
  - Settings' tooltip stays inside the window at the right edge.
  - Clicking Sync / Rollup / Dashboards shows the popover (with an arrow on Sync / Rollup) and no tooltip.
  - The window still drags from the empty bar.

  Screenshot one dark and one light tooltip for the PR.
- [ ] **Step 3: Close the review loop** per CLAUDE.md "After pushing": push, open the PR, run `/code-review xhigh --fix`, then answer Sentry, Gitar and SonarCloud. Read `.gitar/review/`'s UI-and-tests guide before pushing.
