interface HourlyHintBannerProps {
  readonly onDismiss: () => void;
  readonly className?: string;
}

export function HourlyHintBanner({ onDismiss, className }: HourlyHintBannerProps): React.JSX.Element {
  return (
    <div className={['flex items-center justify-between gap-3 rounded-md border border-border bg-bg-tertiary/30 px-3 py-2 text-xs', className ?? ''].join(' ')}>
      <span className="text-text-secondary">
        This range is small enough for hourly resolution, but the hourly tier isn&apos;t configured.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-text-muted hover:text-text-primary"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
