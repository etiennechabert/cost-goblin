/** Non-blocking "Updating…" badge overlaid on a dashboard widget while the
 *  rollup partition behind it is being re-rolled (after a sync changed a month,
 *  or a dimensions change). The figure stays visible — briefly served from raw
 *  or the prior partition — so this flags that it's being recomputed, not wrong. */
export function UpdatingBadge(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-border bg-bg-secondary/90 px-2 py-0.5 text-[10px] font-medium text-text-secondary shadow-sm backdrop-blur-sm">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      <span>Updating…</span>
    </div>
  );
}
