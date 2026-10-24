# Dashboards sidebar

## Intent

Picking a dashboard takes two clicks today: open the top bar's "Dashboards ▾"
popover, then choose. Move the list into a sidebar on the left of the dashboard
page, so the dashboards are always in view while one is open and switching is
one click.

## Goals

- While a dashboard is open, a sidebar left of the dashboard lists every
  dashboard from views.yaml, the default one first, the open one marked.
- Each row keeps its ★ to make that dashboard the default (the one Home opens).
- The top-bar Dashboards button stays, as a plain button (no popover): it is
  active on a dashboard page, and clicking it reopens the last dashboard viewed.

## Non-goals

- No sidebar on Trends, Findings, Baselines, Tags, Explorer or Settings.
- No collapsing, resizing or reordering of the sidebar.
- No change to Settings' rail (`SettingsShell`).

## Constraints

- The sidebar looks like the Settings rail: `w-56`, `border-r`,
  `bg-bg-secondary/40`, sticky below the app header (`top: headerHeight`,
  `minHeight: calc(100vh - headerHeight)`), the same row styling, and
  `aria-current="page"` on the open dashboard.
- Switching goes through `handleNavClick`, so the unsaved-changes guard and the
  query cancel still apply.

## Approaches

- **A. New `DashboardsSidebar` in the desktop renderer (picked).** A new
  component beside today's dropdown, laid out in App.tsx to the left of
  `CustomView` only for `view.page === 'custom'`. Settings is untouched.
- **B. Shared `SideRail` in `@costgoblin/ui`** used by both Settings and
  dashboards. Rejected: the shared part is ~15 lines of frame (dashboard rows
  carry a ★ button Settings tabs don't), and it widens the change to Settings
  and its tests.

## Decided

- `packages/desktop/src/renderer/dashboards-sidebar.tsx` exports
  `DashboardsSidebar` (props: `items`, `activeId`, `defaultId`, `onSelect`,
  `onSetDefault`, `topOffset`) and the `DashboardItem` type. Rows reuse the
  dropdown's sorting (default first) and ★ behaviour.
- `top-menu/dashboards-dropdown.tsx` and its test are deleted; the sidebar gets
  its own test (`dashboards-sidebar.test.tsx`) covering ordering, the active
  mark, selecting, and setting the default.
- The top-bar button: a `Gauge` icon button built like the `ANALYTICAL_NAV`
  ones (icon-only when inactive, icon + "Dashboards" when active), tooltip
  "Dashboards — Open the last dashboard".
- Last dashboard is remembered in memory only (Claude's call, confirmed by the
  user): it starts at the default dashboard on launch, follows every dashboard
  opened, and falls back to the default when it names one that no longer
  exists.
- e2e helpers that open the popover (`e2e/helpers.ts` dashboard navigation,
  `e2e/clickability.test.ts`) click the top-bar button, then the sidebar row.

## Left to the builder

- Keyboard handling in the sidebar (plain tab order is fine; arrow keys
  optional).
- Whether the views-load error banner sits above the sidebar row or inside the
  content column.
