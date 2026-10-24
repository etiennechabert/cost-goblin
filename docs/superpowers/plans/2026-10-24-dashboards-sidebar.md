# Dashboards Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top bar's "Dashboards ▾" popover with a sidebar left of the dashboard page, and turn the top-bar button into a link to the last dashboard viewed.

**Architecture:** A presentational `DashboardsSidebar` in the desktop renderer, laid out by App.tsx beside `CustomView` only for `view.page === 'custom'`. App keeps the last dashboard id in state; the top-bar button navigates to it through `handleNavClick`.

**Tech Stack:** React 19, Tailwind v4, lucide-react, Vitest + RTL (`desktop-renderer` project), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-24-dashboards-sidebar-design.md`

## Global Constraints

- Sidebar styling matches the Settings rail (`packages/ui/src/components/settings-shell.tsx`): `w-56 shrink-0 border-r border-border bg-bg-secondary/40 p-3`, `sticky` at `top: topOffset`, row classes copied from its tab buttons.
- Sidebar is `<nav aria-label="Dashboards">`; the open dashboard's row button has `aria-current="page"`.
- Star buttons keep today's labels: `"<name> is the default dashboard"` (disabled) / `"Set <name> as default"`, title `Default dashboard` / `Set as default`.
- Top-bar button: accessible name `Dashboards`, tooltip name `Dashboards`, description `Open the last dashboard`; no `aria-haspopup`/`aria-expanded`.
- Last dashboard is in memory only; starts at the default dashboard; falls back to the default when it no longer exists.
- No `as`, `!`, `any`, `eslint-disable`; `npm run check` must pass.

## Review Focus

- A dashboard name longer than the sidebar: the row truncates and shows the full name in its `title`.
- More dashboards than fit the window: the sidebar scrolls on its own (`max-height` = viewport below the header, `overflow-y-auto`), the page doesn't grow.
- The last dashboard viewed is deleted from views.yaml: the top-bar button opens the default dashboard, not a missing one (`resolveLastDashboard`).
- views.yaml fails to load: the sidebar still lists the fallback Cost Overview, and the load-error banner sits in the content column.
- Leaving a dashboard for Trends and coming back with the top-bar button lands on the dashboard left, not on Home's.

---

### Task 1: `DashboardsSidebar` component

**Files:**
- Create: `packages/desktop/src/renderer/dashboards-sidebar.tsx`
- Test: `packages/desktop/src/__tests__/dashboards-sidebar.test.tsx`

**Interfaces:**
- Produces:
  - `export interface DashboardItem { readonly id: string; readonly name: string }`
  - `export function DashboardsSidebar(props: Readonly<{ items: readonly DashboardItem[]; activeId: string; defaultId: string; onSelect: (id: string) => void; onSetDefault: (id: string) => void; topOffset: number }>): React.JSX.Element`
  - `export function resolveLastDashboard(lastId: string | null, items: readonly DashboardItem[], fallbackId: string): string` — `lastId` when it is among `items`, else `fallbackId`.

- [ ] **Step 1: Write the failing tests** (port the list-behaviour cases of `dashboards-dropdown.test.tsx`; the sidebar is `screen.getByRole('navigation', { name: 'Dashboards' })`, rows are its `listitem`s)

  - `lists the default dashboard first, then the rest in order` — listitems' textContent `['Team costs', 'Overview', 'Kubernetes']` with `defaultId: 'teams'`.
  - `keeps the given order when the default is not among the dashboards` — `defaultId: 'deleted'` → `['Overview', 'Team costs', 'Kubernetes']`.
  - `marks the open dashboard as the current page` — `activeId: 'k8s'`: button `Kubernetes` has `aria-current="page"`, `Overview` has none.
  - `opens a dashboard` — click `Kubernetes` → `onSelect('k8s')`.
  - `stars another dashboard as the default, but not the one already starred` — `Team costs is the default dashboard` is disabled; click `Set Overview as default` → `onSetDefault('overview')`, `onSelect` not called.
  - `shows a long name in full on hover` — row button for a 60-char name has `title` equal to the name and class `truncate`.
  - `sticks below the header and scrolls on its own` — `topOffset: 80`: nav `style.top === '80px'`, `style.maxHeight === 'calc(100vh - 80px)'`, class contains `overflow-y-auto`.
  - `resolveLastDashboard`: `('k8s', ITEMS, 'teams') → 'k8s'`, `('deleted', ITEMS, 'teams') → 'teams'`, `(null, ITEMS, 'teams') → 'teams'`.

- [ ] **Step 2: Run** `npx vitest run packages/desktop/src/__tests__/dashboards-sidebar.test.tsx` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `dashboards-sidebar.tsx`. Sorting is the dropdown's `useMemo` (default first). Each `li` is `flex items-stretch gap-0.5`: the star button (from the dropdown, unchanged) then the select button (settings-rail row classes, `flex-1 min-w-0 truncate text-left`, `title={item.name}`). Nav style: `{ top: topOffset, maxHeight: \`calc(100vh - ${String(topOffset)}px)\` }` plus `self-start overflow-y-auto`.

- [ ] **Step 4: Run** the same command — expect PASS.

- [ ] **Step 5: Commit** `feat(dashboards): add the dashboards sidebar`

### Task 2: Wire the sidebar and the Dashboards button into App

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx` (import ~8, dashboard render ~1325-1345, top-bar nav ~1168-1174, nav state near `handleNavClick` ~846)
- Delete: `packages/desktop/src/renderer/top-menu/dashboards-dropdown.tsx`, `packages/desktop/src/__tests__/dashboards-dropdown.test.tsx`
- Test: `packages/desktop/src/__tests__/app-shell.test.tsx`

**Interfaces:**
- Consumes: `DashboardsSidebar`, `resolveLastDashboard`, `DashboardItem` from Task 1.

- [ ] **Step 1: Update/add app-shell tests**

  - Tooltip table row → `{ button: 'Dashboards', name: 'Dashboards', line: 'Open the last dashboard' }`.
  - `falls back to the seed dashboard when none are configured` and `still boots when … cannot be read`: instead of clicking the button and reading the menu, read `within(screen.getByRole('navigation', { name: 'Dashboards' })).getAllByRole('listitem')` textContent → `['Cost Overview']`.
  - New `shows the dashboards sidebar only on a dashboard`: after boot the `Dashboards` navigation exists and `Dashboards` header button has `aria-current="page"`; click `Explorer` → navigation gone, header button `aria-current` null.
  - New `switches dashboards from the sidebar`: click sidebar button `Team costs` → heading `Team costs`; its row button has `aria-current="page"`.
  - New `the Dashboards button reopens the last dashboard`: click sidebar `Team costs`, click `Trends`, click header `Dashboards` → heading `Team costs`.
  - New `the Dashboards button opens the default dashboard first`: boot, click `Trends`, click `Dashboards` → heading `Cost Overview`.

- [ ] **Step 2: Run** `npx vitest run packages/desktop/src/__tests__/app-shell.test.tsx` — expect the new/changed cases to FAIL.

- [ ] **Step 3: Implement in App.tsx**

  - State: `const [lastViewId, setLastViewId] = useState<string | null>(null);` and an effect setting it to `view.viewId` whenever `view.page === 'custom'`.
  - Top bar: replace `<DashboardsDropdown …/>` with a `ButtonTooltip name="Dashboards" description="Open the last dashboard"` wrapping a button built exactly like the `ANALYTICAL_NAV` buttons (icon `Gauge`, label `Dashboards` when active), active when `settingsTab === null && view.page === 'custom'`, `onClick={() => { handleNavClick(resolveLastDashboard(lastViewId, customNav, homeViewId)); }}`.
  - Dashboard page: wrap the custom-view block in `<div className="flex items-start">` with `<DashboardsSidebar items={customNav} activeId={shownViewId(view.viewId)} defaultId={homeViewId} onSelect={handleNavClick} onSetDefault={handleSetDefaultView} topOffset={headerHeight} />` and a `min-w-0 flex-1` column holding the `ViewsLoadError` banner and the `Profiler`/`CustomView`.
  - Delete the dropdown file, its test, and its import.

- [ ] **Step 4: Run** `npx vitest run packages/desktop/src/__tests__/app-shell.test.tsx packages/desktop/src/__tests__/dashboards-sidebar.test.tsx` — expect PASS.

- [ ] **Step 5: Commit** `feat(dashboards): pick dashboards from a sidebar, the top-bar button reopens the last one`

### Task 3: e2e helpers and suites

**Files:**
- Modify: `e2e/helpers.ts` (~566-660), `e2e/clickability.test.ts` (~493-525), `e2e/views-defaults.test.ts` (~90-105, ~246), `e2e/diag/clickability.diag.ts` (~45, ~500)

**Interfaces:**
- Produces (helpers.ts): `export async function openDashboardsSidebar(page: Page): Promise<Locator>` — leaves setting mode, clicks the top-bar `Dashboards` button unless `navigation "Dashboards"` is visible, returns that navigation locator. Replaces `openDashboardsDropdown` (removed).

- [ ] **Step 1: Update helpers.** `clickNavButton`'s custom-dashboard branch: `(await openDashboardsSidebar(page)).getByRole('button', { name: resolved, exact: true }).click()`. Refresh the comment block above `DIRECT_NAV` ("left nav / Dashboards sidebar").
- [ ] **Step 2: Update suites.**
  - views-defaults: `menuitem` → sidebar `button` with exact name (`Cost Overview` has `aria-current="page"`); the list assertion uses `sidebar.getByRole('listitem')` `toHaveText([...DEFAULT_VIEWS, 'Top spenders'])`; drop the `Escape` presses.
  - clickability: popover-row test becomes `the Dashboards sidebar's first row is clear of the header drag region` (`expectClickable` on the first `listitem`'s two buttons); `opens its list from any page` becomes `the Dashboards button reopens the last dashboard from any page` (Trends → `Dashboards` → heading `Cost Overview`, sidebar visible).
  - diag: `visit('home › Dashboards sidebar', () => openDashboardsSidebar(page).then(() => undefined))` with no close step.
- [ ] **Step 3: Run** `npx tsc --noEmit -p e2e` (or the repo's e2e typecheck via `npm run check`) — expect clean; then `npm run build --workspace=packages/desktop && npx playwright test e2e/views-defaults.test.ts e2e/clickability.test.ts e2e/views-core.test.ts` — expect PASS.
- [ ] **Step 4: Commit** `test(e2e): navigate dashboards through the sidebar`

### Task 4: Full verification

- [ ] `npm run build:worker --workspace=packages/desktop && npm run check` — expect PASS.
- [ ] Launch the app (run-desktop skill), open a dashboard, switch from the sidebar, star another default, go to Trends and back with the top-bar button; check light and dark themes.
