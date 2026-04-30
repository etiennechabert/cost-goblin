import { useState, useEffect } from 'react';
import { Info, ExternalLink, Bug } from 'lucide-react';
import type { TelemetryConfig, TelemetryChannel } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';

// Component that intentionally throws an error for testing crash reporting
function CrashTester(): null {
  throw new Error('Test crash with sensitive data: cost=$12345.67 account=123456789012 tag=cost-center-finance');
}

interface ToggleProps {
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly disabled?: boolean;
}

function Toggle({ enabled, onChange, disabled = false }: Readonly<ToggleProps>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => { onChange(!enabled); }}
      className={[
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg-primary',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        enabled ? 'bg-accent' : 'bg-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
          enabled ? 'translate-x-6' : 'translate-x-1',
        ].join(' ')}
      />
    </button>
  );
}

interface ChannelRowProps {
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly saving: boolean;
}

function ChannelRow({ label, description, enabled, onChange, saving }: Readonly<ChannelRowProps>) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-border last:border-b-0">
      <div className="flex-1">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary mt-1">{description}</div>
      </div>
      <div className="flex items-center gap-2">
        {saving && <span className="text-xs text-text-tertiary">Saving...</span>}
        <Toggle enabled={enabled} onChange={onChange} disabled={saving} />
      </div>
    </div>
  );
}

export function Preferences() {
  const api = useCostApi();
  const [refreshKey, setRefreshKey] = useState(0);
  const telemetryQuery = useQuery(() => api.getTelemetryConfig(), [refreshKey]);
  const auditLogPathQuery = useQuery(() => api.getTelemetryAuditLogPath(), []);
  const [savingChannel, setSavingChannel] = useState<TelemetryChannel | null>(null);
  const [triggerCrash, setTriggerCrash] = useState(false);

  // Local state that tracks the config from the query
  const [localConfig, setLocalConfig] = useState<TelemetryConfig | null>(null);

  // Sync local state when query succeeds
  useEffect(() => {
    if (telemetryQuery.status === 'success') {
      if (telemetryQuery.data !== undefined) {
        setLocalConfig(telemetryQuery.data);
      } else {
        // No telemetry config exists yet - use default (all disabled)
        setLocalConfig({
          analytics: { enabled: false },
          crashReporting: { enabled: false },
          performance: { enabled: false },
        });
      }
    }
  }, [telemetryQuery]);

  async function handleToggle(channel: TelemetryChannel, enabled: boolean): Promise<void> {
    if (localConfig === null) return;
    setSavingChannel(channel);
    try {
      await api.updateTelemetryChannel(channel, enabled);
      // Optimistically update local state
      setLocalConfig({
        ...localConfig,
        [channel]: { ...localConfig[channel], enabled },
      });
      // Refresh from server to ensure consistency
      setRefreshKey(k => k + 1);
    } catch {
      // On error, revert optimistic update by refreshing
      setRefreshKey(k => k + 1);
    } finally {
      setSavingChannel(null);
    }
  }

  if (telemetryQuery.status === 'loading' || localConfig === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <CoinRainLoader />
      </div>
    );
  }

  if (telemetryQuery.status === 'error') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-negative">
          Failed to load telemetry preferences: {telemetryQuery.error instanceof Error ? telemetryQuery.error.message : String(telemetryQuery.error)}
        </div>
      </div>
    );
  }

  const auditLogPath = auditLogPathQuery.status === 'success' ? auditLogPathQuery.data : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Preferences</h1>
          <p className="text-sm text-text-secondary mt-1">
            Configure telemetry and privacy settings
          </p>
        </div>

        {/* Telemetry Section */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-1">Telemetry</h2>
          <p className="text-xs text-text-secondary mb-4">
            Help improve CostGoblin by sharing anonymous usage data and crash reports.
            All telemetry is opt-in and privacy-preserving.
          </p>

          <div className="space-y-0">
            <ChannelRow
              label="Usage Analytics"
              description="Track feature usage and navigation patterns (PostHog)"
              enabled={localConfig.analytics.enabled}
              onChange={(enabled) => { void handleToggle('analytics', enabled); }}
              saving={savingChannel === 'analytics'}
            />
            <ChannelRow
              label="Crash Reporting"
              description="Automatically report unhandled errors (Sentry)"
              enabled={localConfig.crashReporting.enabled}
              onChange={(enabled) => { void handleToggle('crashReporting', enabled); }}
              saving={savingChannel === 'crashReporting'}
            />
            <ChannelRow
              label="Performance Monitoring"
              description="Track query duration and sync latency (Sentry Performance)"
              enabled={localConfig.performance.enabled}
              onChange={(enabled) => { void handleToggle('performance', enabled); }}
              saving={savingChannel === 'performance'}
            />
          </div>
        </div>

        {/* Privacy Notice */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Privacy Guarantee</h3>
              <div className="text-xs text-text-secondary space-y-2">
                <p>
                  <strong className="text-text-primary">What we collect:</strong> Feature usage patterns,
                  view navigation, dimension counts, query durations, error messages (redacted),
                  stack traces (file paths removed).
                </p>
                <p>
                  <strong className="text-text-primary">What we NEVER collect:</strong> Cost values,
                  tag values, account IDs, team names, file paths, or any business data from your
                  billing reports.
                </p>
                <p>
                  All telemetry payloads are privacy-filtered before transmission and logged locally
                  for your inspection.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Audit Log */}
        {auditLogPath !== null && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-2">Audit Log</h3>
            <p className="text-xs text-text-secondary mb-3">
              All telemetry events are logged locally in newline-delimited JSON format.
              You can inspect this file to verify what data is being sent.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-bg-tertiary text-text-secondary px-3 py-2 rounded font-mono overflow-x-auto">
                {auditLogPath}
              </code>
              <button
                type="button"
                onClick={() => {
                  // Copy path to clipboard
                  void navigator.clipboard.writeText(auditLogPath);
                }}
                className="text-xs text-accent hover:text-accent-hover flex items-center gap-1 px-3 py-2 rounded hover:bg-bg-tertiary transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Copy Path
              </button>
            </div>
          </div>
        )}

        {/* Developer Testing */}
        <div className="rounded-lg border border-negative/50 bg-negative-muted p-5">
          <div className="flex items-start gap-3">
            <Bug className="w-4 h-4 text-negative flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-negative mb-2">Developer Testing</h3>
              <p className="text-xs text-text-secondary mb-3">
                Test crash reporting by triggering an intentional error. The error message
                contains sensitive data that should be redacted by privacy filters before
                transmission.
              </p>
              <button
                type="button"
                onClick={() => { setTriggerCrash(true); }}
                className="text-xs bg-negative text-white px-3 py-2 rounded hover:bg-negative/90 transition-colors"
              >
                Trigger Test Crash
              </button>
              {triggerCrash && <CrashTester />}
            </div>
          </div>
        </div>

        {/* Footer note */}
        <div className="text-xs text-text-tertiary text-center pt-4">
          Telemetry settings are stored in <code className="bg-bg-tertiary px-1 rounded">costgoblin.yaml</code>
        </div>
      </div>
    </div>
  );
}
