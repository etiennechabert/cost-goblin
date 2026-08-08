import type {
  ConfigBundleSummary,
  DataSharingResult,
  DataSharingStatus,
  ExportConfigBundleResult,
  PublishConfigBundleResult,
  SharedDataTier,
  SharedPullProgress,
  SharedPullSelection,
  SharedSourceInfo,
  SharedSourcePreview,
  SharedSourceTier,
} from '@costgoblin/core/browser';
import { isDiscoverableBeaconLocation, splitS3Location, suggestedConfigBeaconLocation } from '@costgoblin/core/browser';
import { Check, CloudDownload, CloudUpload, Copy, FileDown, FileUp, Network, Plug, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { formatBytes } from './format.js';
import { ProfilePicker } from './profile-picker.js';
import { Button } from './ui/button.js';

const DATA_TIER_LABELS: Record<SharedDataTier, string> = {
  'daily': 'Daily billing data',
  'hourly': 'Hourly billing data',
  'cost-optimization': 'Cost optimization',
};
const DATA_TIERS: readonly SharedDataTier[] = ['daily', 'hourly', 'cost-optimization'];

// ---------------------------------------------------------------------------
// Bundle summary — shared by the import dialog and the setup wizard's
// beacon step so "what am I about to apply?" always looks the same.
// ---------------------------------------------------------------------------

function SummaryRow({ label, children }: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-text-muted uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-sm text-text-primary text-right min-w-0">{children}</span>
    </div>
  );
}

