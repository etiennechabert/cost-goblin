import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

/** Cadences for the shared auto-sync / auto-prune schedule, in minutes.
 *  Must stay within the backend clamp [MIN, MAX] in auto-sync.ts —
 *  "Monthly" relies on the max being at least one month. */
const INTERVAL_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 60, label: 'Hourly' },
  { value: 1440, label: 'Daily' },
  { value: 10080, label: 'Weekly' },
  { value: 43200, label: 'Monthly' },
];

interface ToggleProps {
  on: boolean;
  label: string;
  ariaLabel?: string | undefined;
  title?: string | undefined;
  onToggle: () => void;
}

function Toggle({ on, label, ariaLabel, title, onToggle }: Readonly<ToggleProps>) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <button
        type="button"
        aria-label={ariaLabel}
        title={title}
        onClick={onToggle}
        className={['relative h-5 w-9 rounded-full transition-colors [-webkit-app-region:no-drag]', on ? 'bg-accent' : 'bg-bg-tertiary'].join(' ')}
      >
        <span className={['absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform', on ? 'translate-x-4' : 'translate-x-0'].join(' ')} />
      </button>
    </div>
  );
}

/** Auto-sync + auto-prune toggles and the shared schedule interval. Lives in
 *  the top menu (not the Sync view) because the schedule runs app-wide. The
 *  interval drives both auto-sync and auto-prune, so it stays enabled whenever
 *  either is on. */
export function SchedulerControls() {
  const api = useCostApi();
  const autoSyncQuery = useQuery(() => api.getAutoSyncEnabled(), []);
  const autoPruneQuery = useQuery(() => api.getAutoPruneEnabled(), []);
  const intervalQuery = useQuery(() => api.getAutoSyncIntervalMinutes(), []);

  const [autoSync, setAutoSync] = useState(false);
  const [autoSyncLoaded, setAutoSyncLoaded] = useState(false);
  const [autoPrune, setAutoPrune] = useState(false);
  const [autoPruneLoaded, setAutoPruneLoaded] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [intervalLoaded, setIntervalLoaded] = useState(false);

  if (!autoSyncLoaded && autoSyncQuery.status === 'success') {
    setAutoSyncLoaded(true);
    setAutoSync(autoSyncQuery.data);
  }
  if (!autoPruneLoaded && autoPruneQuery.status === 'success') {
    setAutoPruneLoaded(true);
    setAutoPrune(autoPruneQuery.data);
  }
  if (!intervalLoaded && intervalQuery.status === 'success') {
    setIntervalLoaded(true);
    setIntervalMinutes(intervalQuery.data);
  }

  // The interval drives the shared schedule, so it's meaningful whenever
  // either auto-sync or auto-prune is enabled.
  const scheduleOff = !autoSync && !autoPrune;

  return (
    <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
      <Toggle
        on={autoSync}
        label="Auto-sync"
        ariaLabel="Toggle auto-sync"
        title="Periodically download data that's missing within each tier's retention window."
        onToggle={() => { const next = !autoSync; setAutoSync(next); api.setAutoSyncEnabled(next).catch(() => undefined); }}
      />
      <Toggle
        on={autoPrune}
        label="Auto-prune"
        ariaLabel="Toggle auto-prune"
        title="Periodically delete local data older than each tier's retention window. Off by default."
        onToggle={() => { const next = !autoPrune; setAutoPrune(next); api.setAutoPruneEnabled(next).catch(() => undefined); }}
      />
      <select
        value={String(intervalMinutes)}
        disabled={scheduleOff}
        onChange={e => {
          const next = Number(e.target.value);
          setIntervalMinutes(next);
          api.setAutoSyncIntervalMinutes(next).catch(() => undefined);
        }}
        title="How often the schedule runs — drives both auto-sync and auto-prune. Each run hits S3."
        className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-secondary disabled:opacity-40 [-webkit-app-region:no-drag]"
      >
        {INTERVAL_OPTIONS.map(o => (
          <option key={o.value} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
