import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import type { BuiltInDimension, DimensionsConfig, TagDimension, ConceptType, NormalizationRule } from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';

// Core dimensions that cannot be disabled — they power the fallback chain and are always needed.
const LOCKED_DIMENSIONS = new Set([asDimensionId('service'), asDimensionId('service_family'), asDimensionId('usage_type')]);
import { useCostApi } from '../hooks/use-cost-api.js';
import { useUnsavedChanges } from '../hooks/use-unsaved-changes.js';
import { useQuery } from '../hooks/use-query.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { AliasSuggestions } from '../components/alias-suggestions.js';

function useClickOutsideDismiss(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onCancel: () => void,
  isDirty: boolean,
  discardConfirm: boolean,
  setDiscardConfirm: (v: boolean) => void,
): void {
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current === null) return;
      if (!(e.target instanceof Node)) return;
      if (containerRef.current.contains(e.target)) return;
      if (discardConfirm) return;
      if (isDirty) { setDiscardConfirm(true); }
      else { onCancel(); }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => { document.removeEventListener('mousedown', onDocClick); };
  }, [containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm]);
}

/** Drag/drop is now indexed by position in the unified `order` array,
 *  not by (type, index) into the split built-in/tag arrays. Keeps a single
 *  reorder space so a tag can be dropped above a built-in and vice-versa. */
interface DragRef { orderIdx: number }

function builtInKey(name: string): string { return `builtin:${name}`; }
function tagKey(tagName: string): string { return `tag:${tagName}`; }

function defaultOrder(config: DimensionsConfig): string[] {
  const keys: string[] = [];
  for (const d of config.builtIn) {
    if (d.enabled !== false) keys.push(builtInKey(d.name));
  }
  for (const t of config.tags) {
    if (t.enabled !== false) keys.push(tagKey(t.tagName));
  }
  return keys;
}

function collectValidKeys(config: DimensionsConfig): Set<string> {
  const valid = new Set<string>();
  for (const d of config.builtIn) {
    if (d.enabled !== false) valid.add(builtInKey(d.name));
  }
  for (const t of config.tags) {
    if (t.enabled !== false) valid.add(tagKey(t.tagName));
  }
  return valid;
}

function reconcileOrder(config: DimensionsConfig): string[] {
  const valid = collectValidKeys(config);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of config.order ?? defaultOrder(config)) {
    if (valid.has(key) && !seen.has(key)) { out.push(key); seen.add(key); }
  }
  for (const d of config.builtIn) {
    const k = builtInKey(d.name);
    if (d.enabled !== false && !seen.has(k)) { out.push(k); seen.add(k); }
  }
  for (const t of config.tags) {
    const k = tagKey(t.tagName);
    if (t.enabled !== false && !seen.has(k)) { out.push(k); seen.add(k); }
  }
  return out;
}

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
  /** Empty string = use the account's Name field. Non-empty = use this
   *  account-level tag from the AWS Org sync. */
  accountNameFromTag: string;
  nameStripPatterns: string;
  useRegionNames: boolean;
}

const TRANSFORM_FREE_FIELDS = new Set(['service', 'service_family']);

function buildDiscoverOptions(
  dim: { name: string; field: string },
  state: EditingBuiltIn,
  normalize: NormalizationRule | undefined,
  stripPatternList: string[],
): Record<string, unknown> {
  const isAccountDim = dim.field === 'account_id';
  const isAnyRegionDim = dim.field === 'region';
  return {
    ...(normalize === undefined ? {} : { normalize }),
    ...(isAccountDim ? {
      useOrgAccounts: true,
      nameStripPatterns: stripPatternList,
      ...(state.accountNameFromTag.length > 0 ? { accountNameFromTag: state.accountNameFromTag } : {}),
    } : {}),
    ...(isAnyRegionDim ? { dimName: dim.name, useRegionNames: state.useRegionNames } : {}),
  };
}

function computeEnrichmentWarnings(
  dim: { name: string; field: string },
  state: EditingBuiltIn,
  regionInfoQuery: { status: string; data?: { count: number; lastError: string | null } | null },
  orgQuery: { status: string; data?: unknown },
): { regionWarning: { kind: 'missing' | 'error'; message?: string } | null; accountWarning: boolean } {
  const isRegionDim = dim.name === 'region';
  const isRegionCountryDim = dim.name === 'region_country';
  const isRegionContinentDim = dim.name === 'region_continent';
  const isAccountDim = dim.field === 'account_id';

  const wantsRegionEnrichment = (isRegionDim && state.useRegionNames) || isRegionCountryDim || isRegionContinentDim;
  let regionWarning: { kind: 'missing' | 'error'; message?: string } | null = null;
  if (wantsRegionEnrichment && regionInfoQuery.status === 'success') {
    const regionInfo = regionInfoQuery.data ?? null;
    if (regionInfo === null || regionInfo.count === 0) regionWarning = { kind: 'missing' };
    else if (regionInfo.lastError !== null) regionWarning = { kind: 'error', message: regionInfo.lastError };
  }
  const accountWarning = isAccountDim && orgQuery.status === 'success' && orgQuery.data === null;
  return { regionWarning, accountWarning };
}

