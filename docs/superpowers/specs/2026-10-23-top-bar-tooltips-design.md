# Top-bar tooltips — design

## Intent

Most top-bar buttons are bare icons, and their only explanation is a native `title` that shows late, unstyled and without context. Every top-bar button gets a custom tooltip that appears immediately, points at the hovered button with an arrow, and gives the feature's name plus a very short description.

## Goals

- Instant, styled, arrowed tooltip on every top-bar button (list below).
- Content: **name** (bold) + one very short muted line. Data sync and Rollup add a third line: their live status, under a divider, toned by a dot (red error, pulsing green busy, amber warning, muted ok).
- Sync and Rollup keep opening their popover on **click**. The popover gains an arrow pointing at the button.

## Non-goals

- The centre of the bar (CostGoblin title, workspace chip, branch / PR link) gets no tooltip.
- Live status appears only on Data sync and Rollup (revised after review: it was first left to the badges and popovers).
- No other `title=` attributes elsewhere in the app are converted.

## Anti-goals

- Two tooltips at once (native + custom) on any button.
- A tooltip showing over, or reappearing over, a button's open popover or menu.

## Scope and copy

| Button | Name | Line |
|---|---|---|
| Goblin logo | Home | Your default dashboard |
| Dashboards menu | Dashboards | Switch or pin a dashboard |
| Trends | Trends | Period-over-period changes |
| Findings | Findings | Savings recommendations |
| Baselines | Baselines | Track drift against a baseline |
| Tags | Tags | Find untagged spend |
| Explorer | Explorer | Inspect the raw billing data |
| Debug panel | Debug panel | Queries and logs |
| Reload data | Reload data | Clear cache and refetch |
| Data sync | Data sync | Billing data downloads |
| Rollup | Rollup | Pre-aggregated data for fast dashboards |
| Settings | Settings | App and workspace settings (reads "Update available" when an update is pending) |
| Done (settings mode) | Done | Back to dashboards |

## Behaviour

- Opens with no delay; moving between buttons switches tooltips instantly.
- Placed below the button, arrow pointing up; shifts to stay inside the window (Settings sits at the right edge).
- Closes on click, and stays closed while that button's popover or menu (Dashboards, Data sync, Rollup) is open.
- Also opens on keyboard focus.
- Active nav items get the tooltip too, even though their label is visible.
- `title=` is removed from these buttons; `aria-label`s stay, and the tooltip text is linked as the button's description.

## Look

Style A from the mockups: the chart-tooltip card (`bg-bg-secondary`, `border-border`, 8px radius, 12px text, shadow), name in `text-text-primary` semibold, line in `text-text-secondary`, arrow in the same fill and border. Works in dark and light themes via the existing tokens.

## Approaches

1. **Radix Tooltip as a shared `Tooltip` in `packages/ui` — chosen.** Adds `@radix-ui/react-tooltip` (1.4.1 clears the 7-day release-age rule; its popper/arrow/portal/dismissable-layer deps are already in the tree, no install scripts). Gives instant open with skip-delay, collision handling, arrow, Escape/focus and `aria-describedby` for free.
2. Hover-opened Radix Popover. No new dep, but hand-rolled hover timing and skip-delay, dialog semantics instead of a description, and outside-click conflicts with the button's own popover.
3. Hand-rolled on floating-ui. Full control, but re-implements everything option 1 provides.

## Decided how

- `Tooltip` / `TooltipProvider` / `TooltipTrigger` / `TooltipContent` (shadcn-style) in `packages/ui/src/components/ui/tooltip.tsx`, plus a small `IconTooltip`-style wrapper taking `name` and `description`.
- One `TooltipProvider delayDuration={0}` around the app in `App.tsx`.
- Popover buttons nest `TooltipTrigger asChild` inside `PopoverTrigger asChild`; the tooltip is held closed while the popover is open.
- `PopoverContent` gets an optional `arrow` prop, enabled for Sync and Rollup.

## Left to the builder

- Exact offset, shadow and arrow size; collision padding.
- Wrapper component name and file layout.
- Tests: renderer tests that hover shows name + line, popover-open suppresses the tooltip, no `title` remains on the listed buttons; an e2e hover check if cheap.
- Header buttons sit in a `-webkit-app-region: drag` bar; they are already `no-drag`, verify hover fires in the real app.
