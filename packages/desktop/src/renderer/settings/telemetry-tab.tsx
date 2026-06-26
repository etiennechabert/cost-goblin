import { useEffect, useState } from 'react';
import { useCostApi } from '@costgoblin/ui';
import type { TelemetryOutboxEntry, TelemetryPreferences, TelemetryStatus } from '@costgoblin/core/browser';

type ChannelId = 'crashReports' | 'performance' | 'analytics';

interface ChannelMeta {
  readonly id: ChannelId;
  readonly label: string;
  readonly description: string;
  /** Reserved channels render disabled with a "Coming soon" badge. */
  readonly available: boolean;
}

const CHANNELS: readonly ChannelMeta[] = [
  {
    id: 'crashReports',
    label: 'Crash & error reports',
    description:
      'Native crashes and unhandled errors, via Sentry. Stack traces are scrubbed of file paths, account IDs, emails and any dollar amounts before they leave your machine.',
    available: true,
  },
  {
    id: 'performance',
    label: 'Performance metrics',
    description: 'Sampled timing traces for slow operations, so regressions can be spotted across releases.',
    available: true,
  },
  {
    id: 'analytics',
    label: 'Usage analytics',
    description: 'Anonymous product-usage events (which views are used). Not wired up yet.',
    available: false,
  },
];

function Switch({
  on,
  disabled,
  ariaLabel,
  onToggle,
}: Readonly<{ on: boolean; disabled?: boolean; ariaLabel: string; onToggle: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={[
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        disabled === true ? 'cursor-not-allowed bg-bg-tertiary opacity-50' : on ? 'bg-accent' : 'bg-bg-tertiary',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
          on ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

function kindLabel(kind: TelemetryOutboxEntry['kind']): string {
  switch (kind) {
    case 'error':
      return 'Error';
    case 'transaction':
      return 'Trace';
    case 'session':
      return 'Session';
    case 'other':
      return 'Event';
  }
}

/**
 * Opt-in telemetry settings: per-channel toggles, the configured-endpoint
 * status, and the local audit log of everything that has been sent. Every
 * channel defaults OFF; nothing is collected until the user turns one on.
 */
export function TelemetryTab(): React.JSX.Element {
  const api = useCostApi();
  const [prefs, setPrefs] = useState<TelemetryPreferences | null>(null);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [outbox, setOutbox] = useState<readonly TelemetryOutboxEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getTelemetryPreferences(), api.getTelemetryStatus(), api.getTelemetryOutbox()])
      .then(([p, s, o]) => {
        if (cancelled) return;
        setPrefs(p);
        setStatus(s);
        setOutbox(o);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  function setChannel(channel: ChannelId, value: boolean): void {
    if (prefs === null) return;
    const next: TelemetryPreferences = {
      crashReports: channel === 'crashReports' ? value : prefs.crashReports,
      performance: channel === 'performance' ? value : prefs.performance,
      analytics: channel === 'analytics' ? value : prefs.analytics,
    };
    setPrefs(next);
    api
      .setTelemetryPreferences(next)
      .then(() => api.getTelemetryStatus())
      .then(setStatus)
      .catch(() => undefined);
  }

  function refreshOutbox(): void {
    api.getTelemetryOutbox().then(setOutbox).catch(() => undefined);
  }

  if (prefs === null || status === null) {
    return <div className="p-6 text-sm text-text-muted">Loading…</div>;
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Telemetry</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Help improve CostGoblin by sharing crash reports and performance data. Everything here is opt-in and off by
          default — no cost data, tag values, account IDs or team names ever leave your machine.
        </p>
      </div>

      {!status.dsnConfigured && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text-secondary">
          No telemetry endpoint is configured, so nothing can be sent yet. Set the{' '}
          <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">COSTGOBLIN_SENTRY_DSN</code> environment variable
          (or a self-hosted <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">COSTGOBLIN_SENTRY_TUNNEL</code>)
          to enable delivery.
        </div>
      )}

      <div className="flex flex-col gap-1 rounded-lg border border-border">
        {CHANNELS.map((channel, i) => (
          <div
            key={channel.id}
            className={['flex items-start justify-between gap-4 p-4', i > 0 ? 'border-t border-border' : ''].join(' ')}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-primary">{channel.label}</span>
                {!channel.available && (
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                    Coming soon
                  </span>
                )}
                {channel.available && prefs[channel.id] && status.active && (
                  <span className="text-xs text-positive">● Active</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">{channel.description}</p>
            </div>
            <Switch
              on={prefs[channel.id]}
              disabled={!channel.available}
              ariaLabel={`Toggle ${channel.label}`}
              onToggle={() => { setChannel(channel.id, !prefs[channel.id]); }}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">Audit log</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              Every event handed to the reporter is recorded here (after scrubbing) so you can see exactly what was sent.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshOutbox}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Refresh
          </button>
        </div>

        {outbox.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-text-muted">
            Nothing has been sent.
          </div>
        ) : (
          <ul className="flex flex-col rounded-lg border border-border">
            {outbox.map((entry, i) => (
              <li
                key={`${entry.timestamp}-${String(i)}`}
                className={['flex items-start gap-3 p-3', i > 0 ? 'border-t border-border' : ''].join(' ')}
              >
                <span className="mt-0.5 shrink-0 rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                  {kindLabel(entry.kind)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-text-primary">{entry.title}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">{new Date(entry.timestamp).toLocaleString()}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