function BuiltInEditor({ dim, onSave, onCancel, accountTagKeys }: Readonly<{
  dim: { name: string; field: string; editing: EditingBuiltIn };
  onSave: (edited: EditingBuiltIn) => void;
  onCancel: () => void;
  accountTagKeys: readonly string[];
}>): React.JSX.Element {
  const isAccountDim = dim.field === 'account_id';
  const isRegionDim = dim.name === 'region';
  const isAnyRegionDim = dim.field === 'region';
  const showTransforms = !TRANSFORM_FREE_FIELDS.has(dim.field);
  const api = useCostApi();
  const [state, setState] = useState(dim.editing);
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
  useUnsavedChanges(isDirty, 'Dimension editor');
  function requestCancel(): void {
    if (isDirty) setDiscardConfirm(true);
    else onCancel();
  }
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripPatternList = state.nameStripPatterns
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  const stripPatternsKey = stripPatternList.join('\u0001');
  const normalize: NormalizationRule | undefined = state.normalize.length > 0 ? state.normalize as NormalizationRule : undefined;
  const discoverOptions = buildDiscoverOptions(dim, state, normalize, stripPatternList);
  const valuesQuery = useQuery(
    () => api.discoverColumnValues(dim.field, discoverOptions),
    [dim.field, dim.name, isAccountDim, isAnyRegionDim, state.useOrgAccounts, state.useRegionNames, state.accountNameFromTag, stripPatternsKey, normalize],
  );

  useClickOutsideDismiss(containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm);

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
  // Account-name source is always the AWS Org sync — the user picks between
  // the account's Name field and any account-level tag. When the tag key is
  // unknown (no sync data) we still let the user pre-select it from the
  // saved value, but the dropdown won't have suggestions.
  const nameSource: 'name' | 'tag' = state.accountNameFromTag.length > 0 ? 'tag' : 'name';
  const tagKeyOptions = state.accountNameFromTag.length > 0 && !accountTagKeys.includes(state.accountNameFromTag)
    ? [state.accountNameFromTag, ...accountTagKeys]
    : [...accountTagKeys];
  const nameSourceField = (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Name source (from org-sync)</span>
        <select
          value={nameSource}
          onChange={e => {
            const v = e.target.value;
            if (v === 'name') setState(s => ({ ...s, accountNameFromTag: '' }));
            else setState(s => ({ ...s, accountNameFromTag: s.accountNameFromTag.length > 0 ? s.accountNameFromTag : (accountTagKeys[0] ?? '') }));
          }}
          className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
        >
          <option value="name">Account Name</option>
          <option value="tag">Account Tag</option>
        </select>
      </label>
      {nameSource === 'tag' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Tag key</span>
          <select
            value={state.accountNameFromTag}
            onChange={e => { setState(s => ({ ...s, accountNameFromTag: e.target.value })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            {tagKeyOptions.length === 0 ? (
              <option value="">No account tags synced</option>
            ) : (
              <>
                {state.accountNameFromTag.length === 0 && <option value="">Select a tag...</option>}
                {tagKeyOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </>
            )}
          </select>
        </label>
      )}
    </div>
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

  const { regionWarning, accountWarning } = computeEnrichmentWarnings(dim, state, regionInfoQuery, orgQuery);

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
            Account names and tags come from the AWS Organization sync, which hasn't run yet —
            account values will display as raw 12-digit IDs. Run the sync from the <span className="font-medium">Sync</span> tab to populate.
          </p>
        </div>
      )}
      {showTransforms && (
        <div className="grid grid-cols-2 gap-4 items-stretch">
          {(() => { if (isAccountDim) { return nameSourceField; } if (isRegionDim) { return regionToggleField; } return <div />; })()}
          {normalizationField}
        </div>
      )}
      {showTransforms ? (
        <div className="grid grid-cols-2 gap-4">
          {isAccountDim ? stripPatternsField : <div />}
          {aliasField}
        </div>
      ) : aliasField}

      <AliasSuggestions
        dimensionId={dim.name}
        onAccepted={(canonical, aliases) => {
          setState(s => {
            const current = textToAliases(s.aliases) ?? {};
            const existing: readonly string[] = current[canonical] ?? [];
            const merged = [...new Set([...existing, ...aliases])];
            const updated = { ...current, [canonical]: merged };
            return { ...s, aliases: aliasesToText(updated) };
          });
        }}
      />

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

function DimensionToggle({ enabled, onToggle }: Readonly<{ enabled: boolean; onToggle: () => void }>): React.JSX.Element {
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

function sortAliasText(text: string): string {
  if (text.trim().length === 0) return text;
  const entries: { key: string; aliases: readonly string[] }[] = [];
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    const vals = line.slice(idx + 1).split(',').map(s => s.trim()).filter(s => s.length > 0);
    entries.push({ key, aliases: vals });
  }
  if (entries.length === 0) return text;
  return entries
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(e => e.aliases.length > 0
      ? `${e.key}: ${[...e.aliases].sort((a, b) => a.localeCompare(b)).join(', ')}`
      : `${e.key}:`)
    .join('\n');
}

function AliasRulesEditor({ value, savedValue, activeLine, onChange, onLineFocus }: Readonly<{
  value: string;
  savedValue: string;
  activeLine: number | null;
  onChange: (v: string) => void;
  onLineFocus: (lineIdx: number | null) => void;
}>): React.JSX.Element {
  const newLineRef = useRef<HTMLInputElement>(null);
  const sorted = sortAliasText(value);
  const savedLines = new Set(sortAliasText(savedValue).split('\n').filter(l => l.trim().length > 0));
  const lines = sorted.split('\n').filter(l => l.trim().length > 0);

  return (
    <div className="rounded border border-border bg-bg-primary overflow-hidden">
      {lines.map((line, i) => {
        const isNew = !savedLines.has(line);
        const isActive = activeLine === i;
        return (
          <div
            key={i}
            className={`flex items-center gap-1 px-3 py-1 text-[11px] font-mono border-l-2 ${isActive ? 'border-l-accent bg-accent/10' : isNew ? 'border-l-warning bg-warning/5' : 'border-l-transparent'} ${i > 0 ? 'border-t border-t-border/30' : ''}`}
          >
            <input
              type="text"
              value={line}
              onFocus={() => { onLineFocus(i); }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onLineFocus(null);
                  newLineRef.current?.focus();
                }
              }}
              onChange={e => {
                const newLines = [...lines];
                newLines[i] = e.target.value;
                onChange(newLines.join('\n'));
              }}
              className="flex-1 bg-transparent text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onChange(lines.filter((_, j) => j !== i).join('\n'));
              }}
              className="text-text-muted hover:text-negative text-xs px-1 opacity-0 hover:opacity-100 transition-opacity"
              aria-label="Remove rule"
            >
              ×
            </button>
          </div>
        );
      })}
      <div className={`px-3 py-1 ${lines.length > 0 ? 'border-t border-t-border/30' : ''}`}>
        <input
          ref={newLineRef}
          type="text"
          placeholder="new-canonical: alias1, alias2"
          className="w-full bg-transparent text-[11px] font-mono text-text-primary outline-none placeholder:text-text-muted/50"
          onFocus={() => { onLineFocus(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const input = e.currentTarget;
              const v = input.value.trim();
              if (v.length > 0) {
                const base = value.trimEnd();
                onChange(base.length > 0 ? base + '\n' + v : v);
                input.value = '';
              }
              e.preventDefault();
            }
          }}
        />
      </div>
    </div>
  );
}