export function BundleSummaryCard({ summary }: Readonly<{ summary: ConfigBundleSummary }>): React.JSX.Element {
  const exportedDate = summary.exportedAt.slice(0, 10);
  return (
    <div className="flex flex-col gap-2">
      {!summary.fingerprintValid && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning-muted px-3 py-2">
          <TriangleAlert size={16} className="text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-warning">
            This file was modified after it was exported (fingerprint mismatch). Only continue if you trust where it came from.
          </p>
        </div>
      )}
      <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-2 divide-y divide-border-subtle">
        <SummaryRow label="Exported">{exportedDate} · CostGoblin v{summary.appVersion}</SummaryRow>
        {summary.providers.map(p => (
          <SummaryRow key={p.name} label={`Provider ${p.name}`}>
            <span className="font-mono text-xs break-all">{p.dailyBucket}</span>
          </SummaryRow>
        ))}
        <SummaryRow label="Dimensions">
          {summary.builtInDimensionCount} built-in + {summary.tagDimensionCount} tag{summary.tagDimensionCount === 1 ? '' : 's'}
        </SummaryRow>
        {summary.orgTreeNodeCount > 0 && (
          <SummaryRow label="Org tree">{summary.orgTreeNodeCount} nodes</SummaryRow>
        )}
        {summary.exclusionRuleCount > 0 && (
          <SummaryRow label="Cost scope">{summary.exclusionRuleCount} exclusion rules</SummaryRow>
        )}
        {summary.viewCount > 0 && (
          <SummaryRow label="Dashboards">{summary.viewCount} view{summary.viewCount === 1 ? '' : 's'}</SummaryRow>
        )}
        <SummaryRow label="Fingerprint">
          <span className="font-mono text-xs">{summary.fingerprint.slice(0, 16)}</span>
        </SummaryRow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared dialog chrome — same overlay pattern as ConfirmModal.
// ---------------------------------------------------------------------------

function SharingModal({ title, onClose, children, dismissable = true }: Readonly<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** When false, the modal cannot be dismissed (no Escape, no backdrop click,
   *  no ✕) — used to hold the window open during an in-progress pull. */
  dismissable?: boolean;
}>): React.JSX.Element {
  useEffect(() => {
    if (!dismissable) return undefined;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [onClose, dismissable]);

  return (
    // no-drag: the modal can open above a window drag region (the standalone
    // setup wizard's backdrop, or the app header) — without the opt-out,
    // clicks there would drag the window instead of reaching the modal. (#317)
    <dialog open className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent m-0 p-0 max-w-none max-h-none w-full h-full border-none [-webkit-app-region:no-drag]" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        {...(dismissable ? { onClick: onClose } : {})}
        aria-hidden="true"
      />
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Share data on the local network (peer-to-peer, TLS-PSK). Lets a teammate
// with zero AWS access pull this machine's data + config from one pasted key.
// ---------------------------------------------------------------------------

function lastPullSummary(status: DataSharingStatus): string {
  const peer = status.lastPeer ?? 'a peer';
  const fileWord = status.filesServed === 1 ? 'file' : 'files';
  return `Last pull from ${peer} · ${String(status.filesServed)} ${fileWord} served`;
}

function ShareDataSection(): React.JSX.Element {
  const api = useCostApi();
  const [status, setStatus] = useState<DataSharingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getDataSharingStatus().then(setStatus).catch(() => undefined);
  }, [api]);

  // While sharing, poll so the "who pulled" activity stays live.
  useEffect(() => {
    if (status?.enabled !== true) return;
    const id = setInterval(() => { api.getDataSharingStatus().then(setStatus).catch(() => undefined); }, 3000);
    return () => { clearInterval(id); };
  }, [api, status?.enabled]);

  function run(action: () => Promise<DataSharingResult>): void {
    setBusy(true);
    setError(null);
    action()
      .then(r => { if (r.status === 'ok') setStatus(r.sharing); else setError(r.message); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { setBusy(false); });
  }

  function copyKey(): void {
    if (status === null || status.sharingKey === null) return;
    void navigator.clipboard.writeText(status.sharingKey);
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1500);
  }

  const enabled = status?.enabled === true;

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network size={16} className="text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text-primary">Share data on this network</p>
            <p className="text-xs text-text-muted">Teammates without S3 access paste your key to pull your data — encrypted, peer-to-peer.</p>
          </div>
        </div>
        {enabled ? (
          <Button onClick={() => { run(() => api.disableDataSharing()); }} disabled={busy} className="bg-bg-tertiary hover:bg-bg-tertiary/70 text-text-primary shrink-0">
            {busy ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button onClick={() => { run(() => api.enableDataSharing()); }} disabled={busy} className="bg-accent hover:bg-accent-hover text-white shrink-0">
            {busy ? 'Starting…' : 'Start sharing'}
          </Button>
        )}
      </div>

      {status !== null && status.enabled && status.sharingKey !== null && (
        <div className="flex flex-col gap-2">
          <label htmlFor="cg-sharing-key" className="text-xs text-text-muted uppercase tracking-wider">Sharing key</label>
          <textarea
            id="cg-sharing-key"
            readOnly
            value={status.sharingKey}
            rows={3}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary resize-none focus:outline-none focus:border-accent/50"
          />
          <div className="flex items-center gap-2">
            <Button onClick={copyKey} className="bg-accent hover:bg-accent-hover text-white">
              {copied ? <><Check size={14} className="mr-1.5" />Copied</> : <><Copy size={14} className="mr-1.5" />Copy key</>}
            </Button>
            <button
              type="button"
              onClick={() => { run(() => api.rotateDataSharingKey()); }}
              disabled={busy}
              className="inline-flex items-center rounded-md px-2.5 py-1.5 text-xs text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            >
              <RotateCw size={13} className="mr-1.5" />Rotate (revokes old key)
            </button>
          </div>
          <p className="text-xs text-text-muted">
            Reachable at <span className="font-mono">{status.hosts.join(', ')}:{status.port}</span> · fingerprint <span className="font-mono">{status.fingerprint}</span>. Re-share if this machine&apos;s IP changes.
          </p>
          <div className="flex items-center gap-2 rounded-md bg-bg-tertiary/40 px-2.5 py-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${status.lastServedAt === null ? 'bg-text-muted' : 'bg-positive animate-pulse'}`} aria-hidden="true" />
            <p className="text-xs text-text-secondary">
              {status.lastServedAt === null
                ? 'Waiting for a teammate to connect…'
                : lastPullSummary(status)}
            </p>
          </div>
        </div>
      )}
      {error !== null && <p className="text-xs text-negative break-words">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a shared data source — reconnect to a saved teammate or paste a key,
// preview what's on offer, pick tiers + months, then pull (locked) the snapshot.
// ---------------------------------------------------------------------------

type AddState =
  | { kind: 'entry'; error: string | null }
  | { kind: 'previewing' }
  | { kind: 'choosing'; mode: 'key' | 'stored'; preview: SharedSourcePreview }
  | { kind: 'pulling' }
  | { kind: 'done'; source: SharedSourceInfo; filesDownloaded: number }
  | { kind: 'error'; message: string };

function pullPhaseLabel(progress: SharedPullProgress | null): string {
  switch (progress?.phase) {
    case 'downloading': return 'Downloading…';
    case 'importing': return 'Importing…';
    default: return 'Connecting…';
  }
}

function availablePeriods(preview: SharedSourcePreview): string[] {
  return [...new Set(preview.tiers.flatMap(t => t.periods))].sort((a, b) => a.localeCompare(b));
}

function ChoosingView({ preview, tiers, periods, onToggleTier, onTogglePeriod, onSetPeriods, onBack, onPull }: Readonly<{
  preview: SharedSourcePreview;
  tiers: ReadonlySet<SharedSourceTier>;
  periods: ReadonlySet<string>;
  onToggleTier: (t: SharedSourceTier) => void;
  onTogglePeriod: (p: string) => void;
  onSetPeriods: (next: ReadonlySet<string>) => void;
  onBack: () => void;
  onPull: () => void;
}>): React.JSX.Element {
  const months = availablePeriods(preview);
  const hasData = DATA_TIERS.some(t => tiers.has(t));
  const canPull = tiers.has('config') || (hasData && periods.size > 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-primary">
        From <span className="font-medium">{preview.label}</span> — choose what to pull.
      </p>

      {preview.hasConfig && (
        <label htmlFor="cg-pull-config-tier" className="grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-lg border border-border bg-bg-tertiary/20 px-3 py-2 cursor-pointer">
          <input id="cg-pull-config-tier" type="checkbox" checked={tiers.has('config')} onChange={() => { onToggleTier('config'); }} className="mt-0.5 accent-accent" />
          <span className="text-sm text-text-primary">Configuration</span>
          <span className="col-start-2 block text-xs text-text-muted">Dimensions, dashboards, cost scope &amp; org tree — applied under your AWS profile.</span>
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted uppercase tracking-wider">Data</span>
        <div className="flex flex-wrap gap-2">
          {preview.tiers.map(t => (
            <button
              key={t.tier}
              type="button"
              onClick={() => { onToggleTier(t.tier); }}
              className={[
                'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                tiers.has(t.tier) ? 'border-accent bg-accent-muted text-accent' : 'border-border bg-bg-tertiary/20 text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {DATA_TIER_LABELS[t.tier]} <span className="opacity-70">· {formatBytes(t.bytes)}</span>
            </button>
          ))}
        </div>
      </div>

      {months.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted uppercase tracking-wider">Months</span>
            <div className="flex items-center gap-2 text-xs">
              <button type="button" onClick={() => { onSetPeriods(new Set(months)); }} className="text-text-muted hover:text-text-secondary">All</button>
              <button type="button" onClick={() => { onSetPeriods(new Set()); }} className="text-text-muted hover:text-text-secondary">None</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {months.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { onTogglePeriod(m); }}
                className={[
                  'rounded-md border px-2 py-1 font-mono text-xs transition-colors',
                  periods.has(m) ? 'border-accent bg-accent-muted text-accent' : 'border-border bg-bg-tertiary/20 text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <Button onClick={onPull} disabled={!canPull} className="bg-accent hover:bg-accent-hover text-white">
          <CloudDownload size={16} className="mr-1.5" />
          Pull
        </Button>
      </div>
    </div>
  );
}

function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function AddSharedSourceSection({ onPulled, onBusyChange }: Readonly<{
  onPulled: () => void;
  /** Notifies the parent dialog so it can lock itself while a pull runs. */
  onBusyChange?: (busy: boolean) => void;
}>): React.JSX.Element {
  const api = useCostApi();
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<SharedSourceInfo | null>(null);
  const [state, setState] = useState<AddState>({ kind: 'entry', error: null });
  const [mode, setMode] = useState<'key' | 'stored'>('key');
  const [tiers, setTiers] = useState<ReadonlySet<SharedSourceTier>>(new Set());
  const [periods, setPeriods] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<SharedPullProgress | null>(null);

  useEffect(() => { api.getSharedSource().then(setStored).catch(() => undefined); }, [api]);

  // Poll live progress only while a pull is running.
  useEffect(() => {
    if (state.kind !== 'pulling') return undefined;
    const id = setInterval(() => { api.getSharedPullProgress().then(setProgress).catch(() => undefined); }, 300);
    return () => { clearInterval(id); };
  }, [api, state.kind]);

  // Hold the parent modal open while pulling.
  useEffect(() => { onBusyChange?.(state.kind === 'pulling'); }, [state.kind, onBusyChange]);

  function startPreview(m: 'key' | 'stored'): void {
    setMode(m);
    setState({ kind: 'previewing' });
    const request = m === 'key' ? api.previewSharedSource(key.trim()) : api.previewStoredSource();
    request.then(res => {
      if (res.status === 'error') { setState({ kind: 'entry', error: res.message }); return; }
      const seed = m === 'stored' ? stored?.selection : undefined;
      const defaultTiers: SharedSourceTier[] = [
        ...(res.preview.hasConfig ? (['config'] satisfies SharedSourceTier[]) : []),
        ...res.preview.tiers.map(t => t.tier),
      ];
      setTiers(new Set(seed?.sources ?? defaultTiers));
      setPeriods(new Set(seed?.periods ?? availablePeriods(res.preview)));
      setState({ kind: 'choosing', mode: m, preview: res.preview });
    }).catch((e: unknown) => { setState({ kind: 'entry', error: e instanceof Error ? e.message : String(e) }); });
  }

  function toggleTier(t: SharedSourceTier): void { setTiers(prev => toggleInSet(prev, t)); }
  function togglePeriod(p: string): void { setPeriods(prev => toggleInSet(prev, p)); }

  function startPull(): void {
    const selection: SharedPullSelection = { sources: [...tiers], periods: [...periods].sort((a, b) => a.localeCompare(b)) };
    setProgress(null);
    setState({ kind: 'pulling' });
    const request = mode === 'key' ? api.addSharedSource(key.trim(), selection) : api.refreshSharedSource(selection);
    request.then(res => {
      if (res.status === 'ok') {
        setStored(res.source);
        setState({ kind: 'done', source: res.source, filesDownloaded: res.filesDownloaded });
      } else {
        setState({ kind: 'error', message: res.message });
      }
    }).catch((e: unknown) => { setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); });
  }

  function handleForget(): void {
    api.removeSharedSource().then(() => { setStored(null); }).catch(() => undefined);
  }

  if (state.kind === 'previewing') {
    return (
      <div className="flex items-center justify-center py-6">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span className="ml-2 text-sm text-text-secondary">Connecting to teammate…</span>
      </div>
    );
  }

  if (state.kind === 'pulling') {
    const pct = progress !== null && progress.bytesTotal > 0
      ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
      : 0;
    return (
      <div className="flex flex-col gap-3 py-1">
        <div className="flex items-center gap-2">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="text-sm text-text-primary">{pullPhaseLabel(progress)}</span>
        </div>
        {progress !== null && progress.bytesTotal > 0 && (
          <div className="flex flex-col gap-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div className="h-full bg-accent transition-all" style={{ width: `${String(pct)}%` }} />
            </div>
            <p className="text-xs text-text-muted">
              {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)} · {progress.filesDone}/{progress.filesTotal} files{progress.currentPeriod === null ? '' : ` · ${progress.currentPeriod}`}
            </p>
          </div>
        )}
        <p className="text-xs text-text-muted">Keep this window open until the transfer finishes.</p>
      </div>
    );
  }

  if (state.kind === 'done') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-positive/40 bg-bg-tertiary/20 px-3 py-2">
        <p className="text-xs text-positive">
          Pulled {state.filesDownloaded} file{state.filesDownloaded === 1 ? '' : 's'} from {state.source.label} · {state.source.periods.length} period{state.source.periods.length === 1 ? '' : 's'}.
        </p>
        <Button onClick={onPulled} className="bg-accent hover:bg-accent-hover text-white self-end">Done</Button>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
        <p className="text-xs text-negative break-words">{state.message}</p>
        <div className="flex items-center gap-2 self-end">
          <button type="button" onClick={() => { setState({ kind: 'entry', error: null }); }} className="text-xs text-text-muted hover:text-text-secondary">Start over</button>
          <Button onClick={startPull} className="bg-accent hover:bg-accent-hover text-white">Retry</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'choosing') {
    return (
      <ChoosingView
        preview={state.preview}
        tiers={tiers}
        periods={periods}
        onToggleTier={toggleTier}
        onTogglePeriod={togglePeriod}
        onSetPeriods={setPeriods}
        onBack={() => { setState({ kind: 'entry', error: null }); }}
        onPull={startPull}
      />
    );
  }

  // state.kind === 'entry'
  return (
    <div className="flex flex-col gap-2">
      {stored !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-tertiary/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-text-primary">Reconnect to <span className="font-medium">{stored.label}</span></p>
              <p className="text-xs text-text-muted">
                {stored.lastPulledAt === null ? 'Saved source' : `Last pulled ${stored.lastPulledAt.slice(0, 10)}`} · fingerprint <span className="font-mono">{stored.fingerprint.slice(0, 8)}</span>
              </p>
            </div>
            <Button onClick={() => { startPreview('stored'); }} className="bg-accent hover:bg-accent-hover text-white shrink-0">
              <RotateCw size={14} className="mr-1.5" />
              Reconnect
            </Button>
          </div>
          <button type="button" onClick={handleForget} className="self-start text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">
            Forget this teammate
          </button>
        </div>
      )}

      <label htmlFor="cg-add-source-key" className="text-xs text-text-muted uppercase tracking-wider">
        {stored === null ? 'Sharing key from a teammate' : 'Or a key from someone else'}
      </label>
      <p className="text-xs text-text-muted">
        Your teammate creates this by clicking <span className="font-medium text-text-secondary">Start sharing</span> in their CostGoblin (under <span className="font-medium text-text-secondary">Share configuration…</span>). Their app needs to stay open on the same network while you connect.
      </p>
      <textarea
        id="cg-add-source-key"
        value={key}
        onChange={(e) => { setKey(e.target.value); }}
        rows={3}
        placeholder="CGSHARE1-…  (no AWS access needed — pulls data + config over your network)"
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent/50"
      />
      {state.error !== null && <p className="text-xs text-negative break-words">{state.error}</p>}
      <Button onClick={() => { startPreview('key'); }} disabled={key.trim().length === 0} className="bg-accent hover:bg-accent-hover text-white self-start">
        <Plug size={16} className="mr-1.5" />
        Continue
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share dialog — export to file / publish to the S3 beacon.
// ---------------------------------------------------------------------------

export function ShareConfigPanel(): React.JSX.Element {
  const api = useCostApi();
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportConfigBundleResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishConfigBundleResult | null>(null);
  // null until the config has loaded and the default destination is known.
  const [location, setLocation] = useState<string | null>(null);
  const [defaultLocation, setDefaultLocation] = useState<string>('');
  // Publishing usually needs more than the day-to-day read-only profile
  // (s3:PutObject), so the profile is selectable per-publish. The default
  // is the configured sync profile.
  const [profiles, setProfiles] = useState<readonly string[]>([]);
  const [publishProfile, setPublishProfile] = useState('');
  const [configProfile, setConfigProfile] = useState('');

  useEffect(() => {
    api.listAwsProfiles().then(setProfiles).catch(() => undefined);
    api.getConfig().then(config => {
      // Bundle publishing writes an S3 object, so it needs an AWS provider
      // specifically — `providers[0]` may be a GCP one.
      const provider = config.providers.find(p => p.type === 'aws');
      const profile = provider?.credentialsProfile ?? '';
      setConfigProfile(profile);
      setPublishProfile(prev => prev.length > 0 ? prev : profile);
      const dailyBucket = provider?.sync.daily.bucket;
      const suggested = dailyBucket === undefined ? '' : suggestedConfigBeaconLocation(String(dailyBucket));
      setDefaultLocation(suggested);
      setLocation(prev => prev ?? suggested);
    }).catch(() => { setLocation(prev => prev ?? ''); });
  }, [api]);

  const locationValid = location !== null && splitS3Location(location) !== null;
  const locationDiscoverable = location !== null && isDiscoverableBeaconLocation(location);

  function handleExport(): void {
    setExporting(true);
    setExportResult(null);
    api.exportConfigBundle()
      .then(setExportResult)
      .catch((err: unknown) => { setExportResult({ status: 'error', message: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { setExporting(false); });
  }

  function handlePublish(): void {
    if (location === null || !locationValid) return;
    setPublishing(true);
    setPublishResult(null);
    api.publishConfigBundle({ location, ...(publishProfile.length > 0 ? { profile: publishProfile } : {}) })
      .then(setPublishResult)
      .catch((err: unknown) => { setPublishResult({ status: 'error', message: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { setPublishing(false); });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Bundles your dimensions, tags, cost scope, dashboards, org tree and S3 locations so a teammate can skip setup.
        {' '}<span className="text-text-primary">No credentials are included</span> — receivers pick their own AWS profile.
      </p>

      <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileDown size={16} className="text-text-secondary" />
            <div>
              <p className="text-sm font-medium text-text-primary">Export to file</p>
              <p className="text-xs text-text-muted">Share it over your team&apos;s usual channel</p>
            </div>
          </div>
          <Button onClick={handleExport} disabled={exporting} className="bg-accent hover:bg-accent-hover text-white shrink-0">
            {exporting ? 'Exporting…' : 'Export…'}
          </Button>
        </div>
        {exportResult?.status === 'saved' && (
          <p className="text-xs text-positive break-all">Saved to {exportResult.path}</p>
        )}
        {exportResult?.status === 'error' && (
          <p className="text-xs text-negative break-words">{exportResult.message}</p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CloudUpload size={16} className="text-text-secondary" />
            <div>
              <p className="text-sm font-medium text-text-primary">Publish to S3</p>
              <p className="text-xs text-text-muted">
                Teammates&apos; setup wizards find it automatically. Anyone who can read the billing data can read it.
              </p>
            </div>
          </div>
          <Button
            onClick={handlePublish}
            disabled={publishing || location === null || !locationValid}
            className="bg-accent hover:bg-accent-hover text-white shrink-0"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="publish-location" className="text-xs text-text-muted uppercase tracking-wider">
              Destination
            </label>
            {location !== null && defaultLocation.length > 0 && location !== defaultLocation && (
              <button
                type="button"
                onClick={() => { setLocation(defaultLocation); }}
                className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2"
              >
                Reset to default
              </button>
            )}
          </div>
          <input
            id="publish-location"
            type="text"
            value={location ?? ''}
            disabled={location === null}
            onChange={(e) => { setLocation(e.target.value); }}
            placeholder="s3://bucket/costgoblin/org-config.yaml"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
          />
          {location !== null && !locationValid && (
            <p className="text-xs text-negative break-words">Enter a full object location like s3://bucket/costgoblin/org-config.yaml</p>
          )}
          {locationValid && !locationDiscoverable && (
            <p className="text-xs text-warning">
              Custom path: setup wizards only auto-discover <span className="font-mono">costgoblin/org-config.yaml</span> at a bucket root — share this location with teammates yourself.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="publish-profile" className="text-xs text-text-muted uppercase tracking-wider">
            Publish with profile
          </label>
          <ProfilePicker
            profiles={profiles}
            selected={publishProfile}
            onSelect={setPublishProfile}
            currentProfile={configProfile}
            listClassName="max-h-32"
            inputId="publish-profile"
          />
          <p className="text-xs text-text-muted">
            Publishing needs <span className="font-mono">s3:PutObject</span> on the destination — pick an elevated profile if your day-to-day one is read-only. Sync keeps using the configured profile.
          </p>
        </div>
        {publishResult?.status === 'published' && (
          <p className="text-xs text-positive break-all">Published to {publishResult.location}</p>
        )}
        {publishResult?.status === 'error' && (
          <p className="text-xs text-negative break-words">{publishResult.message}</p>
        )}
      </div>

      <ShareDataSection />
    </div>
  );
}

export function ShareConfigDialog({ onClose }: Readonly<{ onClose: () => void }>): React.JSX.Element {
  return (
    <SharingModal title="Share configuration" onClose={onClose}>
      <ShareConfigPanel />
    </SharingModal>
  );
}

// ---------------------------------------------------------------------------
// Import dialog — pick file → validated preview → choose profile → apply.
// ---------------------------------------------------------------------------

type ImportPhase =
  | { phase: 'pick'; error: string | null }
  | { phase: 'loading' }
  | {
      phase: 'preview';
      content: string;
      summary: ConfigBundleSummary;
      profile: string;
      applying: boolean;
      error: string | null;
    }
  | { phase: 'done'; backupDir: string | null };

export function ImportConfigPanel({ onApplied, onClose, onBusyChange, onDoneChange }: Readonly<{
  /** Called after a bundle has been written to disk and the user dismissed
   *  the success state. The host should reload config-dependent state. */
  onApplied: () => void;
  /** Dismiss affordance for the preview-step "Cancel". When omitted (inline
   *  settings use, no modal to close) Cancel returns to the picker instead. */
  onClose?: () => void;
  /** Reports whether a teammate pull is in flight, so a host modal can lock
   *  itself shut. */
  onBusyChange?: (busy: boolean) => void;
  /** Reports whether the flow reached its success ('done') state. */
  onDoneChange?: (done: boolean) => void;
}>): React.JSX.Element {
  const api = useCostApi();
  const [state, setState] = useState<ImportPhase>({ phase: 'pick', error: null });
  // True while a teammate pull is in flight — locks the modal shut.
  const [pullBusy, setPullBusy] = useState(false);
  // Ambient resources for the "fetch from S3" source. Profiles double as
  // the apply-step picker options. The location prefills with the team's
  // published beacon when a config exists (the "pull team updates" case);
  // in the setup wizard there is no config yet and it starts empty.
  const [profiles, setProfiles] = useState<readonly string[]>([]);
  const [fetchProfile, setFetchProfile] = useState('');
  const [s3Location, setS3Location] = useState('');
  const [fetching, setFetching] = useState(false);
  // The configured sync profile is the only one guaranteed to reach the
  // billing-export bucket, so it beats the alphabetical-first fallback as the
  // default. Once the user picks a profile themselves, neither async
  // loader may override it.
  const userPickedProfileRef = useRef(false);

  function handlePickProfile(profile: string): void {
    userPickedProfileRef.current = true;
    setFetchProfile(profile);
  }

  useEffect(() => {
    api.listAwsProfiles().then(loaded => {
      setProfiles(loaded);
      if (!userPickedProfileRef.current) {
        setFetchProfile(prev => prev.length > 0 ? prev : (loaded[0] ?? 'default'));
      }
    }).catch(() => undefined);
    api.getConfig().then(config => {
      // The shared-config beacon lives in S3, so this flow is AWS-only.
      const provider = config.providers.find(p => p.type === 'aws');
      if (provider === undefined) return;
      if (!userPickedProfileRef.current) {
        setFetchProfile(provider.credentialsProfile);
      }
      setS3Location(prev => prev.length > 0 ? prev : suggestedConfigBeaconLocation(String(provider.sync.daily.bucket)));
    }).catch(() => undefined);
  }, [api]);

  const s3LocationValid = splitS3Location(s3Location) !== null;

  function handlePickFile(): void {
    setState({ phase: 'loading' });
    api.previewConfigBundleFile()
      .then(preview => {
        if (preview.status === 'canceled') {
          setState({ phase: 'pick', error: null });
          return;
        }
        if (preview.status === 'error') {
          setState({ phase: 'pick', error: preview.message });
          return;
        }
        setState({
          phase: 'preview',
          content: preview.content,
          summary: preview.summary,
          profile: fetchProfile.length > 0 ? fetchProfile : 'default',
          applying: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        setState({ phase: 'pick', error: err instanceof Error ? err.message : String(err) });
      });
  }

  function handleFetchFromS3(): void {
    if (fetching || !s3LocationValid || fetchProfile.length === 0) return;
    setFetching(true);
    setState({ phase: 'pick', error: null });
    api.fetchConfigBundleFromS3({ profile: fetchProfile, location: s3Location })
      .then(preview => {
        if (preview.status === 'ok') {
          setState({
            phase: 'preview',
            content: preview.content,
            summary: preview.summary,
            profile: fetchProfile,
            applying: false,
            error: null,
          });
        } else if (preview.status === 'error') {
          setState({ phase: 'pick', error: preview.message });
        } else {
          setState({ phase: 'pick', error: null });
        }
      })
      .catch((err: unknown) => {
        setState({ phase: 'pick', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setFetching(false); });
  }

  function handleApply(): void {
    if (state.phase !== 'preview' || state.applying) return;
    const { content, profile } = state;
    setState({ ...state, applying: true, error: null });
    api.applyConfigBundle({ content, credentialsProfile: profile })
      .then(result => {
        if (result.status === 'applied') {
          setState({ phase: 'done', backupDir: result.backupDir });
        } else {
          setState(prev => prev.phase === 'preview' ? { ...prev, applying: false, error: result.message } : prev);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState(prev => prev.phase === 'preview' ? { ...prev, applying: false, error: message } : prev);
      });
  }

  function handleCancel(): void {
    if (onClose !== undefined) { onClose(); return; }
    setState({ phase: 'pick', error: null });
  }

  useEffect(() => { onDoneChange?.(state.phase === 'done'); }, [state.phase, onDoneChange]);

  return (
    <div className="flex flex-col gap-4">
      {state.phase === 'pick' && (
        <>
          {!pullBusy && (
          <>
          <p className="text-sm text-text-secondary">
            Apply a configuration bundle from a teammate — choose an exported file, or fetch one straight from S3. You&apos;ll see exactly what it contains before anything is written, and your current configuration is backed up first.
          </p>
          {state.error !== null && (
            <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
              <p className="text-xs text-negative break-words">{state.error}</p>
            </div>
          )}
          <Button onClick={handlePickFile} className="bg-accent hover:bg-accent-hover text-white self-start">
            <FileUp size={16} className="mr-1.5" />
            Choose bundle file…
          </Button>

          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-muted">or fetch from S3</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="import-fetch-profile" className="text-xs text-text-muted uppercase tracking-wider">
              AWS profile
            </label>
            <ProfilePicker
              profiles={profiles}
              selected={fetchProfile}
              onSelect={handlePickProfile}
              listClassName="max-h-32"
              inputId="import-fetch-profile"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="import-s3-location" className="text-xs text-text-muted uppercase tracking-wider">
              S3 location
            </label>
            <input
              id="import-s3-location"
              type="text"
              value={s3Location}
              onChange={(e) => { setS3Location(e.target.value); }}
              placeholder="s3://bucket/costgoblin/org-config.yaml"
              spellCheck={false}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
            {s3Location.length > 0 && !s3LocationValid && (
              <p className="text-xs text-negative break-words">Enter a full object location like s3://bucket/costgoblin/org-config.yaml</p>
            )}
          </div>
          <Button
            onClick={handleFetchFromS3}
            disabled={fetching || !s3LocationValid || profiles.length === 0}
            className="bg-accent hover:bg-accent-hover text-white self-start"
          >
            <CloudDownload size={16} className="mr-1.5" />
            {fetching ? 'Fetching…' : 'Fetch from S3'}
          </Button>

          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-muted">or pull from a teammate on your network</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          </>
          )}
          <AddSharedSourceSection onPulled={onApplied} onBusyChange={(busy) => { setPullBusy(busy); onBusyChange?.(busy); }} />
        </>
      )}

      {state.phase === 'loading' && (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Reading bundle…</span>
        </div>
      )}

      {state.phase === 'preview' && (
        <>
          <BundleSummaryCard summary={state.summary} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="import-profile" className="text-xs text-text-muted uppercase tracking-wider">
              Your AWS profile
            </label>
            <ProfilePicker
              profiles={profiles}
              selected={state.profile}
              onSelect={(profile) => { setState(prev => prev.phase === 'preview' ? { ...prev, profile } : prev); }}
              listClassName="max-h-32"
              inputId="import-profile"
            />
            <p className="text-xs text-text-muted">Bundles never contain credentials — this profile is used to access the S3 buckets above.</p>
          </div>
          {state.error !== null && (
            <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
              <p className="text-xs text-negative break-words">{state.error}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-tertiary transition-colors"
            >
              Cancel
            </button>
            <Button onClick={handleApply} disabled={state.applying} className="bg-accent hover:bg-accent-hover text-white">
              {state.applying ? 'Applying…' : 'Apply configuration'}
            </Button>
          </div>
        </>
      )}

      {state.phase === 'done' && (
        <>
          <p className="text-sm text-text-primary">Configuration applied.</p>
          {state.backupDir !== null && (
            <p className="text-xs text-text-muted break-all">Your previous configuration was backed up to {state.backupDir}</p>
          )}
          <Button onClick={onApplied} className="bg-accent hover:bg-accent-hover text-white self-end">
            Done
          </Button>
        </>
      )}
    </div>
  );
}

export function ImportConfigDialog({ onClose, onApplied }: Readonly<{
  onClose: () => void;
  /** Called after a bundle has been written to disk and the user dismissed
   *  the success state. The host should reload config-dependent state. */
  onApplied: () => void;
}>): React.JSX.Element {
  // Mirror the panel's busy/done state so the modal can lock itself shut
  // during a pull and route Escape/✕ to onApplied once the import succeeds.
  const [pullBusy, setPullBusy] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <SharingModal title="Import configuration" onClose={done ? onApplied : onClose} dismissable={!pullBusy}>
      <ImportConfigPanel onApplied={onApplied} onClose={onClose} onBusyChange={setPullBusy} onDoneChange={setDone} />
    </SharingModal>
  );
}
