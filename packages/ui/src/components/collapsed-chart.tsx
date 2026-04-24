export function CollapsedChart({ title, onExpandToggle }: { title: string; onExpandToggle?: (() => void) | undefined }) {
  return (
    <button
      type="button"
      onClick={onExpandToggle}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary/50 px-2 py-6 hover:bg-bg-tertiary/30 transition-colors min-h-[260px]"
    >
      <span className="text-xs font-medium text-text-secondary [writing-mode:vertical-rl] rotate-180">
        {title}
      </span>
    </button>
  );
}