function validateAliases(text: string): string[] {
  const aliases = textToAliases(text);
  if (aliases === undefined) return [];
  const warnings: string[] = [];
  const allAliasValues = new Map<string, string>();
  for (const [canonical, alts] of Object.entries(aliases)) {
    for (const a of alts) {
      allAliasValues.set(a, canonical);
    }
  }
  for (const canonical of Object.keys(aliases)) {
    const mappedTo = allAliasValues.get(canonical);
    if (mappedTo !== undefined) {
      warnings.push(`"${canonical}" is a canonical key but also an alias of "${mappedTo}"`);
    }
  }
  return warnings;
}

type TagSource = 'resource' | 'account' | 'both' | 'template';

function sourceColor(source: TagSource, aliased: boolean): string {
  if (aliased) return 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300';
  switch (source) {
    case 'template': return 'bg-warning/10 border-warning/30 text-warning italic';
    case 'both': return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300';
    case 'account': return 'bg-violet-500/10 border-violet-500/30 text-violet-700 dark:text-violet-300';
    case 'resource': return 'bg-cyan-500/10 border-cyan-500/30 text-cyan-700 dark:text-cyan-300';
  }
}

function applyPreviewNormalize(v: string, rule: string): string {
  switch (rule) {
    case 'lowercase': return v.toLowerCase();
    case 'uppercase': return v.toUpperCase();
    case 'lowercase-kebab': return v.replaceAll(/([a-z])([A-Z])/g, '$1-$2').replaceAll('_', '-').replaceAll(' ', '-').toLowerCase();
    case 'lowercase-underscore': return v.replaceAll(/([a-z])([A-Z])/g, '$1_$2').replaceAll('-', '_').replaceAll(' ', '_').toLowerCase();
    case 'camelCase': return v.replaceAll(/[-_\s]+([^-_\s])/g, (_, c: string) => c.toUpperCase()).replace(/^(.)/, (_, c: string) => c.toLowerCase());
    default: return v;
  }
}

function buildTemplateVals(fallbackFormat: string, accountVals: string[]): string[] {
  if (fallbackFormat === '{fallback}' || accountVals.length === 0) return [];
  if (fallbackFormat.includes('{fallback}')) {
    return accountVals.map(v => fallbackFormat.replaceAll('{fallback}', v));
  }
  return [fallbackFormat];
}

