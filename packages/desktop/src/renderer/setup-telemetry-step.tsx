import { useEffect, useRef, useState } from 'react';
import { useCostApi } from '@costgoblin/ui';
import type { TelemetryPreferences } from '@costgoblin/core/browser';

function Switch({
  on,
  ariaLabel,
  onToggle,
}: Readonly<{ on: boolean; ariaLabel: string; onToggle: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={['relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-bg-tertiary'].join(' ')}
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

function Row({
  label,
  description,
  on,
  onToggle,
}: Readonly<{ label: string; description: string; on: boolean; onToggle: () => void }>): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-text-muted">{description}</p>
      </div>
      <Switch on={on} ariaLabel={`Toggle ${label}`} onToggle={onToggle} />
    </div>
  );
}

/**
 * Final onboarding step (and re-runnable from Settings): offers the two LOW-risk,
 * scrubbed telemetry channels — error reports and performance — both off by
 * default. Native crash reports (raw memory) are deliberately NOT offered here;
 * they stay a separate, deliberate opt-in in Settings → Telemetry. Existing
 * native/analytics preferences are preserved untouched.
 */
export function SetupTelemetryStep({ onDone }: Readonly<{ onDone: () => void }>): React.JSX.Element {
  const api = useCostApi();
  const saved = useRef<TelemetryPreferences | null>(null);
  const [errorReports, setErrorReports] = useState(false);
  const [performance, setPerformance] = useState(false);
  const [busy, setBusy] = useState(false);
  // Gate "Finish" until current prefs have loaded — otherwise a fast click writes
  // the state defaults (all off) and clobbers a prior nativeCrashReports opt-in
  // that this step never shows.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getTelemetryPreferences()
      .then((p) => {
        if (cancelled) return;
        saved.current = p;
        setErrorReports(p.errorReports);
        setPerformance(p.performance);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function finish(): Promise<void> {
    setBusy(true);
    // If the baseline never loaded (the initial read failed and only the catch
    // ran), the on-screen toggles show the all-off default, NOT the user's real
    // state — so we can't trust them either. Re-read and preserve every channel
    // in that case; only when a real baseline loaded do the two visible toggles
    // drive errorReports/performance. Native/analytics are never shown here.
    const loadedBaseline = saved.current;
    const prev = loadedBaseline ?? (await api.getTelemetryPreferences().catch(() => null));
    const next: TelemetryPreferences = {
      errorReports: loadedBaseline !== null ? errorReports : (prev?.errorReports ?? false),
      performance: loadedBaseline !== null ? performance : (prev?.performance ?? false),
      nativeCrashReports: prev?.nativeCrashReports ?? false,
      analytics: prev?.analytics ?? false,
    };
    // Proceed to the app regardless — onboarding must never get stuck on telemetry.
    api.setTelemetryPreferences(next).then(onDone, onDone);
  }

  // Like the setup wizard, this step renders without the app header (the
  // window's only macOS drag region) — the backdrop takes over as the drag
  // area and the card opts back out to stay clickable. (#317)
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4 [-webkit-app-region:drag]">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-secondary p-8 [-webkit-app-region:no-drag]">
        <div className="mb-6 flex justify-center">
          <img src="goblin.png" alt="CostGoblin" className="h-16 w-auto" />
        </div>
        <h2 className="text-xl font-semibold text-text-primary">Help improve CostGoblin?</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Optional and off by default. These reports are <strong className="text-text-primary">scrubbed</strong> of file
          paths, account IDs, emails and dollar amounts before they leave your machine — sent over an encrypted
          connection and stored in Sentry’s EU region — and every one is listed in an audit log you can inspect. You can
          change this any time in Settings → Telemetry.
        </p>

        <div className="mt-5 flex flex-col divide-y divide-border rounded-lg border border-border">
          <Row
            label="Error reports"
            description="Unhandled JS errors (main + renderer), scrubbed before sending."
            on={errorReports}
            onToggle={() => { setErrorReports((v) => !v); }}
          />
          <Row
            label="Performance metrics"
            description="Sampled timing traces for slow operations, so regressions can be spotted across releases."
            on={performance}
            onToggle={() => { setPerformance((v) => !v); }}
          />
        </div>

        <p className="mt-3 text-xs text-text-muted">
          Native crash reports — a raw memory snapshot, higher risk — aren’t offered here; you can enable them
          separately in Settings → Telemetry.
        </p>

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-xs text-text-muted">CostGoblin will restart to apply your choices.</p>
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => { void finish(); }}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Finish
          </button>
        </div>
      </div>
    </div>
  );
}
