import { Download, RefreshCw, RotateCw, Check } from 'lucide-react';
import { getActivePalette } from '@costgoblin/ui';
import type { UpdateStatus } from '@costgoblin/core/browser';

interface DashboardOption {
  readonly id: string;
  readonly name: string;
}

interface Props {
  readonly isDark: boolean;
  readonly onToggleTheme: () => void;
  readonly palette: 'standard' | 'colorblind';
  readonly onTogglePalette: () => void;
  readonly dashboards: readonly DashboardOption[];
  readonly defaultViewId: string;
  readonly onSetDefaultView: (id: string) => void;
  readonly appVersion: string;
  readonly updateStatus: UpdateStatus;
  readonly onCheckForUpdates: () => void;
  readonly onShowReleaseNotes: () => void;
}

function SettingRow({ label, description, children }: Readonly<{ label: string; description?: string | undefined; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        {description !== undefined && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented({ options, value, onChange }: Readonly<{
  options: readonly { readonly value: string; readonly label: string }[];
  value: string;
  onChange: (next: string) => void;
}>): React.JSX.Element {
  return (
    <fieldset className="m-0 inline-flex min-w-0 overflow-hidden rounded-md border border-border p-0">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => { if (!active) onChange(opt.value); }}
            aria-pressed={active}
            className={[
              'px-3.5 py-1.5 text-sm transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
              active ? 'bg-bg-tertiary font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}

function UpdateControl({ status, onCheckForUpdates, onShowReleaseNotes }: Readonly<{
  status: UpdateStatus;
  onCheckForUpdates: () => void;
  onShowReleaseNotes: () => void;
}>): React.JSX.Element {
  if (status.state === 'available') {
    return (
      <button type="button" onClick={onShowReleaseNotes} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">
        <Download size={14} />v{status.info.version} available
      </button>
    );
  }
  if (status.state === 'downloading') {
    return (
      <button type="button" onClick={onShowReleaseNotes} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary">
        <RefreshCw size={14} className="animate-spin" />Downloading {String(status.percent)}%
      </button>
    );
  }
  if (status.state === 'downloaded') {
    return (
      <button type="button" onClick={onShowReleaseNotes} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">
        <RefreshCw size={14} />Restart to install
      </button>
    );
  }
  if (status.state === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-muted">
        <RefreshCw size={14} className="animate-spin" />Checking…
      </span>
    );
  }
  return (
    <button type="button" onClick={onCheckForUpdates} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary">
      <RotateCw size={14} />{status.state === 'error' ? 'Retry update check' : 'Check for updates'}
    </button>
  );
}

/** The General settings tab — appearance, default dashboard, and updates.
 *  Folds in everything that previously lived in the hamburger popover's
 *  "Appearance" + "Updates" sections, now with the screen space to show a live
 *  palette preview and a proper update status row. */
export function GeneralTab({
  isDark,
  onToggleTheme,
  palette,
  onTogglePalette,
  dashboards,
  defaultViewId,
  onSetDefaultView,
  appVersion,
  updateStatus,
  onCheckForUpdates,
  onShowReleaseNotes,
}: Readonly<Props>): React.JSX.Element {
  const swatches = getActivePalette(palette).slice(0, 8);
  const versionSuffix = appVersion === '' ? '' : ` · v${appVersion}`;
  const updatesDescription = updateStatus.state === 'idle' ? `You're up to date${versionSuffix}` : undefined;

  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">General</h2>
        <p className="mt-1 text-sm text-text-secondary">Appearance, default view, and software updates.</p>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingRow label="Theme">
          <Segmented
            value={isDark ? 'dark' : 'light'}
            onChange={() => { onToggleTheme(); }}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
          />
        </SettingRow>

        <SettingRow label="Chart palette" description="Colorblind uses the Okabe-Ito safe palette.">
          <div className="flex items-center gap-3">
            <div className="flex gap-1" aria-hidden="true">
              {swatches.map((color, i) => (
                <span key={`${color}-${String(i)}`} className="h-4 w-4 rounded" style={{ backgroundColor: color }} />
              ))}
            </div>
            <Segmented
              value={palette}
              onChange={() => { onTogglePalette(); }}
              options={[{ value: 'standard', label: 'Standard' }, { value: 'colorblind', label: 'Colorblind' }]}
            />
          </div>
        </SettingRow>

        <SettingRow label="Default dashboard" description="Opens on launch · mirrors the ★ in the dashboard switcher.">
          <select
            value={dashboards.some(d => d.id === defaultViewId) ? defaultViewId : ''}
            onChange={(e) => { onSetDefaultView(e.target.value); }}
            className="rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            aria-label="Default dashboard"
          >
            {dashboards.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingRow label="Software updates" description={updatesDescription}>
          <UpdateControl status={updateStatus} onCheckForUpdates={onCheckForUpdates} onShowReleaseNotes={onShowReleaseNotes} />
        </SettingRow>
        {updateStatus.state === 'idle' && appVersion !== '' && (
          <SettingRow label="Version">
            <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
              <Check size={14} className="text-positive" />v{appVersion}
            </span>
          </SettingRow>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        {palette === 'standard' ? 'Standard chart palette active' : 'Colorblind-safe chart palette active'}
      </span>
    </div>
  );
}
