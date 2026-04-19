import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import type { DimensionsConfig, TagDimension, ConceptType, NormalizationRule } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { ConfirmModal } from '../components/confirm-modal.js';

type DragGroup = 'builtIn' | 'tag';
interface DragRef { type: DragGroup; idx: number }

const CONCEPTS: { value: ConceptType; label: string }[] = [
  { value: 'owner', label: 'Owner (team)' },
  { value: 'product', label: 'Product (system)' },
  { value: 'environment', label: 'Environment' },
];

const NORMALIZE_RULES: { value: NormalizationRule; label: string }[] = [
  { value: 'lowercase', label: 'lowercase' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase-kebab', label: 'kebab-case (a-b-c)' },
  { value: 'lowercase-underscore', label: 'snake_case (a_b_c)' },
  { value: 'camelCase', label: 'camelCase' },
];

interface EditingBuiltIn {
  label: string;
  description: string;
  normalize: string;
  aliases: string;
  useOrgAccounts: boolean;
  nameStripPatterns: string;
  useRegionNames: boolean;
}

function BuiltInEditor({ dim, onSave, onCancel }: Readonly<{
  dim: { name: string; field: string; editing: EditingBuiltIn };
  onSave: (edited: EditingBuiltIn) => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const isAccountDim = dim.field === 'account_id';
  // Three dims share field='region' — distinguish by name so only the Region
  // dim gets the longName toggle, while Country/Continent are pure derived
  // views with no user toggle (SSM data is either there or not).
  const isRegionDim = dim.name === 'region';
  const isRegionCountryDim = dim.name === 'region_country';
  const isRegionContinentDim = dim.name === 'region_continent';
  const isAnyRegionDim = dim.field === 'region';
  // AWS-controlled values arrive in a single canonical form — normalize/strip
  // would only chip at the labels users already recognize. Aliases stay
  // visible since folding "AmazonEC2 → EC2" is a reasonable user choice.
  const TRANSFORM_FREE_FIELDS = new Set(['service', 'service_family']);
  const showTransforms = !TRANSFORM_FREE_FIELDS.has(dim.field);
  const api = useCostApi();
  const [state, setState] = useState(dim.editing);
  // Surface missing enrichment data: Region needs SSM region-names sync,
  // Account (with org-data toggle) needs the AWS Org sync. Both ship as
  // side-effects of the org sync on the Sync tab — without them the dim's
  // values render as raw codes / IDs.
  const regionInfoQuery = useQuery(
    () => isAnyRegionDim ? api.getRegionNamesInfo() : Promise.resolve(null),
    [isAnyRegionDim],
  );
  const orgQuery = useQuery(
    () => isAccountDim ? api.getOrgSyncResult() : Promise.resolve(null),
    [isAccountDim],
  );
  const initialRef = useRef(dim.editing);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const isDirty = JSON.stringify(state) !== JSON.stringify(initialRef.current);
  function requestCancel(): void {
    if (isDirty) setDiscardConfirm(true);
    else onCancel();
  }
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Parse the textarea once per render — empty lines and trailing whitespace
  // are dropped so a stray Enter doesn't make the regex .replace() a no-op.
  const stripPatternList = state.nameStripPatterns
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  const stripPatternsKey = stripPatternList.join('\u0001');
  const normalize: NormalizationRule | undefined = state.normalize.length > 0 ? state.normalize as NormalizationRule : undefined;
  const valuesQuery = useQuery(
    () => api.discoverColumnValues(
      dim.field,
      {
        ...(normalize !== undefined ? { normalize } : {}),
        ...(isAccountDim ? { useOrgAccounts: state.useOrgAccounts, nameStripPatterns: stripPatternList } : {}),
        ...(isAnyRegionDim ? { dimName: dim.name, useRegionNames: state.useRegionNames } : {}),
      },
    ),
    [dim.field, dim.name, isAccountDim, isAnyRegionDim, state.useOrgAccounts, state.useRegionNames, stripPatternsKey, normalize],
  );

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current === null) return;
      if (!(e.target instanceof Node)) return;
      if (containerRef.current.contains(e.target)) return;
      // Don't dismiss while the discard-confirm modal is open — the modal
      // lives outside the editor's DOM tree and would otherwise count as
      // an outside click.
      if (discardConfirm) return;
      if (isDirty) setDiscardConfirm(true);
      else onCancel();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => { document.removeEventListener('mousedown', onDocClick); };
  }, [onCancel, isDirty, discardConfirm]);

  const preview = valuesQuery.status === 'success' ? valuesQuery.data : null;

  const labelField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Display Label</span>
      <input
        type="text"
        value={state.label}
        onChange={e => { setState(s => ({ ...s, label: e.target.value })); }}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
  const descriptionField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Description</span>
      <input
        type="text"
        value={state.description}
        onChange={e => { setState(s => ({ ...s, description: e.target.value })); }}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
        placeholder="What does this dimension represent?"
      />
    </label>
  );
  const orgToggleField = (
    <label className="flex items-center justify-between rounded border border-border bg-bg-primary px-3 py-2 h-full">
      <div className="flex flex-col gap-0.5 min-w-0 pr-3">
        <span className="text-sm text-text-primary">Resolve names via org-data</span>
        <span className="text-[11px] text-text-muted leading-tight">Use friendly names from the Organizations sync.</span>
      </div>
      <DimensionToggle enabled={state.useOrgAccounts} onToggle={() => { setState(s => ({ ...s, useOrgAccounts: !s.useOrgAccounts })); }} />
    </label>
  );
  // Region equivalent of the org toggle. Disabled (and forced-off in preview)
  // when the SSM region snapshot isn't present — the toggle's whole point is
  // to swap raw codes for the SSM-sourced friendly names, so without data
  // it's a no-op. We gate on query.status so we don't flash a disabled toggle
  // while the info is still loading.
  const regionInfoLoaded = regionInfoQuery.status === 'success';
  const regionDataAvailable = regionInfoLoaded && regionInfoQuery.data !== null && regionInfoQuery.data.count > 0;
  const regionToggleField = (
    <label className={['flex items-center justify-between rounded border border-border bg-bg-primary px-3 py-2 h-full', regionDataAvailable ? '' : 'opacity-60'].join(' ')}>
      <div className="flex flex-col gap-0.5 min-w-0 pr-3">
        <span className="text-sm text-text-primary">Resolve codes via SSM region names</span>
        <span className="text-[11px] text-text-muted leading-tight">
          {regionDataAvailable
            ? 'Use friendly names (e.g. "Europe (Frankfurt)") from the SSM snapshot.'
            : 'Sync SSM Parameter Store from Data Management to enable.'}
        </span>
      </div>
      <DimensionToggle
        enabled={state.useRegionNames && regionDataAvailable}
        onToggle={() => {
          if (!regionDataAvailable) return;
          setState(s => ({ ...s, useRegionNames: !s.useRegionNames }));
        }}
      />
    </label>
  );
  const normalizationField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Normalization</span>
      <select
        value={state.normalize}
        onChange={e => { setState(s => ({ ...s, normalize: e.target.value })); }}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
      >
        <option value="">None</option>
        {NORMALIZE_RULES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
    </label>
  );
  const stripPatternsField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Name strip patterns (one regex per line)</span>
      <textarea
        value={state.nameStripPatterns}
        onChange={e => { setState(s => ({ ...s, nameStripPatterns: e.target.value })); }}
        rows={3}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary outline-none focus:border-accent"
        placeholder={'\\s+(production|staging|sandbox)$\n^DiBa Cards '}
      />
    </label>
  );
  const aliasField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Alias Rules (canonical: alias1, alias2)</span>
      <textarea
        value={state.aliases}
        onChange={e => { setState(s => ({ ...s, aliases: e.target.value })); }}
        rows={3}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary outline-none focus:border-accent"
        placeholder="EC2: AmazonEC2, EC2-Instance"
      />
    </label>
  );

  // Compute enrichment-data warnings:
  //   - Region dim ships raw codes ('eu-central-1') unless region-names.json
  //     was synced from SSM. Warn either way: missing entirely, or last
  //     attempt errored (typically: profile lacks ssm:GetParametersByPath).
  //   - Account dim's org-data toggle resolves IDs → names from the AWS Org
  //     sync. Warn when toggle is on but the sync result file is missing.
  const regionInfo = regionInfoQuery.status === 'success' ? regionInfoQuery.data : null;
  const orgInfo = orgQuery.status === 'success' ? orgQuery.data : null;
  // Warn when the user's editing a dim that needs SSM data but the snapshot
  // isn't there. Region: only when the friendly-names toggle is on (off is a
  // valid state — raw codes). Country/Continent: always, since these dims
  // are defined entirely in terms of SSM enrichment and collapse to raw
  // codes otherwise.
  const wantsRegionEnrichment = (isRegionDim && state.useRegionNames) || isRegionCountryDim || isRegionContinentDim;
  const regionWarning: { kind: 'missing' | 'error'; message?: string } | null =
    wantsRegionEnrichment && regionInfoQuery.status === 'success'
      ? regionInfo === null
        ? { kind: 'missing' }
        : regionInfo.lastError !== null
          ? { kind: 'error', message: regionInfo.lastError }
          : regionInfo.count === 0
            ? { kind: 'missing' }
            : null
      : null;
  const accountWarning: boolean =
    isAccountDim && state.useOrgAccounts && orgQuery.status === 'success' && orgInfo === null;

  return (
    <div ref={containerRef} className="rounded-xl border border-accent/30 bg-bg-tertiary/10 px-5 py-4 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        {labelField}
        {descriptionField}
      </div>
      {regionWarning !== null && (
        <div className="rounded-md border border-warning/50 bg-warning-muted px-3 py-2 text-xs flex flex-col gap-1">
          <p className="font-medium text-warning">Region friendly names not available</p>
          {regionWarning.kind === 'error' ? (
            <p className="text-text-secondary">
              Last sync attempt failed: <span className="font-mono text-text-primary">{regionWarning.message}</span>
            </p>
          ) : (
            <p className="text-text-secondary">
              Region values will display as raw codes (e.g. <span className="font-mono">eu-central-1</span>).
              Sync the <span className="font-medium">SSM Parameter Store</span> section on Data Management to
              fetch the friendly names.
            </p>
          )}
        </div>
      )}
      {accountWarning && (
        <div className="rounded-md border border-warning/50 bg-warning-muted px-3 py-2 text-xs flex flex-col gap-1">
          <p className="font-medium text-warning">Org-data not synced</p>
          <p className="text-text-secondary">
            The "Resolve names via org-data" toggle is on but no AWS Organization sync has run yet —
            account values will display as raw 12-digit IDs. Run the sync from the <span className="font-medium">Sync</span> tab to populate.
          </p>
        </div>
      )}
      {showTransforms && (
        <div className="grid grid-cols-2 gap-4 items-stretch">
          {isAccountDim ? orgToggleField : isRegionDim ? regionToggleField : <div />}
          {normalizationField}
        </div>
      )}
      {showTransforms ? (
        <div className="grid grid-cols-2 gap-4">
          {isAccountDim ? stripPatternsField : <div />}
          {aliasField}
        </div>
      ) : aliasField}
      {preview !== null && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-text-muted">
            Preview — {String(preview.distinctCount)} distinct values
            {preview.period.length > 0 ? ` (from ${preview.period})` : ''}
          </span>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {preview.values.slice(0, 60).map(v => (
              <span key={v.value} className="rounded border border-border bg-bg-primary px-2 py-0.5 text-[11px] text-text-secondary font-mono">
                {v.value}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between pt-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { onSave(state); }}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-bg-primary hover:bg-accent/90 transition-colors"
          >
            Save
          </button>
          <button
            type="button"
            onClick={requestCancel}
            className="rounded-md px-4 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
      {discardConfirm && (
        <ConfirmModal
          title="Discard unsaved changes?"
          message="You have edits that haven't been saved. Closing the editor will discard them."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => { setDiscardConfirm(false); onCancel(); }}
          onCancel={() => { setDiscardConfirm(false); }}
        />
      )}
    </div>
  );
}

/** Collapsible container for the diagnostic pivot tables at the bottom of
 *  the Dimensions view. The caller decides what to render inside — this
 *  component only owns the header + expand/collapse affordance. */
function DebugPanel({ title, subtitle, expanded, onToggle, children }: Readonly<{
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-bg-tertiary/30 transition-colors"
      >
        <span className="text-text-muted text-xs">{expanded ? '▾' : '▸'}</span>
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <span className="text-[11px] text-text-muted">{subtitle}</span>
      </button>
      {expanded && (
        <div className="px-5 pb-4 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}

function DimensionToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={enabled ? 'Hide from selectors and filters' : 'Show in selectors and filters'}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
        ].join(' ')}
      />
    </button>
  );
}

interface EditingTag {
  tagName: string;
  label: string;
  concept: string;
  normalize: string;
  aliases: string;
  fallbackTag: string | undefined;
  missingValueTemplate: string;
}

function aliasesToText(aliases: Readonly<Record<string, readonly string[]>> | undefined): string {
  if (aliases === undefined) return '';
  return Object.entries(aliases)
    .map(([canonical, alts]) => `${canonical}: ${alts.join(', ')}`)
    .join('\n');
}

function textToAliases(text: string): Record<string, readonly string[]> | undefined {
  if (text.trim().length === 0) return undefined;
  const result: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const canonical = line.slice(0, idx).trim();
    const alts = line.slice(idx + 1).split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (canonical.length > 0 && alts.length > 0) {
      result[canonical] = alts;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function TagEditor({ tag, onSave, onCancel, onRemove, availableTags, discoveredTags: discovered, accountTagKeys: acctTags, orgAccounts }: Readonly<{
  tag: EditingTag;
  onSave: (tag: EditingTag) => void;
  onCancel: () => void;
  onRemove: (() => void) | undefined;
  availableTags: readonly string[];
  discoveredTags: readonly { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[];
  accountTagKeys: readonly string[];
  orgAccounts: readonly { tags: Readonly<Record<string, string>> }[];
}>) {
  const [state, setState] = useState(tag);
  const initialRef = useRef(tag);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const isDirty = JSON.stringify(state) !== JSON.stringify(initialRef.current);
  function requestCancel(): void {
    if (isDirty) setDiscardConfirm(true);
    else onCancel();
  }
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click outside the editor panel closes it (matches the collapse-on-outside
  // pattern the rest of the app uses for popovers). A native 'click' listener
  // on document fires after onClick handlers, so clicks on Save/Cancel/Remove
  // inside the panel still work as expected. When the form is dirty we
  // intercept and route through the discard-confirm modal instead.
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current === null) return;
      if (!(e.target instanceof Node)) return;
      if (containerRef.current.contains(e.target)) return;
      if (discardConfirm) return;
      if (isDirty) setDiscardConfirm(true);
      else onCancel();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => { document.removeEventListener('mousedown', onDocClick); };
  }, [onCancel, isDirty, discardConfirm]);

  const tagOptions = state.tagName.length > 0 && !availableTags.includes(state.tagName)
    ? [state.tagName, ...availableTags]
    : [...availableTags];

  const tagMatch = discovered.find(t => t.key === state.tagName);

  const fallbackValues = (() => {
    if (state.fallbackTag === undefined || state.fallbackTag.length === 0) return [];
    const counts = new Map<string, number>();
    for (const acct of orgAccounts) {
      const val = acct.tags[state.fallbackTag];
      if (val !== undefined && val.length > 0) {
        counts.set(val, (counts.get(val) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();

  return (
    <div ref={containerRef} className="rounded-xl border border-accent/30 bg-bg-tertiary/10 px-5 py-4 flex flex-col gap-4">
      {/* Row 1: Concept + Display Label + Normalization */}
      <div className="grid grid-cols-3 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Concept</span>
          <select
            value={state.concept}
            onChange={e => { setState(s => ({ ...s, concept: e.target.value })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">None</option>
            {CONCEPTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Display Label</span>
          <input
            type="text"
            value={state.label}
            onChange={e => { setState(s => ({ ...s, label: e.target.value })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            placeholder="e.g. Team"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Normalization</span>
          <select
            value={state.normalize}
            onChange={e => { setState(s => ({ ...s, normalize: e.target.value })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">None</option>
            {NORMALIZE_RULES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {/* Row 2: Tag Name + preview */}
      <div className="grid grid-cols-[1fr_2fr] gap-4 items-start">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Resource Tag</span>
          <select
            value={state.tagName}
            onChange={e => {
              const name = e.target.value;
              const label = name
                .replace(/^user_/i, '')
                .replaceAll('_', ' ')
                .replaceAll('-', ' ')
                .replace(/\b\w/g, c => c.toUpperCase());
              setState(s => ({ ...s, tagName: name, label: s.label.length === 0 ? label : s.label }));
            }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">Select a tag...</option>
            {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          {tagMatch !== undefined && (
            <>
              <span className="text-xs text-text-muted">{String(tagMatch.coveragePct)}% coverage · {String(tagMatch.distinctCount)} distinct values</span>
              <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                {tagMatch.sampleValues.map(v => (
                  <span key={v} className="rounded bg-bg-tertiary/50 px-1.5 py-0.5 text-[10px] text-text-secondary">{v}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Row 3: Fallback + preview */}
      {acctTags.length > 0 && (
        <div className="grid grid-cols-[1fr_2fr] gap-4 items-start">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Fallback (account tag)</span>
            <select
              value={state.fallbackTag ?? ''}
              onChange={e => { setState(s => ({ ...s, fallbackTag: e.target.value.length > 0 ? e.target.value : undefined })); }}
              className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            >
              <option value="">No fallback</option>
              {acctTags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            {fallbackValues.length > 0 && (
              <>
                <span className="text-xs text-text-muted">{String(fallbackValues.length)} distinct values</span>
                <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                  {fallbackValues.map(([val, cnt]) => (
                    <span key={val} className="rounded bg-bg-tertiary/50 px-1.5 py-0.5 text-[10px] text-text-secondary">
                      {val} <span className="text-text-muted">({String(cnt)})</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Row 4: Fallback format + Alias rules side by side */}
      <div className="grid grid-cols-[1fr_2fr] gap-4 items-start">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Fallback format</span>
          <input
            type="text"
            value={state.missingValueTemplate}
            onChange={e => { setState(s => ({ ...s, missingValueTemplate: e.target.value })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary font-mono outline-none focus:border-accent"
            placeholder="{fallback}"
          />
          <span className="text-[10px] text-text-muted">
            {'{fallback}'} = account tag value
          </span>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Alias Rules (canonical: alias1, alias2)</span>
          <textarea
            value={state.aliases}
            onChange={e => { setState(s => ({ ...s, aliases: e.target.value })); }}
            rows={2}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-[11px] text-text-primary font-mono outline-none focus:border-accent resize-y"
            placeholder="production: prod, prd&#10;staging: stg, stage"
          />
        </label>
      </div>

      {/* Row 5: Merged + normalized preview of all values */}
      {(() => {
        // Collect values with source tracking
        const resourceVals = tagMatch !== undefined ? tagMatch.sampleValues : [];
        const accountVals = fallbackValues.map(([v]) => v);
        // Fallback format: {fallback} = raw account value, or custom like "unknown-{fallback}"
        const fallbackFormat = state.missingValueTemplate.length > 0 ? state.missingValueTemplate : '{fallback}';
        const isPassthrough = fallbackFormat === '{fallback}';

        // Generate formatted fallback values
        const templateVals: string[] = [];
        if (!isPassthrough && accountVals.length > 0) {
          if (fallbackFormat.includes('{fallback}')) {
            for (const acctVal of accountVals) {
              templateVals.push(fallbackFormat.replaceAll('{fallback}', acctVal));
            }
          } else {
            // Static string, no variable
            templateVals.push(fallbackFormat);
          }
        }

        const resourceSet = new Set(resourceVals);
        const templateSet = new Set(templateVals);
        // When format changes the value, show template vals instead of raw account vals
        const allRaw = isPassthrough
          ? [...new Set([...resourceVals, ...accountVals])]
          : [...new Set([...resourceVals, ...templateVals])];
        const accountSet = isPassthrough ? new Set(accountVals) : new Set<string>();
        if (allRaw.length === 0) return null;

        // Apply normalization
        const normalize = (v: string): string => {
          switch (state.normalize) {
            case 'lowercase': return v.toLowerCase();
            case 'uppercase': return v.toUpperCase();
            case 'lowercase-kebab': return v.replace(/([a-z])([A-Z])/g, '$1-$2').replaceAll('_', '-').replaceAll(' ', '-').toLowerCase();
            case 'lowercase-underscore': return v.replace(/([a-z])([A-Z])/g, '$1_$2').replaceAll('-', '_').replaceAll(' ', '_').toLowerCase();
            case 'camelCase': return v.replaceAll(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^(.)/, (_, c: string) => c.toLowerCase());
            default: return v;
          }
        };

        // Build alias reverse map
        const aliasMap = new Map<string, string>();
        const parsed = textToAliases(state.aliases);
        if (parsed !== undefined) {
          for (const [canonical, alts] of Object.entries(parsed)) {
            for (const alt of alts) {
              aliasMap.set(normalize(alt), canonical);
            }
          }
        }

        // Transform: normalize → alias resolve → track source
        type Source = 'resource' | 'account' | 'both' | 'template';
        const transformed = allRaw.map(raw => {
          const normalized = normalize(raw);
          const resolved = aliasMap.get(normalized) ?? normalized;
          const fromResource = resourceSet.has(raw);
          const fromAccount = accountSet.has(raw);
          const fromTemplate = templateSet.has(raw);
          let source: Source;
          if (fromTemplate) source = 'template';
          else if (fromResource && fromAccount) source = 'both';
          else if (fromResource) source = 'resource';
          else source = 'account';
          const aliased = aliasMap.has(normalized);
          return { raw, resolved, aliased, source };
        });

        const aliasPreviewCount = transformed.filter(t => t.aliased).length;

        // Deduplicate by resolved value, merge sources, sort alphabetically
        const resolvedMap = new Map<string, Source>();
        for (const t of transformed) {
          const existing = resolvedMap.get(t.resolved);
          if (existing === undefined) {
            resolvedMap.set(t.resolved, t.source);
          } else if (existing !== 'both' && existing !== t.source) {
            resolvedMap.set(t.resolved, 'both');
          }
        }
        const unique = [...resolvedMap.entries()]
          .map(([resolved, source]) => ({
            resolved,
            aliased: transformed.some(t => t.resolved === resolved && t.aliased),
            source,
          }))
          .sort((a, b) => a.resolved.localeCompare(b.resolved));

        return (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">
              Preview — {String(allRaw.length)} raw → {String(unique.length)} resolved
              {state.normalize.length > 0 ? ` (${state.normalize})` : ''}
              {aliasPreviewCount > 0 ? ` · ${String(aliasPreviewCount)} aliased` : ''}
            </span>
            <div className="flex items-center gap-3 text-[9px] text-text-muted mb-1">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-cyan-500/30 border border-cyan-500/50" /> resource</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-violet-500/30 border border-violet-500/50" /> account</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500/30 border border-emerald-500/50" /> both</span>
              {aliasPreviewCount > 0 && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-rose-500/30 border border-rose-500/50" /> aliased</span>}
              {!isPassthrough && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-warning/30 border border-warning/50" /> formatted</span>}
            </div>
            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
              {unique.map(({ resolved, aliased, source }) => {
                const colors = aliased
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : source === 'template'
                    ? 'bg-warning/10 border-warning/30 text-warning italic'
                    : source === 'both'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : source === 'account'
                        ? 'bg-violet-500/10 border-violet-500/30 text-violet-300'
                        : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300';
                return (
                <span
                  key={resolved}
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${colors}`}
                >
                  {resolved}
                </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => { onSave(state); }} className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors">
            Save
          </button>
          <button type="button" onClick={requestCancel} className="rounded-md px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary transition-colors">
            Cancel
          </button>
        </div>
        {onRemove !== undefined && (
          <button type="button" onClick={onRemove} className="rounded-md px-4 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted transition-colors">
            Remove Dimension
          </button>
        )}
      </div>
      {discardConfirm && (
        <ConfirmModal
          title="Discard unsaved changes?"
          message="You have edits that haven't been saved. Closing the editor will discard them."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => { setDiscardConfirm(false); onCancel(); }}
          onCancel={() => { setDiscardConfirm(false); }}
        />
      )}
    </div>
  );
}

export function DimensionsView() {
  const api = useCostApi();
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingBuiltInIdx, setEditingBuiltInIdx] = useState<number | null>(null);
  const [hiddenResourceCols, setHiddenResourceCols] = useState(new Set<string>());
  const [hiddenAccountCols, setHiddenAccountCols] = useState(new Set<string>());
  const [addingNew, setAddingNew] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Debug-panel expansion state. Collapsed by default — the two tag pivot
  // tables are exploratory, not primary content.
  const [resourceTagsExpanded, setResourceTagsExpanded] = useState(false);
  const [accountTagsExpanded, setAccountTagsExpanded] = useState(false);
  // Drag-to-reorder state. `armed` flips draggable=true on a row only after
  // the user mousedowns its grip handle, so clicks elsewhere don't accidentally
  // start a drag. `from`/`over` drive the visual feedback during the drag.
  const [armed, setArmed] = useState<DragRef | null>(null);
  const [dragFrom, setDragFrom] = useState<DragRef | null>(null);
  const [dragOver, setDragOver] = useState<DragRef | null>(null);
  // Lazy-load the tag-discovery scan — it hits DuckDB. Fires when the user
  // opens Add Dimension (needs unmapped-tag suggestions), expands Resource
  // Tags, or edits a tag dim (TagEditor needs context for suggestions).
  const needsTagDiscovery = addingNew || resourceTagsExpanded || editingIdx !== null;
  const tagsQuery = useQuery(
    () => needsTagDiscovery ? api.discoverTagKeys() : Promise.resolve(null),
    [needsTagDiscovery],
  );
  const configQuery = useQuery(() => api.getDimensionsConfig(), [refreshKey]);
  const orgQuery = useQuery(() => api.getOrgSyncResult(), []);

  const tagsResult = tagsQuery.status === 'success' ? tagsQuery.data : null;
  const discoveredTags = tagsResult?.tags ?? [];

  // Keep the last good config visible while a refetch is in flight — useQuery
  // resets to status=loading on every dep change, which would otherwise blank
  // the dimensions list for a frame after every reorder/toggle/save.
  const [config, setConfig] = useState<DimensionsConfig | null>(null);
  useEffect(() => {
    if (configQuery.status === 'success') setConfig(configQuery.data);
  }, [configQuery]);
  const orgData = orgQuery.status === 'success' ? orgQuery.data : null;

  // Account tag keys from org sync
  const accountTagKeys = orgData !== null
    ? [...new Set(orgData.accounts.flatMap(a => Object.keys(a.tags)))].sort()
    : [];

  // Which resource tags are already mapped as dimensions
  const mappedTagNames = new Set(config?.tags.map(t => t.tagName) ?? []);

  // CUR resource tags for the primary dropdown — same order as table, exclude hidden columns
  const unmappedTagKeys = discoveredTags
    .map(t => t.key)
    .filter(k => !mappedTagNames.has(k) && !hiddenResourceCols.has(k));

  function editingToTagDimension(editing: EditingTag): TagDimension {
    const base: { tagName: string; label: string } = { tagName: editing.tagName, label: editing.label };
    const concept = editing.concept.length > 0 ? editing.concept as ConceptType : undefined;
    const normalize = editing.normalize.length > 0 ? editing.normalize as NormalizationRule : undefined;
    const aliases = textToAliases(editing.aliases);
    const accountTagFallback = editing.fallbackTag !== undefined && editing.fallbackTag.length > 0 ? editing.fallbackTag : undefined;
    const missingValueTemplate = editing.missingValueTemplate.length > 0 ? editing.missingValueTemplate : undefined;
    return { ...base, concept, normalize, aliases, accountTagFallback, missingValueTemplate };
  }

  async function handleSaveTag(idx: number, editing: EditingTag) {
    if (config === null) return;
    const tags = [...config.tags];
    tags[idx] = editingToTagDimension(editing);
    await api.saveDimensionsConfig({ ...config, tags });
    setEditingIdx(null);
    setRefreshKey(k => k + 1);
  }

  async function handleAddTag(editing: EditingTag) {
    if (config === null) return;
    const newTag = editingToTagDimension(editing);
    await api.saveDimensionsConfig({ ...config, tags: [...config.tags, newTag] });
    setAddingNew(false);
    setRefreshKey(k => k + 1);
  }

  async function handleRemoveTag(idx: number) {
    if (config === null) return;
    const tags = config.tags.filter((_, i) => i !== idx);
    await api.saveDimensionsConfig({ ...config, tags });
    setEditingIdx(null);
    setRefreshKey(k => k + 1);
  }

  async function handleSaveBuiltIn(idx: number, edited: EditingBuiltIn) {
    if (config === null) return;
    const builtIn = config.builtIn.map((d, i) => {
      if (i !== idx) return d;
      const description = edited.description.trim();
      const normalize = edited.normalize.length > 0 ? edited.normalize as NormalizationRule : undefined;
      const aliases = textToAliases(edited.aliases);
      const nameStripPatterns = edited.nameStripPatterns
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
      return {
        name: d.name,
        label: edited.label.length > 0 ? edited.label : d.label,
        field: d.field,
        ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
        ...(d.enabled === false ? { enabled: false as const } : {}),
        ...(description.length > 0 ? { description } : {}),
        ...(normalize !== undefined ? { normalize } : {}),
        ...(aliases !== undefined ? { aliases } : {}),
        ...(edited.useOrgAccounts ? { useOrgAccounts: true as const } : {}),
        ...(nameStripPatterns.length > 0 ? { nameStripPatterns } : {}),
        // Only the Region dim surfaces a useRegionNames toggle — write it
        // explicitly (both true AND false) so toggling off sticks past the
        // mergeDefaultBuiltIns backfill that would otherwise re-enable it.
        ...(d.name === 'region' ? { useRegionNames: edited.useRegionNames } : {}),
      };
    });
    await api.saveDimensionsConfig({ ...config, builtIn });
    setEditingBuiltInIdx(null);
    setRefreshKey(k => k + 1);
  }

  // Optimistic save: paint the new config locally first, then persist in the
  // background. Skips the refetch — local state is already correct, and the
  // backend write is the source of truth for the next mount.
  function applyOptimistic(next: DimensionsConfig): void {
    setConfig(next);
    void api.saveDimensionsConfig(next);
  }

  function toggleBuiltInEnabled(idx: number): void {
    if (config === null) return;
    const builtIn = config.builtIn.map((d, i) => {
      if (i !== idx) return d;
      const nextEnabled = d.enabled === false ? undefined : false;
      const rest = { ...d };
      delete (rest as { enabled?: boolean }).enabled;
      return nextEnabled === undefined ? rest : { ...rest, enabled: nextEnabled };
    });
    applyOptimistic({ ...config, builtIn });
  }

  function toggleTagEnabled(idx: number): void {
    if (config === null) return;
    const tags = config.tags.map((t, i) => {
      if (i !== idx) return t;
      const nextEnabled = t.enabled === false ? undefined : false;
      const rest = { ...t };
      delete (rest as { enabled?: boolean }).enabled;
      return nextEnabled === undefined ? rest : { ...rest, enabled: nextEnabled };
    });
    applyOptimistic({ ...config, tags });
  }

  // Quick-add a discovered tag as a dimension
  const [quickAddState, setQuickAddState] = useState<EditingTag | null>(null);

  function applyReorder(type: DragGroup, fromIdx: number, toIdx: number): void {
    if (config === null || fromIdx === toIdx) return;
    if (type === 'builtIn') {
      const builtIn = [...config.builtIn];
      const moved = builtIn.splice(fromIdx, 1)[0];
      if (moved === undefined) return;
      builtIn.splice(toIdx, 0, moved);
      applyOptimistic({ ...config, builtIn });
    } else {
      const tags = [...config.tags];
      const moved = tags.splice(fromIdx, 1)[0];
      if (moved === undefined) return;
      tags.splice(toIdx, 0, moved);
      applyOptimistic({ ...config, tags });
    }
  }

  // Reorder only within the enabled subset: "move up" on an enabled item
  // hops past any disabled items above it to the next enabled neighbor.
  // Disabled items keep their relative positions, so re-enabling later
  // restores their order rather than bunching them at the bottom.
  function reorderWithinEnabled(type: DragGroup, fromFullIdx: number, direction: 'up' | 'down'): void {
    if (config === null) return;
    const arr: readonly { readonly enabled?: boolean | undefined }[] = type === 'builtIn' ? config.builtIn : config.tags;
    if (direction === 'up') {
      for (let i = fromFullIdx - 1; i >= 0; i--) {
        if (arr[i]?.enabled !== false) { applyReorder(type, fromFullIdx, i); return; }
      }
    } else {
      for (let i = fromFullIdx + 1; i < arr.length; i++) {
        if (arr[i]?.enabled !== false) { applyReorder(type, fromFullIdx, i); return; }
      }
    }
  }

  // One factory per row: returns the drag/drop attrs for the row container and
  // the mousedown attr for the grip handle. Centralizes the "only allow drag
  // when grip was pressed" + "only accept drop within the same group" rules so
  // the row JSX stays light.
  function dragProps(type: DragGroup, idx: number): { row: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean }; grip: React.HTMLAttributes<HTMLButtonElement> } {
    const isArmed = armed?.type === type && armed.idx === idx;
    const isFrom = dragFrom?.type === type && dragFrom.idx === idx;
    const isOver = dragOver?.type === type && dragOver.idx === idx && !isFrom;
    return {
      row: {
        draggable: isArmed,
        onDragStart: (e) => {
          setDragFrom({ type, idx });
          e.dataTransfer.effectAllowed = 'move';
          // Required for Firefox to actually start the drag.
          e.dataTransfer.setData('text/plain', `${type}:${String(idx)}`);
        },
        onDragEnd: () => { setArmed(null); setDragFrom(null); setDragOver(null); },
        onDragOver: (e) => {
          if (dragFrom?.type !== type) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver({ type, idx });
        },
        onDragLeave: () => { setDragOver(curr => (curr?.type === type && curr.idx === idx ? null : curr)); },
        onDrop: (e) => {
          e.preventDefault();
          if (dragFrom?.type === type) applyReorder(type, dragFrom.idx, idx);
          setArmed(null); setDragFrom(null); setDragOver(null);
        },
        style: isFrom ? { opacity: 0.4 } : isOver ? { boxShadow: 'inset 0 2px 0 var(--color-accent, #34d399)' } : undefined,
      },
      grip: {
        onMouseDown: () => { setArmed({ type, idx }); },
        onMouseUp: () => { setArmed(curr => (curr?.type === type && curr.idx === idx ? null : curr)); },
      },
    };
  }

  function GripHandle({ attrs }: { attrs: React.HTMLAttributes<HTMLButtonElement> }): React.JSX.Element {
    return (
      <button
        type="button"
        {...attrs}
        title="Drag to reorder"
        className="flex items-center justify-center text-text-muted hover:text-text-primary cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </button>
    );
  }

  function ReorderArrows({ type, idx }: { type: DragGroup; idx: number; direction?: string }): React.JSX.Element {
    // Disable the arrow when there's no enabled neighbor to swap with in
    // that direction — without this the user could click Up on the topmost
    // enabled item and nothing would visibly happen (the disabled items
    // above would silently shuffle instead).
    const arr: readonly { readonly enabled?: boolean | undefined }[] =
      config === null ? [] : type === 'builtIn' ? config.builtIn : config.tags;
    let canUp = false;
    for (let i = idx - 1; i >= 0; i--) {
      if (arr[i]?.enabled !== false) { canUp = true; break; }
    }
    let canDown = false;
    for (let i = idx + 1; i < arr.length; i++) {
      if (arr[i]?.enabled !== false) { canDown = true; break; }
    }
    return (
      <div className="flex flex-col -space-y-1">
        <button
          type="button"
          disabled={!canUp}
          onClick={(e) => { e.stopPropagation(); reorderWithinEnabled(type, idx, 'up'); }}
          title="Move up"
          className="flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          disabled={!canDown}
          onClick={(e) => { e.stopPropagation(); reorderWithinEnabled(type, idx, 'down'); }}
          title="Move down"
          className="flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  // Build enabled-dim rows with their original full-array indices preserved —
  // the reorder machinery operates on the full array, so we pair each visible
  // card with its index in config.builtIn / config.tags.
  const enabledBuiltIns = config === null ? [] : config.builtIn
    .map((d, idx) => ({ d, idx }))
    .filter(({ d }) => d.enabled !== false);
  const enabledTags = config === null ? [] : config.tags
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t.enabled !== false);

  function pillClass(enabled: boolean): string {
    return [
      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
      enabled
        ? 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/20'
        : 'border-border bg-bg-tertiary/20 text-text-muted hover:border-text-muted hover:text-text-secondary',
    ].join(' ');
  }

  return (
    <div className="flex flex-col gap-8 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Dimensions</h2>
        <p className="text-sm text-text-secondary mt-1">Map tags to cost allocation dimensions</p>
      </div>

      {/* SECTION 1 — Available dimensions as toggleable pills. Two rows: the
          fixed set of built-ins, then the user-defined tag dims with an
          inline + Add pill at the end. */}
      {config !== null && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider">Built-in dimensions</h3>
            <div className="flex flex-wrap gap-1.5">
              {config.builtIn.map((d, idx) => {
                const isOn = d.enabled !== false;
                return (
                  <button
                    key={d.name}
                    type="button"
                    onClick={() => { toggleBuiltInEnabled(idx); }}
                    title={isOn ? 'Click to disable' : 'Click to enable'}
                    className={pillClass(isOn)}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider">Custom tag dimensions</h3>
            <div className="flex flex-wrap gap-1.5">
              {config.tags.map((tag, idx) => {
                const isOn = tag.enabled !== false;
                return (
                  <button
                    key={tag.tagName}
                    type="button"
                    onClick={() => { toggleTagEnabled(idx); }}
                    title={isOn ? 'Click to disable' : 'Click to enable'}
                    className={pillClass(isOn)}
                  >
                    {tag.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => { setAddingNew(true); setEditingIdx(null); setEditingBuiltInIdx(null); setQuickAddState(null); }}
                className="rounded-full border border-dashed border-accent/50 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors"
              >
                + Add
              </button>
            </div>
          </div>

          {/* New-tag-dim form appears inline right after the pill rows so the
              user sees where the new pill will land. */}
          {addingNew && (
            <TagEditor
              tag={quickAddState ?? { tagName: '', label: '', concept: '', normalize: '', aliases: '', fallbackTag: undefined, missingValueTemplate: '' }}
              onSave={(edited) => { void handleAddTag(edited); }}
              onCancel={() => { setAddingNew(false); setQuickAddState(null); }}
              onRemove={undefined}
              availableTags={unmappedTagKeys}
              discoveredTags={discoveredTags}
              accountTagKeys={accountTagKeys}
              orgAccounts={orgData?.accounts ?? []}
            />
          )}
        </div>
      )}

      {/* SECTION 2 — The enabled dim list. Click to expand into the editor,
          reorder with arrows / drag-grip. Built-ins come first, then tags. */}
      {config !== null && (enabledBuiltIns.length > 0 || enabledTags.length > 0) && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-text-secondary">
            Enabled dimensions
            <span className="text-text-muted ml-2 font-normal text-xs">click to configure · drag or use arrows to reorder</span>
          </h3>

          {enabledBuiltIns.map(({ d, idx }) => {
            if (editingBuiltInIdx === idx) {
              return (
                <BuiltInEditor
                  key={d.name}
                  dim={{
                    name: d.name,
                    field: d.field,
                    editing: {
                      label: d.label,
                      description: d.description ?? '',
                      normalize: d.normalize ?? '',
                      aliases: aliasesToText(d.aliases),
                      useOrgAccounts: d.useOrgAccounts === true,
                      nameStripPatterns: d.nameStripPatterns?.join('\n') ?? '',
                      useRegionNames: d.useRegionNames === true,
                    },
                  }}
                  onSave={(edited) => { void handleSaveBuiltIn(idx, edited); }}
                  onCancel={() => { setEditingBuiltInIdx(null); }}
                />
              );
            }
            const dnd = dragProps('builtIn', idx);
            return (
              <div
                key={d.name}
                {...dnd.row}
                className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between hover:bg-bg-tertiary/30 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => { setEditingBuiltInIdx(idx); setEditingIdx(null); setAddingNew(false); }}
                  className="flex flex-col gap-1 text-left flex-1 min-w-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{d.label}</span>
                    <span className="text-xs text-text-muted font-mono">{d.field}</span>
                    {d.displayField !== undefined && (
                      <span className="text-[10px] text-text-muted">display: {d.displayField}</span>
                    )}
                    {d.normalize !== undefined && (
                      <span className="text-[10px] text-text-muted">{d.normalize}</span>
                    )}
                    {d.aliases !== undefined && (
                      <span className="text-[10px] text-text-muted">{String(Object.keys(d.aliases).length)} alias rules</span>
                    )}
                  </div>
                  {d.description !== undefined && d.description.length > 0 && (
                    <span className="text-[11px] text-text-muted leading-snug">{d.description}</span>
                  )}
                </button>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-text-muted uppercase tracking-wider">Built-in</span>
                  <ReorderArrows type="builtIn" idx={idx} direction="builtInEnabled" />
                  <GripHandle attrs={dnd.grip} />
                </div>
              </div>
            );
          })}

          {enabledTags.map(({ t: tag, idx }) => {
            const dnd = dragProps('tag', idx);
            if (editingIdx === idx) {
              return (
                <TagEditor
                  key={tag.tagName}
                  tag={{
                    tagName: tag.tagName,
                    label: tag.label,
                    concept: tag.concept ?? '',
                    normalize: tag.normalize ?? '',
                    aliases: aliasesToText(tag.aliases),
                    fallbackTag: tag.accountTagFallback,
                    missingValueTemplate: tag.missingValueTemplate ?? '',
                  }}
                  onSave={(edited) => { void handleSaveTag(idx, edited); }}
                  onCancel={() => { setEditingIdx(null); }}
                  onRemove={() => { void handleRemoveTag(idx); }}
                  availableTags={unmappedTagKeys}
                  discoveredTags={discoveredTags}
                  accountTagKeys={accountTagKeys}
                  orgAccounts={orgData?.accounts ?? []}
                />
              );
            }
            return (
              <div key={tag.tagName} {...dnd.row} className="w-full rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between hover:bg-bg-tertiary/30 transition-colors">
                <button
                  type="button"
                  onClick={() => { setEditingIdx(idx); setAddingNew(false); setEditingBuiltInIdx(null); }}
                  className="flex flex-col gap-1 text-left flex-1 min-w-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{tag.label}</span>
                    <span className="text-xs text-text-muted font-mono">tag:{tag.tagName}</span>
                    {tag.concept !== undefined && (
                      <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                        {tag.concept}
                      </span>
                    )}
                    {tag.normalize !== undefined && (
                      <span className="text-[10px] text-text-muted">{tag.normalize}</span>
                    )}
                    {tag.aliases !== undefined && (
                      <span className="text-[10px] text-text-muted">{String(Object.keys(tag.aliases).length)} alias rules</span>
                    )}
                    {tag.accountTagFallback !== undefined && (
                      <span className="text-[10px] text-text-muted">fallback: {tag.accountTagFallback}</span>
                    )}
                    {tag.missingValueTemplate !== undefined && (
                      <span className="text-[10px] text-text-muted font-mono">missing: {tag.missingValueTemplate}</span>
                    )}
                  </div>
                  {tag.description !== undefined && tag.description.length > 0 && (
                    <span className="text-[11px] text-text-muted leading-snug">{tag.description}</span>
                  )}
                </button>
                <div className="flex items-center gap-3 shrink-0">
                  <ReorderArrows type="tag" idx={idx} direction="tagEnabled" />
                  <GripHandle attrs={dnd.grip} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* SECTION 3 — Debug panels, collapsed by default. Firing the resource-
          tags DuckDB scan is expensive, so we only kick it off when the
          user expands this panel (or opens Add Dimension / the tag editor —
          both need the discovered-tag list for suggestions). */}
      {config !== null && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-text-secondary">Debug info</h3>

          <DebugPanel
            title="Resource Tags"
            subtitle={tagsQuery.status === 'success' && tagsQuery.data !== null ? `${String(tagsQuery.data.tags.length)} keys${tagsQuery.data.samplePeriod.length > 0 ? ` · sampled from ${tagsQuery.data.samplePeriod}` : ''}` : 'Tag keys discovered by scanning the latest CUR period'}
            expanded={resourceTagsExpanded}
            onToggle={() => { setResourceTagsExpanded(v => !v); }}
          >
            {tagsQuery.status === 'loading' && (
              <div className="rounded-xl border border-border bg-bg-secondary/50 p-8 text-center">
                <CoinRainLoader height={80} count={4} />
                <p className="text-xs text-text-muted mt-2">Scanning billing data for tags...</p>
              </div>
            )}
            {tagsQuery.status === 'error' && (
              <div className="rounded-xl border border-negative/50 bg-negative-muted p-4 text-sm text-negative">
                {tagsQuery.error.message}
              </div>
            )}
            {tagsQuery.status === 'success' && discoveredTags.length > 0 && (() => {
              const visibleTags = discoveredTags.filter(t => !hiddenResourceCols.has(t.key));
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {[...discoveredTags].sort((a, b) => {
                      const aHidden = hiddenResourceCols.has(a.key) ? 1 : 0;
                      const bHidden = hiddenResourceCols.has(b.key) ? 1 : 0;
                      return aHidden - bHidden;
                    }).map(t => {
                      const hidden = hiddenResourceCols.has(t.key);
                      return (
                        <button
                          key={t.key}
                          type="button"
                          onClick={() => { setHiddenResourceCols(prev => { const next = new Set(prev); if (hidden) { next.delete(t.key); } else { next.add(t.key); } return next; }); }}
                          className={[
                            'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                            hidden
                              ? 'border-border bg-bg-tertiary/20 text-text-muted line-through'
                              : 'border-accent/40 bg-accent/10 text-accent',
                          ].join(' ')}
                        >
                          {t.key}
                        </button>
                      );
                    })}
                  </div>
                  {visibleTags.length > 0 && (
                    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-auto max-h-96">
                      <table className="text-xs">
                        <thead>
                          <tr className="border-b border-border text-left text-text-muted sticky top-0 bg-bg-secondary z-10">
                            {visibleTags.map(t => (
                              <th key={t.key} className="px-3 py-2 font-medium whitespace-nowrap">
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-mono">{t.key}</span>
                                  <span className="text-[9px] text-text-muted font-normal">{String(t.coveragePct)}% · {String(t.distinctCount)} values</span>
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: Math.max(...visibleTags.map(t => t.sampleValues.length), 0) }, (_, rowIdx) => (
                            <tr key={rowIdx} className="border-b border-border-subtle">
                              {visibleTags.map(t => (
                                <td key={t.key} className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                                  {t.sampleValues[rowIdx] ?? ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}
          </DebugPanel>

          <DebugPanel
            title="Account Tags"
            subtitle={orgData !== null ? `${String(accountTagKeys.length)} keys · across ${String(orgData.accounts.length)} accounts` : 'Requires an AWS Organization sync'}
            expanded={accountTagsExpanded}
            onToggle={() => { setAccountTagsExpanded(v => !v); }}
          >
            {orgData === null ? (
              <p className="text-xs text-text-muted">No Organization sync data yet. Run it from Data Management to populate account-level tags.</p>
            ) : accountTagKeys.length === 0 ? (
              <p className="text-xs text-text-muted">No tags found on any accounts.</p>
            ) : (() => {
              const visibleKeys = accountTagKeys.filter(k => !hiddenAccountCols.has(k));
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {[...accountTagKeys].sort((a, b) => {
                      const aH = hiddenAccountCols.has(a) ? 1 : 0;
                      const bH = hiddenAccountCols.has(b) ? 1 : 0;
                      return aH - bH;
                    }).map(key => {
                      const hidden = hiddenAccountCols.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => { setHiddenAccountCols(prev => { const next = new Set(prev); if (hidden) { next.delete(key); } else { next.add(key); } return next; }); }}
                          className={[
                            'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                            hidden
                              ? 'border-border bg-bg-tertiary/20 text-text-muted line-through'
                              : 'border-accent/40 bg-accent/10 text-accent',
                          ].join(' ')}
                        >
                          {key}
                        </button>
                      );
                    })}
                  </div>
                  {visibleKeys.length > 0 && (
                    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-auto max-h-96">
                      <table className="text-xs">
                        <thead>
                          <tr className="border-b border-border text-left text-text-muted sticky top-0 bg-bg-secondary z-10">
                            {visibleKeys.map(key => {
                              const count = orgData.accounts.filter(a => a.tags[key] !== undefined && a.tags[key] !== '').length;
                              return (
                                <th key={key} className="px-3 py-2 font-medium whitespace-nowrap">
                                  <div className="flex flex-col gap-0.5">
                                    <span className="font-mono">{key}</span>
                                    <span className="text-[9px] text-text-muted font-normal">{String(count)}/{String(orgData.accounts.length)} accts</span>
                                  </div>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const columnValues = visibleKeys.map(key => {
                              const counts = new Map<string, number>();
                              for (const acct of orgData.accounts) {
                                const val = acct.tags[key];
                                if (val !== undefined && val.length > 0) {
                                  counts.set(val, (counts.get(val) ?? 0) + 1);
                                }
                              }
                              return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} (${String(c)})`);
                            });
                            const maxRows = Math.max(...columnValues.map(c => c.length), 0);
                            return Array.from({ length: Math.min(maxRows, 15) }, (_, rowIdx) => (
                              <tr key={rowIdx} className="border-b border-border-subtle">
                                {columnValues.map((vals, colIdx) => (
                                  <td key={visibleKeys[colIdx]} className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                                    {vals[rowIdx] ?? ''}
                                  </td>
                                ))}
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}
          </DebugPanel>
        </div>
      )}
    </div>
  );
}
