/** Non-blocking corner badge shown on a dashboard widget while its underlying
 *  rollup partition re-rolls after a sync. Signals the figure is briefly stale
 *  (the previous partition's numbers) rather than wrong. */
export function UpdatingBadge(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-border bg-bg-secondary/90 px-2 py-0.5 text-[11px] font-medium text-text-secondary shadow-sm backdrop-blur"
    >
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-border border-t-accent"
      />
      updating…
    </div>
  );
}
