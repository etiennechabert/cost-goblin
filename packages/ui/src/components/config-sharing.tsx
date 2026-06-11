import type {
  ConfigBundleSummary,
  ExportConfigBundleResult,
  PublishConfigBundleResult,
} from '@costgoblin/core/browser';
import { CloudUpload, FileDown, FileUp, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Button } from './ui/button.js';

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

function SharingModal({ title, onClose, children }: Readonly<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}>): React.JSX.Element {
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [onClose]);

  return (
    <dialog open className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent m-0 p-0 max-w-none max-h-none w-full h-full border-none" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Share dialog — export to file / publish to the S3 beacon.
// ---------------------------------------------------------------------------

export function ShareConfigDialog({ onClose }: Readonly<{ onClose: () => void }>): React.JSX.Element {
  const api = useCostApi();
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportConfigBundleResult | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishConfigBundleResult | null>(null);

  function handleExport(): void {
    setExporting(true);
    setExportResult(null);
    api.exportConfigBundle()
      .then(setExportResult)
      .catch((err: unknown) => { setExportResult({ status: 'error', message: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { setExporting(false); });
  }

  function handlePublish(): void {
    setPublishing(true);
    setPublishResult(null);
    api.publishConfigBundle()
      .then(setPublishResult)
      .catch((err: unknown) => { setPublishResult({ status: 'error', message: err instanceof Error ? err.message : String(err) }); })
      .finally(() => { setPublishing(false); });
  }

  return (
    <SharingModal title="Share configuration" onClose={onClose}>
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
          <p className="text-xs text-negative">{exportResult.message}</p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CloudUpload size={16} className="text-text-secondary" />
            <div>
              <p className="text-sm font-medium text-text-primary">Publish to your CUR bucket</p>
              <p className="text-xs text-text-muted">
                Teammates&apos; setup wizards find it automatically. Anyone who can read the billing data can read it.
              </p>
            </div>
          </div>
          <Button onClick={handlePublish} disabled={publishing} className="bg-accent hover:bg-accent-hover text-white shrink-0">
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
        {publishResult?.status === 'published' && (
          <p className="text-xs text-positive break-all">Published to {publishResult.location}</p>
        )}
        {publishResult?.status === 'error' && (
          <p className="text-xs text-negative">{publishResult.message}</p>
        )}
      </div>
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
      profiles: readonly string[];
      profile: string;
      applying: boolean;
      error: string | null;
    }
  | { phase: 'done'; backupDir: string | null };

export function ImportConfigDialog({ onClose, onApplied }: Readonly<{
  onClose: () => void;
  /** Called after a bundle has been written to disk and the user dismissed
   *  the success state. The host should reload config-dependent state. */
  onApplied: () => void;
}>): React.JSX.Element {
  const api = useCostApi();
  const [state, setState] = useState<ImportPhase>({ phase: 'pick', error: null });

  function handlePickFile(): void {
    setState({ phase: 'loading' });
    Promise.all([api.previewConfigBundleFile(), api.listAwsProfiles()])
      .then(([preview, profiles]) => {
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
          profiles,
          profile: profiles[0] ?? 'default',
          applying: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        setState({ phase: 'pick', error: err instanceof Error ? err.message : String(err) });
      });
  }

  function handleApply(): void {
    if (state.phase !== 'preview' || state.applying) return;
    const { content, profile } = state;
    setState({ ...state, applying: true, error: null });
    api.applyConfigBundle({ content, profile })
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

  return (
    <SharingModal title="Import configuration" onClose={state.phase === 'done' ? onApplied : onClose}>
      {state.phase === 'pick' && (
        <>
          <p className="text-sm text-text-secondary">
            Apply a configuration bundle exported by a teammate. You&apos;ll see exactly what it contains before anything is written, and your current configuration is backed up first.
          </p>
          {state.error !== null && (
            <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
              <p className="text-xs text-negative">{state.error}</p>
            </div>
          )}
          <Button onClick={handlePickFile} className="bg-accent hover:bg-accent-hover text-white self-start">
            <FileUp size={16} className="mr-1.5" />
            Choose bundle file…
          </Button>
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
            <select
              id="import-profile"
              value={state.profile}
              onChange={(e) => { const profile = e.target.value; setState(prev => prev.phase === 'preview' ? { ...prev, profile } : prev); }}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/50"
            >
              {state.profiles.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <p className="text-xs text-text-muted">Bundles never contain credentials — this profile is used to access the S3 buckets above.</p>
          </div>
          {state.error !== null && (
            <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
              <p className="text-xs text-negative">{state.error}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
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
    </SharingModal>
  );
}
