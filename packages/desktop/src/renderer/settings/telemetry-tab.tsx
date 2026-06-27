import { useEffect, useState } from 'react';
import { useCostApi } from '@costgoblin/ui';
import type { TelemetryOutboxEntry, TelemetryPreferences, TelemetryStatus } from '@costgoblin/core/browser';

type ChannelId = 'errorReports' | 'nativeCrashReports' | 'performance' | 'analytics';

interface ChannelMeta {
  readonly id: ChannelId;
  readonly label: string;
  readonly description: string;
  /** Reserved channels render disabled with a "Coming soon" badge. */
  readonly available: boolean;
}

const CHANNELS: readonly ChannelMeta[] = [
  {
    id: 'errorReports',
    label: 'Error reports',
    description:
      'Unhandled JS errors (main + renderer), via Sentry — scrubbed of file paths, account IDs, emails and dollar amounts before they leave your machine.',
    available: true,
  },
  {
    id: 'nativeCrashReports',
    label: 'Native crash reports',
    description:
      'When the app hard-crashes, a raw snapshot of its memory (a Crashpad minidump). Sent unscrubbed and not itemized in the audit log — a separate opt-in with its own confirmation.',
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
  // Set while the user is confirming a channel that needs explicit consent
  // (crash reports ship raw native minidumps).
  const [confirming, setConfirming] = useState<ChannelId | null>(null);
  // A telemetry change only takes effect at startup (native crash capture can
  // only arm before Electron is ready), so a toggle prompts a restart.
  const [restartPending, setRestartPending] = useState(false);

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

  function applyChannel(channel: ChannelId, value: boolean): void {
    if (prefs === null) return;
    const prev = prefs;
    const next: TelemetryPreferences = {
      errorReports: channel === 'errorReports' ? value : prefs.errorReports,
      nativeCrashReports: channel === 'nativeCrashReports' ? value : prefs.nativeCrashReports,
      performance: channel === 'performance' ? value : prefs.performance,
      analytics: channel === 'analytics' ? value : prefs.analytics,
    };
    setPrefs(next);
    api.setTelemetryPreferences(next).then(
      () => {
        // Persisted. The new state only takes effect once the app restarts. A
        // failed status refresh must NOT revert — the pref is already on disk.
        setRestartPending(true);
        api.getTelemetryStatus().then(setStatus, () => undefined);
      },
      () => {
        // Persisting itself failed — revert so a privacy switch never shows a
        // state the backend didn't accept.
        setPrefs(prev);
      },
    );
  }

  function setChannel(channel: ChannelId, value: boolean): void {
    if (prefs === null) return;
    // Enabling NATIVE crash reports ships raw, unscrubbed process memory — gate
    // it behind an explicit consent step. Error reports (scrubbed JS) don't need
    // it and apply immediately.
    if (channel === 'nativeCrashReports' && value && !prefs.nativeCrashReports) {
      setConfirming('nativeCrashReports');
      return;
    }
    applyChannel(channel, value);
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
          default, and a change only takes effect after the app restarts.
        </p>
      </div>

      {restartPending && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-text-secondary">
          <span>Restart CostGoblin to apply your telemetry change.</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => { globalThis.costgoblinUpdate.relaunch(); }}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
            >
              Restart now
            </button>
            <button
              type="button"
              onClick={() => { setRestartPending(false); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              Later
            </button>
          </div>
        </div>
      )}

      {!status.dsnConfigured && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text-secondary">
          No telemetry endpoint is configured, so nothing can be sent yet. Set the{' '}
          <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">COSTGOBLIN_SENTRY_DSN</code> environment variable
          (or a self-hosted <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">COSTGOBLIN_SENTRY_TUNNEL</code>)
          to enable delivery.
        </div>
      )}

      {confirming === 'nativeCrashReports' && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-text-secondary">
          <p className="font-medium text-text-primary">Enable native crash reports?</p>
          <p className="mt-1">
            A native crash report is a <strong className="text-text-primary">raw binary snapshot of the app’s memory</strong> at
            the moment it hard-crashes — which can include cost figures, account IDs or query text — and is sent{' '}
            <strong className="text-text-primary">unscrubbed</strong>, because a memory dump can’t be redacted. It isn’t
            itemized in the audit log. This is separate from <em>Error reports</em>, which are scrubbed; only enable this
            if you’re comfortable sending raw memory to diagnose hard crashes. It only ever leaves your machine if you
            turn this on.
          </p>
          <p className="mt-2 text-xs text-text-muted">
            How it’s handled at Sentry: reports are sent over an encrypted connection (TLS), stored encrypted at rest in
            the <strong className="text-text-secondary">EU region</strong> (Frankfurt), and we don’t attach your IP,
            cookies or identity. That controls <em>where and how</em> the dump is stored — not <em>what’s inside it</em>,
            which is exactly why this is a separate, deliberate opt-in.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                applyChannel('nativeCrashReports', true);
                setConfirming(null);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
            >
              Enable native crash reports
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(null); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
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
                {channel.available && status.armed[channel.id] && (
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
              Every scrubbed error and performance payload handed to the reporter is recorded here so you can see what
              was sent. Native crash dumps are binary memory snapshots and aren’t itemized.
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