function buildAliasMap(aliasText: string, normalizeRule: string): Map<string, string> {
  const aliasMap = new Map<string, string>();
  const parsed = textToAliases(aliasText);
  if (parsed === undefined) return aliasMap;
  for (const [canonical, alts] of Object.entries(parsed)) {
    for (const alt of alts) aliasMap.set(applyPreviewNormalize(alt, normalizeRule), canonical);
  }
  return aliasMap;
}

function classifySource(
  raw: string,
  resourceSet: ReadonlySet<string>,
  accountSet: ReadonlySet<string>,
  templateSet: ReadonlySet<string>,
): TagSource {
  if (templateSet.has(raw)) return 'template';
  if (resourceSet.has(raw) && accountSet.has(raw)) return 'both';
  if (resourceSet.has(raw)) return 'resource';
  return 'account';
}

function deduplicateResolved(
  transformed: readonly { resolved: string; aliased: boolean; source: TagSource }[],
): { resolved: string; aliased: boolean; source: TagSource }[] {
  const resolvedMap = new Map<string, TagSource>();
  for (const t of transformed) {
    const existing = resolvedMap.get(t.resolved);
    if (existing === undefined) resolvedMap.set(t.resolved, t.source);
    else if (existing !== 'both' && existing !== t.source) resolvedMap.set(t.resolved, 'both');
  }
  return [...resolvedMap.entries()]
    .map(([resolved, source]) => ({
      resolved,
      aliased: transformed.some(t => t.resolved === resolved && t.aliased),
      source,
    }))
    .sort((a, b) => a.resolved.localeCompare(b.resolved));
}

