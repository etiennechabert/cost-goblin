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
- No resizing or reordering of the sidebar. (Hiding it came later: see
  "Follow-up: pin and auto-hide".)
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

## Follow-up: narrow windows

The sidebar leaves a dashboard 676px at the 900px minimum window, where rows
squeezed every widget by its fixed share. Rows now wrap: a widget wraps onto a
new line instead of getting narrower than its minimum (small 14rem, medium
19rem, large 20rem; three mediums still fit beside the sidebar in the default
1280px window, scrollbar included). A row that fills its 4 columns or more
shares its width by size from a zero flex basis, so a row of three mediums still
fits on one line; a row short of them keeps its percentage bases and splits the
rest evenly, as before. The title column gives way down to 20rem, then the date
picker moves under it.

## Follow-up: pin and auto-hide

A pin in the sidebar's header keeps it in its column (the default) or unpins
it. Unpinned, the sidebar is hidden and the dashboard takes the full width. It
slides in over the dashboard, without reflowing the widgets, when the pointer
rests on an 8px strip along the window's left edge for 150ms, or when the top
bar's Dashboards button is clicked on a dashboard page. That button then works
as a toggle (`aria-expanded`), which gives the keyboard a way in: focus moves to
the open dashboard's row and goes back to the button on Escape or once a
dashboard is picked. The sidebar hides 300ms after the pointer leaves it,
including a pointer that leaves the edge strip without coming onto it, and
also when a dashboard is picked, on Escape, or when focus moves out. While
hidden, `visibility: hidden` keeps it out of the tab order and the
accessibility tree. The slide is a CSS transition that reduced motion turns
off.

The pin is saved with the display preferences (`dashboardsSidebarPinned`) and
is machine-level, like the theme and palette: it lives in app-state.json in
workspace mode, so it holds across workspaces. `resolveWorkspaceEnv` rewrites
app-state.json at every launch and carries the pin over.
