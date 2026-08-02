import type {
  ConfigBundleSummary,
  CreateWorkspaceSource,
  WorkspaceSummary,
  WorkspacesInfo,
} from '@costgoblin/core/browser';
import { WORKSPACE_NAME_PATTERN, WorkspaceNameError, isValidWorkspaceName, parseWorkspaceName } from '@costgoblin/core/browser';
import { Boxes, FileUp, Info, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BundleSummaryCard } from '../components/config-sharing.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { formatBytes } from '../components/format.js';
import { ProfilePicker } from '../components/profile-picker.js';
import { Button } from '../components/ui/button.js';
import { useCostApi } from '../hooks/use-cost-api.js';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly info: WorkspacesInfo }
  | { readonly status: 'error'; readonly message: string };

type ModalState =
  | { readonly kind: 'none' }
  | { readonly kind: 'create' }
  | { readonly kind: 'switch'; readonly target: WorkspaceSummary }
  | { readonly kind: 'rename'; readonly target: WorkspaceSummary }
  | { readonly kind: 'delete'; readonly target: WorkspaceSummary };

/** Friendly validation error for a candidate workspace name, or null when the
 *  name is acceptable (or still empty — no error is shown until typing starts).
 *  `ignore` excludes one workspace from the duplicate check (the one being
 *  renamed). Duplicates are rejected case-insensitively because the name
 *  becomes an on-disk directory name. */
function workspaceNameIssue(
  raw: string,
  existing: readonly WorkspaceSummary[],
  ignore?: string,
): string | null {
  if (raw.length === 0) return null;
  if (!WORKSPACE_NAME_PATTERN.test(raw)) {
    return 'Use letters, digits, - or _, starting with a letter or digit (64 characters max).';
  }
  if (!isValidWorkspaceName(raw)) {
    // Pattern-valid but still rejected → reserved name. parseWorkspaceName
    // carries the friendly per-case message.
    try {
      parseWorkspaceName(raw);
    } catch (err) {
      if (err instanceof WorkspaceNameError) return err.message;
      return err instanceof Error ? err.message : String(err);
    }
  }
  const lower = raw.toLowerCase();
  const duplicate = existing.some(
    w => w.name.toLowerCase() === lower && (ignore === undefined || w.name.toLowerCase() !== ignore.toLowerCase()),
  );
  if (duplicate) return `A workspace named "${raw}" already exists.`;
  return null;
}