function TagValuePreview({ tagMatch, fallbackValues, missingValueTemplate, normalizeRule, aliasText, onBadgeClick }: Readonly<{
  tagMatch: { sampleValues: string[] } | undefined;
  fallbackValues: [string, number][];
  missingValueTemplate: string;
  normalizeRule: string;
  aliasText: string;
  onBadgeClick?: (value: string) => void;
}>): React.JSX.Element | null {
  const resourceVals = tagMatch === undefined ? [] : tagMatch.sampleValues;
  const accountVals = fallbackValues.map(([v]) => v);
  const fallbackFormat = missingValueTemplate.length > 0 ? missingValueTemplate : '{fallback}';
  const isPassthrough = fallbackFormat === '{fallback}';

  const templateVals = buildTemplateVals(fallbackFormat, accountVals);

  const resourceSet = new Set(resourceVals);
  const templateSet = new Set(templateVals);
  const allRaw = isPassthrough
    ? [...new Set([...resourceVals, ...accountVals])]
    : [...new Set([...resourceVals, ...templateVals])];
  const accountSet = isPassthrough ? new Set(accountVals) : new Set<string>();
  if (allRaw.length === 0) return null;

  const aliasMap = buildAliasMap(aliasText, normalizeRule);

  const transformed = allRaw.map(raw => {
    const normalized = applyPreviewNormalize(raw, normalizeRule);
    const resolved = aliasMap.get(normalized) ?? normalized;
    const source = classifySource(raw, resourceSet, accountSet, templateSet);
    return { raw, resolved, aliased: aliasMap.has(normalized), source };
  });

  const aliasPreviewCount = transformed.filter(t => t.aliased).length;
  const unique = deduplicateResolved(transformed);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">
        Preview — {String(allRaw.length)} raw → {String(unique.length)} resolved
        {normalizeRule.length > 0 ? ` (${normalizeRule})` : ''}
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
        {unique.map(({ resolved, aliased, source }) => (
          <button
            type="button"
            key={resolved}
            onClick={onBadgeClick !== undefined ? () => { onBadgeClick(resolved); } : undefined}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${sourceColor(source, aliased)} ${onBadgeClick !== undefined ? 'cursor-pointer hover:ring-1 hover:ring-accent/50' : ''}`}
          >
            {resolved}
          </button>
        ))}
      </div>
    </div>
  );
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
  const [activeAliasLine, setActiveAliasLine] = useState<number | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const isDirty = JSON.stringify(state) !== JSON.stringify(initialRef.current);
  useUnsavedChanges(isDirty, 'Tag editor');
  function requestCancel(): void {
    if (isDirty) setDiscardConfirm(true);
    else onCancel();
  }
  const containerRef = useRef<HTMLDivElement | null>(null);

  useClickOutsideDismiss(containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm);

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

      {/* Row 2: Tag Name + Fallback + Fallback format */}
      <div className={`grid ${acctTags.length > 0 ? 'grid-cols-3' : 'grid-cols-1'} gap-4`}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Resource Tag</span>
          <select
            value={state.tagName}
            onChange={e => {
              const name = e.target.value;
              const label = name
                .replace(/^user_/i, '')
                .replaceAll('_', ' ')
                .replaceAll('-', ' ')
                .replaceAll(/\b\w/g, c => c.toUpperCase());
              setState(s => ({ ...s, tagName: name, label: s.label.length === 0 ? label : s.label }));
            }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">Select a tag...</option>
            {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {tagMatch !== undefined && (
            <span className="text-[10px] text-text-muted">{String(tagMatch.coveragePct)}% coverage · {String(tagMatch.distinctCount)} distinct values</span>
          )}
        </label>
        {acctTags.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Fallback (account tag)</span>
            <select
              value={state.fallbackTag ?? ''}
              onChange={e => { setState(s => ({ ...s, fallbackTag: e.target.value.length > 0 ? e.target.value : undefined })); }}
              className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            >
              <option value="">No fallback</option>
              {acctTags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {fallbackValues.length > 0 && (
              <span className="text-[10px] text-text-muted">{String(fallbackValues.length)} distinct values</span>
            )}
          </label>
        )}
        {acctTags.length > 0 && (
          <label className="flex flex-col gap-1">
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
          </label>
        )}
      </div>

      {/* Alias rules */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Alias Rules (canonical: alias1, alias2)</span>
        <AliasRulesEditor
          value={state.aliases}
          savedValue={initialRef.current.aliases}
          activeLine={activeAliasLine}
          onChange={(v) => { setState(s => ({ ...s, aliases: v })); }}
          onLineFocus={setActiveAliasLine}
        />
        {validateAliases(state.aliases).map(w => (
          <span key={w} className="text-[10px] text-warning">{w}</span>
        ))}
      </div>

      {state.tagName.length > 0 && (
        <AliasSuggestions
          dimensionId={state.tagName}
          onAccepted={(canonical, aliases) => {
            setState(s => {
              const current = textToAliases(s.aliases) ?? {};
              const existing: readonly string[] = current[canonical] ?? [];
              const merged = [...new Set([...existing, ...aliases])];
              const updated = { ...current, [canonical]: merged };
              return { ...s, aliases: aliasesToText(updated) };
            });
          }}
        />
      )}

      {/* Row 5: Merged + normalized preview of all values */}
      <TagValuePreview
        tagMatch={tagMatch}
        fallbackValues={fallbackValues}
        missingValueTemplate={state.missingValueTemplate}
        normalizeRule={state.normalize}
        aliasText={state.aliases}
        onBadgeClick={(value) => {
          setState(s => {
            const lines = sortAliasText(s.aliases).split('\n').filter(l => l.trim().length > 0);

            // If clicked value is already a canonical key, just focus that line
            const existingIdx = lines.findIndex(l => {
              const colonIdx = l.indexOf(':');
              return colonIdx >= 0 && l.slice(0, colonIdx).trim() === value;
            });
            if (existingIdx >= 0) {
              setActiveAliasLine(existingIdx);
              return s;
            }

            if (activeAliasLine !== null && activeAliasLine < lines.length) {
              const line = lines[activeAliasLine] ?? '';
              if (line.includes(':')) {
                const trimmed = line.trimEnd();
                const sep = trimmed.endsWith(':') ? ' ' : ', ';
                lines[activeAliasLine] = trimmed + sep + value;
                return { ...s, aliases: lines.join('\n') };
              }
            }
            const base = s.aliases.trimEnd();
            const prefix = base.length > 0 ? base + '\n' : '';
            const newAliases = prefix + value + ':';
            const sorted = sortAliasText(newAliases).split('\n').filter(l => l.trim().length > 0);
            const newIdx = sorted.findIndex(l => l.startsWith(value + ':'));
            if (newIdx >= 0) setActiveAliasLine(newIdx);
            return { ...s, aliases: newAliases };
          });
        }}
      />

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

function ToggleButton({ itemKey, hidden, onToggle }: Readonly<{ itemKey: string; hidden: boolean; onToggle: () => void }>): React.JSX.Element {
  return (
    <button
      key={itemKey}
      type="button"
      onClick={onToggle}
      className={[
        'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
        hidden
          ? 'border-border bg-bg-tertiary/20 text-text-muted line-through'
          : 'border-accent/40 bg-accent/10 text-accent',
      ].join(' ')}
    >
      {itemKey}
    </button>
  );
}

type DiscoveredTag = { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number };

function ResourceTagsContent({ tagsQuery, discoveredTags, hiddenResourceCols, setHiddenResourceCols }: Readonly<{
  tagsQuery: { status: string; data?: unknown; error?: Error };
  discoveredTags: readonly DiscoveredTag[];
  hiddenResourceCols: Set<string>;
  setHiddenResourceCols: React.Dispatch<React.SetStateAction<Set<string>>>;
}>): React.JSX.Element | null {
  if (tagsQuery.status === 'loading') {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary/50 p-8 text-center">
        <CoinRainLoader height={80} count={4} />
        <p className="text-xs text-text-muted mt-2">Scanning billing data for tags...</p>
      </div>
    );
  }
  if (tagsQuery.status === 'error' && tagsQuery.error !== undefined) {
    return (
      <div className="rounded-xl border border-negative/50 bg-negative-muted p-4 text-sm text-negative">
        {tagsQuery.error.message}
      </div>
    );
  }
  if (tagsQuery.status !== 'success' || discoveredTags.length === 0) return null;

  const visibleTags = discoveredTags.filter(t => !hiddenResourceCols.has(t.key));
  const toggleCol = (key: string) => {
    setHiddenResourceCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {[...discoveredTags].sort((a, b) => {
          const aH = hiddenResourceCols.has(a.key) ? 1 : 0;
          const bH = hiddenResourceCols.has(b.key) ? 1 : 0;
          return aH - bH;
        }).map(t => (
          <ToggleButton key={t.key} itemKey={t.key} hidden={hiddenResourceCols.has(t.key)} onToggle={() => { toggleCol(t.key); }} />
        ))}
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
}

function computeAccountColumnValues(
  accounts: readonly { tags: Readonly<Record<string, string>> }[],
  visibleKeys: string[],
): string[][] {
  return visibleKeys.map(key => {
    const counts = new Map<string, number>();
    for (const acct of accounts) {
      const val = acct.tags[key];
      if (val !== undefined && val.length > 0) {
        counts.set(val, (counts.get(val) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} (${String(c)})`);
  });
}

