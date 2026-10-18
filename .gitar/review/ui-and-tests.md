# UI and tests

Covers `packages/ui/`, `packages/desktop/src/renderer/` and the test suites, including `e2e/`.

## Overlays and clicks

- Modals use the ModalShell family (`ConfirmModal`, `TitledModal`, `ViewYamlModal`, `WizardModal`, in `packages/ui/src/components/ui/modal-shell.tsx`) or `DialogContent`. A native `<dialog>`, a hand-rolled `fixed inset-0` overlay or raw Radix content skips layer registration, `NO_DRAG` and focus return, and no test catches it.
- A ModalShell is open while mounted: render it conditionally, and pass `dismissable={false}` while an operation runs.
- Name dialogs by their title (`ModalShellTitle`, `DialogTitle`) or `ariaLabel`. An icon-only button needs `aria-label`, because `title` doesn't name it. Never wrap dialog content in `aria-hidden`.
- Set initial focus through `initialFocusRef`. An effect that focuses on prop changes steals focus on every sync poll.
- A modal opened without a user gesture waits while another layer is open (`isAnotherModalLayerOpen`; see `decideUpdateAutoOpen`). Document or window listeners that act must bail while a modal is open.
- Overlays sit at exactly `z-50`, with nothing higher, and no transform or filter on a ModalShell's ancestors.
- The frameless window's header band is an OS drag region, which wins over z-order. Anything painted over it needs `NO_DRAG` (`packages/ui/src/lib/utils.ts`) on its portaled root, and a control overlapping a drag element comes later in the DOM. The header has to fit a 900×600 window.
- External links need `target="_blank"`: a same-window link is silently denied.

## Data, dates and money

- Fetch through `useQuery` (`packages/ui/src/hooks/use-query.ts`). Its dependencies are explicit primitive keys: an object literal refetches every render, a missing key fetches stale values, and no lint catches either. `urgent: true` is only for small results that gate a page. A hand-rolled fetch needs latest-request-wins and must free its widget slot.
- "Last N days" comes only from `lastNDaysRange`. A window that follows an editable lag is stored as trailing-or-fixed and re-derived. Never infer "trailing" from an end date. Calendar Dates are local midnight, so use `parseDay`/`formatDay`, never `toISOString`.
- Money is formatted with `formatDollars`, `signedDollars` and `formatPercent` (`packages/ui/src/components/format.ts`); don't add another private formatter. Money cells keep `.tabular-nums`. CSV string cells go through the formula guard. Show an empty (NULL) entity as `(none)`; don't count it.
- Chart colors come from `getColor` with `usePalette`, so the colorblind palette applies.
- Preference saves send only the fields the view owns. They never echo values read from disk or defaults back, especially after a failed load, and a clean mount writes nothing. A missing file means defaults; an explicit `[]` is the user's choice.
- The UI imports from `@costgoblin/core/browser` only, and additions there must be leaf modules with no Node built-ins. `packages/ui` reaches the app through `useCostApi()`, never `window`.

## Unit tests

- Render inside `CostApiProvider` with `MockCostApi`, adding `PaletteProvider` for charts. Vary behavior by overriding mock methods, not with `vi.mock`. A mock for a new `CostApi` method takes typed parameters and records its calls: a zero-argument mock hides dropped arguments.
- Wait with `findBy` or `waitFor` after a query, and for chart marks rather than titles. Fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`). An assertion that nothing happened must wait past the debounce.
- `queryBy…` followed by `toBeDefined()` always passes; use `.not.toBeNull()`. A regression test should fail with the fix reverted.
- A `.test.tsx` under `packages/desktop` never runs. Move the logic into a plain `.ts` module or cover it in e2e. A new modal goes into `packages/ui/src/__tests__/modal-stacking.test.tsx`.

## E2E

- One app per file, tests in order: restore what a test changes, and put destructive tests last. The clock is pinned (fixture data covers January and February 2026), and launches copy the fixtures, so never point a launch at the committed directories.
- Wait on conditions. `isVisible()` doesn't wait, an `if (await x.isVisible())` that gates the assertion makes the test vacuous, and `waitForTimeout` only proves a bounded absence.
- Locate by role and name. Make no network calls: stub main-process handlers instead.
- A Playwright click bypasses OS drag regions, so it doesn't prove a header-band control is clickable. Assert the region model as `e2e/clickability.test.ts` does.
- The settle helpers in `e2e/helpers.ts` key on `data-widget-id`, `data-widget-state`, the loader's `<output>` and `.tabular-nums`. Renaming any of them makes the waits pass vacuously.
- Register a new suite in: the root `e2e` script, the `test-e2e` matrix and the coverage shard list in `.github/workflows/ci.yml`.

## Intentional, don't flag

Value imports from `@costgoblin/core/browser` (CLAUDE.md's "types only" means never the main entry); lint-driven idioms such as `${String(n)}`, `() => { f(); }` and `void p()`; no logging in the UI; stale-while-refetch state in Explorer and the Cost Scope preview; `useQuery` leaving its fetcher out of the dependencies; "Last N days" spanning N+1 days; the full-window drag root on onboarding screens.
