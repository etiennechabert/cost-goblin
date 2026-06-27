import type { BaselineStatus } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';

export interface BaselineMicroBarProps {
  readonly lower: number;
  readonly upper: number;
  readonly current: number;
  readonly status: BaselineStatus;
}

function markerColor(status: BaselineStatus): string {
  switch (status) {
    case 'over': return 'bg-negative';
    case 'under': return 'bg-positive';
    case 'in-band': return 'bg-warning';
    default: return 'bg-text-muted';
  }
}

/** Horizontal track with a shaded [lower..upper] band and a vertical current
 *  marker (red above / green below / amber inside). ~30% padding each side. */
export function BaselineMicroBar({ lower, upper, current, status }: BaselineMicroBarProps) {
  const span = Math.max(upper - lower, Math.max(upper, current, 1) * 0.001);
  const pad = span * 0.3;
  const domainMin = Math.min(lower, current) - pad;
  const domainMax = Math.max(upper, current) + pad;
  const range = Math.max(domainMax - domainMin, 1e-9);
  const pct = (v: number): number => Math.min(100, Math.max(0, ((v - domainMin) / range) * 100));
  const bandLeft = pct(lower);
  const bandWidth = Math.max(0, pct(upper) - bandLeft);
  const markerLeft = pct(current);
  const title = `current ${formatDollars(current)}/day · band ${formatDollars(lower)}–${formatDollars(upper)}/day · ${status}`;

  return (
    <div className="relative h-3 w-32" title={title}>
      <div className="absolute inset-y-1 left-0 right-0 rounded-full bg-bg-tertiary/60" />
      <div className="absolute inset-y-1 rounded-full bg-accent/25" style={{ left: `${String(bandLeft)}%`, width: `${String(bandWidth)}%` }} />
      <div className={`absolute top-0 bottom-0 w-0.5 rounded ${markerColor(status)}`} style={{ left: `${String(markerLeft)}%` }} />
    </div>
  );
}