function AccountTagsContent({ orgData, accountTagKeys, hiddenAccountCols, setHiddenAccountCols }: Readonly<{
  orgData: { accounts: readonly { tags: Readonly<Record<string, string>> }[] } | null;
  accountTagKeys: string[];
  hiddenAccountCols: Set<string>;
  setHiddenAccountCols: React.Dispatch<React.SetStateAction<Set<string>>>;
}>): React.JSX.Element {
  if (orgData === null) {
    return <p className="text-xs text-text-muted">No Organization sync data yet. Run it from Data Management to populate account-level tags.</p>;
  }
  if (accountTagKeys.length === 0) {
    return <p className="text-xs text-text-muted">No tags found on any accounts.</p>;
  }

  const visibleKeys = accountTagKeys.filter(k => !hiddenAccountCols.has(k));
  const toggleCol = (key: string) => {
    setHiddenAccountCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const columnValues = visibleKeys.length > 0 ? computeAccountColumnValues(orgData.accounts, visibleKeys) : [];
  const maxRows = Math.max(...columnValues.map(c => c.length), 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {[...accountTagKeys].sort((a, b) => {
          const aH = hiddenAccountCols.has(a) ? 1 : 0;
          const bH = hiddenAccountCols.has(b) ? 1 : 0;
          return aH - bH;
        }).map(key => (
          <ToggleButton key={key} itemKey={key} hidden={hiddenAccountCols.has(key)} onToggle={() => { toggleCol(key); }} />
        ))}
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
              {Array.from({ length: Math.min(maxRows, 15) }, (_, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border-subtle">
                  {columnValues.map((vals, colIdx) => (
                    <td key={visibleKeys[colIdx]} className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                      {vals[rowIdx] ?? ''}
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
}

function pillClass(enabled: boolean): string {
  return [
    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
    enabled
      ? 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/20'
      : 'border-border bg-bg-tertiary/20 text-text-muted hover:border-text-muted hover:text-text-secondary',
  ].join(' ');
}

function GripHandle({ attrs }: Readonly<{ attrs: React.HTMLAttributes<HTMLButtonElement> }>): React.JSX.Element {
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

type OrderedRow =
  | { kind: 'builtIn'; key: string; idx: number; dim: BuiltInDimension }
  | { kind: 'tag'; key: string; idx: number; dim: TagDimension };

function resolveOrderedRow(key: string, config: DimensionsConfig): OrderedRow | null {
  if (key.startsWith('builtin:')) {
    const name = key.slice('builtin:'.length);
    const idx = config.builtIn.findIndex(d => d.name === name);
    const dim = idx >= 0 ? config.builtIn[idx] : undefined;
    if (dim !== undefined) return { kind: 'builtIn', key, idx, dim };
  } else if (key.startsWith('tag:')) {
    const tagName = key.slice('tag:'.length);
    const idx = config.tags.findIndex(t => t.tagName === tagName);
    const dim = idx >= 0 ? config.tags[idx] : undefined;
    if (dim !== undefined) return { kind: 'tag', key, idx, dim };
  }
  return null;
}

function resolveOrderedRows(config: DimensionsConfig): OrderedRow[] {
  const rows: OrderedRow[] = [];
  for (const key of reconcileOrder(config)) {
    const row = resolveOrderedRow(key, config);
    if (row !== null) rows.push(row);
  }
  return rows;
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
  const accountTagKeys = orgData === null
    ? []
    : [...new Set(orgData.accounts.flatMap(a => Object.keys(a.tags)))].sort((a, b) => a.localeCompare(b));

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
    const next = { ...config, tags, order: reconcileOrder({ ...config, tags }) };
    await api.saveDimensionsConfig(next);
    setEditingIdx(null);
    setRefreshKey(k => k + 1);
  }

  async function handleAddTag(editing: EditingTag) {
    if (config === null) return;
    const newTag = editingToTagDimension(editing);
    const tags = [...config.tags, newTag];
    const next = { ...config, tags, order: reconcileOrder({ ...config, tags }) };
    await api.saveDimensionsConfig(next);
    setAddingNew(false);
    setRefreshKey(k => k + 1);
  }

  async function handleRemoveTag(idx: number) {
    if (config === null) return;
    const tags = config.tags.filter((_, i) => i !== idx);
    const next = { ...config, tags, order: reconcileOrder({ ...config, tags }) };
    await api.saveDimensionsConfig(next);
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
        ...(normalize === undefined ? {} : { normalize }),
        ...(aliases === undefined ? {} : { aliases }),
        // The account dim's picker always implies org-sync (both sources come
        // from it); force useOrgAccounts=true so legacy configs that had it
        // off get migrated the first time the dim is saved.
        ...((d.field === 'account_id' || edited.useOrgAccounts) ? { useOrgAccounts: true as const } : {}),
        ...(edited.accountNameFromTag.length > 0 ? { accountNameFromTag: edited.accountNameFromTag } : {}),
        ...(nameStripPatterns.length > 0 ? { nameStripPatterns } : {}),
        // Only the Region dim surfaces a useRegionNames toggle — write it
        // explicitly (both true AND false) so toggling off sticks past the
        // mergeDefaultBuiltIns backfill that would otherwise re-enable it.
        ...(d.name === 'region' ? { useRegionNames: edited.useRegionNames } : {}),
      };
    });
    const next = { ...config, builtIn, order: reconcileOrder({ ...config, builtIn }) };
    await api.saveDimensionsConfig(next);
    setEditingBuiltInIdx(null);
    setRefreshKey(k => k + 1);
  }

  // Optimistic save: paint the new config locally first, then persist in the
  // background. Always writes a reconciled `order` so the YAML is in sync
  // with the visible list (entries for disabled dims are dropped; newly-
  // enabled dims are appended).
  function applyOptimistic(next: DimensionsConfig): void {
    const reconciled = { ...next, order: reconcileOrder(next) };
    setConfig(reconciled);
    api.saveDimensionsConfig(reconciled).catch(() => undefined);
  }

  function toggleBuiltInEnabled(idx: number): void {
    if (config === null) return;
    const builtIn = config.builtIn.map((d, i) => {
      if (i !== idx || LOCKED_DIMENSIONS.has(d.name)) return d;
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

  /** Reorder the unified `order` array: move the entry at fromIdx to toIdx. */
  function applyReorder(fromIdx: number, toIdx: number): void {
    if (config === null || fromIdx === toIdx) return;
    const order = [...reconcileOrder(config)];
    const moved = order.splice(fromIdx, 1)[0];
    if (moved === undefined) return;
    order.splice(toIdx, 0, moved);
    applyOptimistic({ ...config, order });
  }

  /** Drag/drop attrs for a row. Single unified-order index — no separate
   *  built-in vs tag spaces, so any card can be dropped on any other. */
  function dragProps(orderIdx: number): { row: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean }; grip: React.HTMLAttributes<HTMLButtonElement> } {
    const isArmed = armed?.orderIdx === orderIdx;
    const isFrom = dragFrom?.orderIdx === orderIdx;
    const isOver = dragOver?.orderIdx === orderIdx && !isFrom;
    return {
      row: {
        draggable: isArmed,
        onDragStart: (e) => {
          setDragFrom({ orderIdx });
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(orderIdx));
        },
        onDragEnd: () => { setArmed(null); setDragFrom(null); setDragOver(null); },
        onDragOver: (e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver({ orderIdx });
        },
        onDragLeave: () => { setDragOver(curr => (curr?.orderIdx === orderIdx ? null : curr)); },
        onDrop: (e) => {
          e.preventDefault();
          if (dragFrom !== null) applyReorder(dragFrom.orderIdx, orderIdx);
          setArmed(null); setDragFrom(null); setDragOver(null);
        },
        style: (() => {
          if (isFrom) return { opacity: 0.4 };
          if (isOver) return { boxShadow: 'inset 0 2px 0 var(--color-accent, #34d399)' };
          return undefined;
        })(),
      },
      grip: {
        onMouseDown: () => { setArmed({ orderIdx }); },
        onMouseUp: () => { setArmed(curr => (curr?.orderIdx === orderIdx ? null : curr)); },
      },
    };
  }

  function renderReorderArrows(orderIdx: number, total: number): React.JSX.Element {
    const canUp = orderIdx > 0;
    const canDown = orderIdx < total - 1;
    return (
      <div className="flex flex-col -space-y-1">
        <button
          type="button"
          disabled={!canUp}
          onClick={(e) => { e.stopPropagation(); applyReorder(orderIdx, orderIdx - 1); }}
          title="Move up"
          className="flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          disabled={!canDown}
          onClick={(e) => { e.stopPropagation(); applyReorder(orderIdx, orderIdx + 1); }}
          title="Move down"
          className="flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  const orderedRows = config === null ? [] : resolveOrderedRows(config);



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
                const locked = LOCKED_DIMENSIONS.has(d.name);
                const isOn = locked || d.enabled !== false;
                return (
                  <button
                    key={d.name}
                    type="button"
                    onClick={locked ? undefined : () => { toggleBuiltInEnabled(idx); }}
                    title={locked ? 'Always enabled' : isOn ? 'Click to disable' : 'Click to enable'}
                    className={`${pillClass(isOn)}${locked ? ' cursor-default opacity-80' : ''}`}
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
              onSave={(edited) => { handleAddTag(edited).catch(() => undefined); }}
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

      {/* SECTION 2 — Unified enabled-dim list. Built-ins and tag dims live
          in the same ordered list so the user can interleave them freely
          (drag, arrows, or the + Add pill above). Each row clicks open to
          its type-specific editor. */}
      {config !== null && orderedRows.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-text-secondary">
            {'Enabled dimensions '}
            <span className="text-text-muted ml-2 font-normal text-xs">click to configure · drag or use arrows to reorder</span>
          </h3>

          {orderedRows.map((row, orderIdx) => {
            const dnd = dragProps(orderIdx);
            const arrows = renderReorderArrows(orderIdx, orderedRows.length);

            if (row.kind === 'builtIn') {
              const d = row.dim;
              if (editingBuiltInIdx === row.idx) {
                return (
                  <BuiltInEditor
                    key={row.key}
                    dim={{
                      name: d.name,
                      field: d.field,
                      editing: {
                        label: d.label,
                        description: d.description ?? '',
                        normalize: d.normalize ?? '',
                        aliases: aliasesToText(d.aliases),
                        useOrgAccounts: d.useOrgAccounts === true,
                        accountNameFromTag: d.accountNameFromTag ?? '',
                        nameStripPatterns: d.nameStripPatterns?.join('\n') ?? '',
                        useRegionNames: d.useRegionNames === true,
                      },
                    }}
                    onSave={(edited) => { handleSaveBuiltIn(row.idx, edited).catch(() => undefined); }}
                    onCancel={() => { setEditingBuiltInIdx(null); }}
                    accountTagKeys={accountTagKeys}
                  />
                );
              }
              return (
                <div
                  key={row.key}
                  {...dnd.row}
                  className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between hover:bg-bg-tertiary/30 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => { setEditingBuiltInIdx(row.idx); setEditingIdx(null); setAddingNew(false); }}
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
                    {arrows}
                    <GripHandle attrs={dnd.grip} />
                  </div>
                </div>
              );
            }

            const tag = row.dim;
            if (editingIdx === row.idx) {
              return (
                <TagEditor
                  key={row.key}
                  tag={{
                    tagName: tag.tagName,
                    label: tag.label,
                    concept: tag.concept ?? '',
                    normalize: tag.normalize ?? '',
                    aliases: aliasesToText(tag.aliases),
                    fallbackTag: tag.accountTagFallback,
                    missingValueTemplate: tag.missingValueTemplate ?? '',
                  }}
                  onSave={(edited) => { handleSaveTag(row.idx, edited).catch(() => undefined); }}
                  onCancel={() => { setEditingIdx(null); }}
                  onRemove={() => { handleRemoveTag(row.idx).catch(() => undefined); }}
                  availableTags={unmappedTagKeys}
                  discoveredTags={discoveredTags}
                  accountTagKeys={accountTagKeys}
                  orgAccounts={orgData?.accounts ?? []}
                />
              );
            }
            return (
              <div key={row.key} {...dnd.row} className="w-full rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between hover:bg-bg-tertiary/30 transition-colors">
                <button
                  type="button"
                  onClick={() => { setEditingIdx(row.idx); setAddingNew(false); setEditingBuiltInIdx(null); }}
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
                  {arrows}
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
            subtitle={(() => {
              if (tagsQuery.status !== 'success' || tagsQuery.data === null) return 'Tag keys discovered by scanning the latest CUR period';
              const suffix = tagsQuery.data.samplePeriod.length > 0 ? ` · sampled from ${tagsQuery.data.samplePeriod}` : '';
              return `${String(tagsQuery.data.tags.length)} keys${suffix}`;
            })()}
            expanded={resourceTagsExpanded}
            onToggle={() => { setResourceTagsExpanded(v => !v); }}
          >
            <ResourceTagsContent
              tagsQuery={tagsQuery}
              discoveredTags={discoveredTags}
              hiddenResourceCols={hiddenResourceCols}
              setHiddenResourceCols={setHiddenResourceCols}
            />
          </DebugPanel>

          <DebugPanel
            title="Account Tags"
            subtitle={orgData === null ? 'Requires an AWS Organization sync' : `${String(accountTagKeys.length)} keys · across ${String(orgData.accounts.length)} accounts`}
            expanded={accountTagsExpanded}
            onToggle={() => { setAccountTagsExpanded(v => !v); }}
          >
            <AccountTagsContent
              orgData={orgData}
              accountTagKeys={accountTagKeys}
              hiddenAccountCols={hiddenAccountCols}
              setHiddenAccountCols={setHiddenAccountCols}
            />
          </DebugPanel>
        </div>
      )}
    </div>
  );
}