function formatLastUsed(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function deleteMessage(ws: WorkspaceSummary): string {
  const size = ws.sizeBytes === null ? '' : ` (${formatBytes(ws.sizeBytes)} on disk)`;
  return `Deleting workspace "${ws.name}" permanently deletes all of its synced data and configuration${size}. This cannot be undone.`;
}

// ---------------------------------------------------------------------------
// Shared dialog chrome — same overlay pattern as ConfirmModal / SharingModal.
// ---------------------------------------------------------------------------

function WorkspaceModal({ title, onClose, children }: Readonly<{
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
    // no-drag: the modal can open above a window drag region (the app header) —
    // without the opt-out, clicks there would drag the window instead of
    // reaching the modal.
    <dialog open className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent m-0 p-0 max-w-none max-h-none w-full h-full border-none [-webkit-app-region:no-drag]" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
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
// New workspace — validated name + start-from source (fresh / copy / bundle).
// ---------------------------------------------------------------------------

type SourceKind = CreateWorkspaceSource['kind'];

const SOURCE_OPTIONS: readonly { readonly kind: SourceKind; readonly label: string; readonly description: string }[] = [
  {
    kind: 'fresh',
    label: 'Start fresh',
    description: 'An empty workspace — run setup from scratch.',
  },
  {
    kind: 'copy-config',
    label: 'Copy current config (no data)',
    description: 'Reuses this workspace’s dimensions, dashboards, and cost scope. Synced data is not copied.',
  },
  {
    kind: 'bundle',
    label: 'Import a shared config bundle',
    description: 'Start from a configuration bundle a teammate exported.',
  },
];

type BundlePick =
  | { readonly phase: 'idle'; readonly error: string | null }
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly content: string; readonly summary: ConfigBundleSummary };

type CreatePhase = 'idle' | 'stay' | 'switch';

function CreateWorkspaceModal({ existing, onClose, onCreated }: Readonly<{
  existing: readonly WorkspaceSummary[];
  onClose: () => void;
  /** Called with the refreshed list after a non-switching create. A "Create &
   *  switch" relaunches the app, so this only runs when the promise resolves
   *  (non-switch, or mocked tests). */
  onCreated: (info: WorkspacesInfo) => void;
}>): React.JSX.Element {
  const api = useCostApi();
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('fresh');
  const [bundle, setBundle] = useState<BundlePick>({ phase: 'idle', error: null });
  const [profiles, setProfiles] = useState<readonly string[]>([]);
  const [awsProfile, setAwsProfile] = useState('');
  const [creating, setCreating] = useState<CreatePhase>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // AWS profiles back the bundle branch's profile picker — obtained the same
  // way ImportConfigPanel does (listAwsProfiles), loaded once on open.
  useEffect(() => {
    api.listAwsProfiles().then(loaded => {
      setProfiles(loaded);
      setAwsProfile(prev => prev.length > 0 ? prev : (loaded[0] ?? 'default'));
    }).catch(() => undefined);
  }, [api]);

  const nameIssue = workspaceNameIssue(name, existing);
  const nameOk = name.length > 0 && isValidWorkspaceName(name) && nameIssue === null;
  const sourceReady = sourceKind !== 'bundle' || (bundle.phase === 'ready' && awsProfile.length > 0);
  const canSubmit = nameOk && sourceReady && creating === 'idle';

  function handlePickBundle(): void {
    setBundle({ phase: 'loading' });
    api.previewConfigBundleFile().then(res => {
      if (res.status === 'ok') {
        setBundle({ phase: 'ready', content: res.content, summary: res.summary });
      } else if (res.status === 'canceled') {
        setBundle({ phase: 'idle', error: null });
      } else {
        setBundle({ phase: 'idle', error: res.message });
      }
    }).catch((err: unknown) => {
      setBundle({ phase: 'idle', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function buildSource(): CreateWorkspaceSource | null {
    if (sourceKind === 'fresh') return { kind: 'fresh' };
    if (sourceKind === 'copy-config') return { kind: 'copy-config' };
    if (bundle.phase !== 'ready' || awsProfile.length === 0) return null;
    return { kind: 'bundle', content: bundle.content, awsProfile };
  }

  function handleCreate(switchTo: boolean): void {
    const source = buildSource();
    if (source === null || !canSubmit) return;
    setCreating(switchTo ? 'switch' : 'stay');
    setSubmitError(null);
    api.createWorkspace(name, source, switchTo)
      .then(info => { onCreated(info); })
      .catch((err: unknown) => {
        setCreating('idle');
        setSubmitError(err instanceof Error ? err.message : String(err));
      });
  }

  return (
    <WorkspaceModal title="New workspace" onClose={onClose}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-workspace-name" className="text-xs text-text-muted uppercase tracking-wider">
          Workspace name
        </label>
        <input
          id="new-workspace-name"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); }}
          placeholder="e.g. client-acme"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
        />
        {nameIssue !== null && <p className="text-xs text-negative">{nameIssue}</p>}
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs text-text-muted uppercase tracking-wider mb-1.5">Start from</legend>
        {SOURCE_OPTIONS.map(option => (
          <label
            key={option.kind}
            htmlFor={`workspace-source-${option.kind}`}
            className="grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-lg border border-border bg-bg-tertiary/20 px-3 py-2 cursor-pointer"
          >
            <input
              id={`workspace-source-${option.kind}`}
              type="radio"
              name="workspace-source"
              checked={sourceKind === option.kind}
              onChange={() => { setSourceKind(option.kind); }}
              className="mt-0.5 accent-accent"
            />
            <span className="text-sm text-text-primary">{option.label}</span>
            <span className="col-start-2 block text-xs text-text-muted">{option.description}</span>
          </label>
        ))}
      </fieldset>

      {sourceKind === 'bundle' && (
        <div className="flex flex-col gap-2">
          {bundle.phase === 'idle' && (
            <>
              {bundle.error !== null && (
                <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
                  <p className="text-xs text-negative">{bundle.error}</p>
                </div>
              )}
              <Button onClick={handlePickBundle} className="bg-accent hover:bg-accent-hover text-white self-start">
                <FileUp size={16} className="mr-1.5" />
                Choose bundle file…
              </Button>
            </>
          )}
          {bundle.phase === 'loading' && (
            <div className="flex items-center py-2">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
              <span className="ml-2 text-sm text-text-secondary">Reading bundle…</span>
            </div>
          )}
          {bundle.phase === 'ready' && (
            <>
              <BundleSummaryCard summary={bundle.summary} />
              <button
                type="button"
                onClick={handlePickBundle}
                className="self-start text-xs text-text-muted hover:text-text-secondary underline underline-offset-2"
              >
                Choose a different file…
              </button>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="workspace-bundle-profile" className="text-xs text-text-muted uppercase tracking-wider">
                  Your AWS profile
                </label>
                <ProfilePicker
                  profiles={profiles}
                  selected={awsProfile}
                  onSelect={setAwsProfile}
                  listClassName="max-h-32"
                  inputId="workspace-bundle-profile"
                />
                <p className="text-xs text-text-muted">
                  Bundles never contain credentials — the new workspace uses this AWS profile to reach the S3 buckets above.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {submitError !== null && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
          <p className="text-xs text-negative">{submitError}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => { handleCreate(false); }}
          disabled={!canSubmit}
          className="bg-bg-tertiary hover:bg-bg-tertiary/70 text-text-primary"
        >
          {creating === 'stay' ? 'Creating…' : 'Create'}
        </Button>
        <Button
          onClick={() => { handleCreate(true); }}
          disabled={!canSubmit}
          className="bg-accent hover:bg-accent-hover text-white"
        >
          {creating === 'switch' ? 'Creating…' : 'Create & switch'}
        </Button>
      </div>
    </WorkspaceModal>
  );
}

// ---------------------------------------------------------------------------
// Rename — validated input; renaming the active workspace restarts the app.
// ---------------------------------------------------------------------------

function RenameWorkspaceModal({ target, existing, onClose, onRenamed }: Readonly<{
  target: WorkspaceSummary;
  existing: readonly WorkspaceSummary[];
  onClose: () => void;
  /** Called with the refreshed list after an inactive rename. An active rename
   *  relaunches the app, so the promise never resolves in that case. */
  onRenamed: (info: WorkspacesInfo) => void;
}>): React.JSX.Element {
  const api = useCostApi();
  const [name, setName] = useState(target.name);
  const [renaming, setRenaming] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameIssue = workspaceNameIssue(name, existing, target.name);
  const canSubmit = name.length > 0 && name !== target.name && isValidWorkspaceName(name) && nameIssue === null && !renaming;

  function handleRename(): void {
    if (!canSubmit) return;
    setRenaming(true);
    setSubmitError(null);
    api.renameWorkspace(target.name, name)
      .then(info => { onRenamed(info); })
      .catch((err: unknown) => {
        setRenaming(false);
        setSubmitError(err instanceof Error ? err.message : String(err));
      });
  }

  return (
    <WorkspaceModal title="Rename workspace" onClose={onClose}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rename-workspace-name" className="text-xs text-text-muted uppercase tracking-wider">
          New name
        </label>
        <input
          id="rename-workspace-name"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); }}
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
        />
        {nameIssue !== null && <p className="text-xs text-negative">{nameIssue}</p>}
      </div>
      {target.active && (
        <p className="text-xs text-text-muted">
          This is the active workspace — CostGoblin will restart to finish the rename.
        </p>
      )}
      {submitError !== null && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2">
          <p className="text-xs text-negative">{submitError}</p>
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
        <Button onClick={handleRename} disabled={!canSubmit} className="bg-accent hover:bg-accent-hover text-white">
          {renaming ? 'Renaming…' : 'Rename'}
        </Button>
      </div>
    </WorkspaceModal>
  );
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

function WorkspaceRow({ workspace, onSwitch, onRename, onDelete }: Readonly<{
  workspace: WorkspaceSummary;
  onSwitch: () => void;
  onRename: () => void;
  onDelete: () => void;
}>): React.JSX.Element {
  return (
    <div data-testid={`workspace-row-${workspace.name}`} className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium text-text-primary truncate">{workspace.name}</span>
          {workspace.active && (
            <span className="shrink-0 rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
              Active
            </span>
          )}
          {!workspace.configured && (
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-warning">Not set up</span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">
          {workspace.sizeBytes === null ? '—' : formatBytes(workspace.sizeBytes)}
          {' · Last used '}
          {formatLastUsed(workspace.lastUsedAt)}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!workspace.active && (
          <button
            type="button"
            onClick={onSwitch}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            Switch
          </button>
        )}
        <button
          type="button"
          onClick={onRename}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          Rename
        </button>
        {!workspace.active && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-negative hover:bg-negative/10 transition-colors"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings → Workspaces
// ---------------------------------------------------------------------------

export function WorkspacesView({ onChanged }: Readonly<{
  /** Fires with fresh info after the initial load and every successful
   *  mutation — lets the host keep its header workspace chip in sync. Pass a
   *  stable reference (e.g. a setState) to avoid refetch loops. */
  onChanged?: ((info: WorkspacesInfo) => void) | undefined;
}>): React.JSX.Element {
  const api = useCostApi();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then(info => {
        if (cancelled) return;
        setState({ status: 'success', info });
        onChanged?.(info);
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [api, onChanged]);

  function applyInfo(info: WorkspacesInfo): void {
    setState({ status: 'success', info });
    setModal({ kind: 'none' });
    onChanged?.(info);
  }

  function handleSwitchConfirm(name: string): void {
    setActionError(null);
    // Success relaunches the app into the target workspace — nothing to
    // refresh here; only a failure needs surfacing.
    api.switchWorkspace(name)
      .then(() => { setModal({ kind: 'none' }); })
      .catch((err: unknown) => {
        setModal({ kind: 'none' });
        setActionError(err instanceof Error ? err.message : String(err));
      });
  }

  function handleDeleteConfirm(name: string): void {
    setActionError(null);
    api.deleteWorkspace(name)
      .then(applyInfo)
      .catch((err: unknown) => {
        setModal({ kind: 'none' });
        setActionError(err instanceof Error ? err.message : String(err));
      });
  }

  const info = state.status === 'success' ? state.info : null;
  const workspaceMode = info !== null && info.mode === 'workspace';

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="size-5 text-accent" />
            <h2 className="text-xl font-semibold text-text-primary">Workspaces</h2>
          </div>
          <p className="text-sm text-text-secondary mt-1">
            Fully isolated environments on this machine — each workspace has its own data, configuration, and dashboards.
          </p>
        </div>
        {workspaceMode && (
          <Button
            onClick={() => { setModal({ kind: 'create' }); }}
            className="bg-accent hover:bg-accent-hover text-white shrink-0"
          >
            <Plus size={16} className="mr-1.5" />
            New workspace
          </Button>
        )}
      </div>

      {state.status === 'loading' && (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading workspaces…</span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm text-negative">Could not load workspaces: {state.message}</p>
        </div>
      )}

      {info !== null && info.mode === 'pinned' && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <Info size={16} className="text-text-muted shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-text-primary">Workspaces are unavailable in this session</p>
            <p className="text-xs text-text-muted mt-1">
              CostGoblin was launched with its data and configuration paths pinned by environment overrides
              (a development or test launch), so workspace management is disabled.
            </p>
          </div>
        </div>
      )}

      {actionError !== null && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm text-negative">{actionError}</p>
        </div>
      )}

      {info !== null && info.mode === 'workspace' && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {info.workspaces.map(ws => (
            <WorkspaceRow
              key={ws.name}
              workspace={ws}
              onSwitch={() => { setModal({ kind: 'switch', target: ws }); }}
              onRename={() => { setModal({ kind: 'rename', target: ws }); }}
              onDelete={() => { setModal({ kind: 'delete', target: ws }); }}
            />
          ))}
        </div>
      )}

      {modal.kind === 'create' && info !== null && (
        <CreateWorkspaceModal
          existing={info.workspaces}
          onClose={() => { setModal({ kind: 'none' }); }}
          onCreated={applyInfo}
        />
      )}
      {modal.kind === 'rename' && info !== null && (
        <RenameWorkspaceModal
          target={modal.target}
          existing={info.workspaces}
          onClose={() => { setModal({ kind: 'none' }); }}
          onRenamed={applyInfo}
        />
      )}
      {modal.kind === 'switch' && (
        <ConfirmModal
          title="Switch workspace"
          message={`Switch to workspace "${modal.target.name}"? CostGoblin will restart.`}
          confirmLabel="Switch & Restart"
          onConfirm={() => { handleSwitchConfirm(modal.target.name); }}
          onCancel={() => { setModal({ kind: 'none' }); }}
        />
      )}
      {modal.kind === 'delete' && (
        <ConfirmModal
          title="Delete workspace"
          message={deleteMessage(modal.target)}
          confirmLabel="Delete Workspace"
          destructive
          onConfirm={() => { handleDeleteConfirm(modal.target.name); }}
          onCancel={() => { setModal({ kind: 'none' }); }}
        />
      )}
    </div>
  );
}
