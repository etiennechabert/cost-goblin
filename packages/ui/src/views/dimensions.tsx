import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, GripVertical, Lock, Database, AlertTriangle, EyeOff } from 'lucide-react';
import type { BuiltInDimension, ColumnValuesPreview, DimensionsConfig, TagDimension, ConceptType, NormalizationRule, RollupGrainEstimate, RollupSizeBand, StripPatternIssues } from '@costgoblin/core/browser';
import { asDimensionId, describeTagSource, findTagIdCollisions, hasTagSource, nameStripPatternViolations, OU_PATH_SOURCE_KEY, tagDimColumn, tagSqlColumn } from '@costgoblin/core/browser';
import { formatBytes } from '../components/format.js';

const OU_PATH_LABEL = 'OU Path';
function formatAccountSource(key: string): string {
  return key === OU_PATH_SOURCE_KEY ? OU_PATH_LABEL : key;
}

/** Mirror of DuckDB's split_part for the in-editor preview: 1-based,
 *  negative indices count from the end. Returns '' when the segment
 *  doesn't exist, matching split_part's out-of-range behaviour. */
function takeSegment(value: string, separator: string, index: number): string {
  const parts = value.split(separator);
  const i = index > 0 ? index - 1 : parts.length + index;
  if (i < 0 || i >= parts.length) return '';
  return parts[i] ?? '';
}
function tagOrderKey(t: { tagName?: string | undefined; accountTagFallback?: string | undefined; label: string }): string {
  if (t.tagName !== undefined && t.tagName.length > 0) return `tag:${t.tagName}`;
  const src = t.accountTagFallback ?? '';
  return `tag:@${src}:${t.label}`;
}

// Core dimensions that cannot be disabled — service and service_category anchor
// the widget fallback chain. sku_meter stays a fallback candidate (queried
// from the raw column regardless of enabled state) but is now toggleable, so a
// heavy sku_meter grain can be dropped from the rollup to keep dashboards fast.
const LOCKED_DIMENSIONS = new Set([asDimensionId('service'), asDimensionId('service_category')]);
const LOCKED_DIMENSION_NOTE = 'Always enabled — required for cost breakdown';

function migrateLocked(cfg: DimensionsConfig): { config: DimensionsConfig; changed: boolean } {
  const needsFix = cfg.builtIn.some(d => LOCKED_DIMENSIONS.has(d.name) && d.enabled === false);
  if (!needsFix) return { config: cfg, changed: false };
  const builtIn = cfg.builtIn.map(d => {
    if (!LOCKED_DIMENSIONS.has(d.name) || d.enabled !== false) return d;
    const rest = { ...d };
    delete (rest as { enabled?: boolean }).enabled;
    return rest;
  });
  return { config: { ...cfg, builtIn }, changed: true };
}
import { useCostApi } from '../hooks/use-cost-api.js';
import { getModalLayerCount } from '../hooks/modal-layers.js';
import { useUnsavedChanges } from '../hooks/use-unsaved-changes.js';
import { useQuery } from '../hooks/use-query.js';
import { useDebouncedValue } from '../hooks/use-debounced-value.js';
import { useReducedMotion } from '../hooks/use-reduced-motion.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { AliasSuggestions } from '../components/alias-suggestions.js';
import { focusOnMount } from '../lib/focus-on-mount.js';

function useClickOutsideDismiss(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onCancel: () => void,
  isDirty: boolean,
  discardConfirm: boolean,
  setDiscardConfirm: (v: boolean) => void,
): void {
  // A ref, not a local of the effect: the effect re-subscribes on every render
  // of the parent (an inline onCancel), which may land between the press and
  // the click.
  const pressedOutsideRef = useRef(false);
  useEffect(() => {
    function isOutside(e: MouseEvent): boolean {
      if (containerRef.current === null) return false;
      if (!(e.target instanceof Node)) return false;
      if (containerRef.current.contains(e.target)) return false;
      // A press inside a modal over the page (the palette's "Reload data?",
      // the release notes) belongs to that modal, not "outside the editor":
      // dismissing here would close the editor, or mount the discard prompt
      // behind the modal the user is working in.
      return !discardConfirm && getModalLayerCount() === 0;
    }
    // Dismissed on the click, not the press: closing on mousedown collapsed the
    // editor under the pointer, the rows below it moved up before the button
    // was released, and the click meant to open one of them was lost. The press
    // must be outside too: a text selection dragged out of the editor ends in a
    // click on an element around both.
    function onMouseDown(e: MouseEvent): void { pressedOutsideRef.current = isOutside(e); }
    function onClick(e: MouseEvent): void {
      // A click from the keyboard has no press of its own: don't let it reuse
      // one from an earlier drag. One on a control that opens another editor
      // (a row, a Rollup impact name) counts as pressed: opening that editor
      // closes this one, so it must ask first too. Other controls keep the
      // editor open (the clash banner's Remove).
      const opensEditor = e.target instanceof Element && e.target.closest('[data-opens-editor]') !== null;
      const pressed = pressedOutsideRef.current || opensEditor;
      pressedOutsideRef.current = false;
      if (!pressed || !isOutside(e)) return;
      if (isDirty) {
        // Captured before React sees it: the click must not go on to open
        // another editor, which would close this one and lose its edits.
        e.stopPropagation();
        e.preventDefault();
        setDiscardConfirm(true);
      } else {
        onCancel();
      }
    }
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm]);
}

/** An open dimension editor. Focusable (tabIndex -1) so a reveal can move focus
 *  into it; `scroll-mt` keeps a revealed one with nothing above it off the
 *  scroller's top edge. */
const EDITOR_CARD_CLASS = 'scroll-mt-4 rounded-xl border border-accent/30 bg-bg-tertiary/10 px-5 py-4 flex flex-col gap-4 outline-none';

/** Input that means the user is scrolling the page themselves. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/** Scrolls an editor up to the top of the page and moves focus into it each
 *  time `revealSeq` changes to a non-zero value (each time it is opened). The
 *  element above it, the previous dimension's collapsed row or the list
 *  heading, is what lands at the top, so the user keeps their place in the list.
 *
 *  Content above that grows while the smooth scroll runs (the Rollup impact
 *  panel loading) would leave the editor halfway down: the animation overwrites
 *  Chromium's scroll-anchoring correction. So when the scroll ends, the anchor
 *  is put back at the top, unless the user has started scrolling (or a dialog
 *  has opened) meanwhile. */
function useRevealOnRequest(containerRef: React.RefObject<HTMLDivElement | null>, revealSeq: number): void {
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const el = containerRef.current;
    if (revealSeq === 0 || el === null) return undefined;
    const anchor = el.previousElementSibling ?? el;
    anchor.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
    // An instant scroll needs no settling: scroll anchoring holds it.
    if (reducedMotion) return undefined;

    function stop(): void {
      clearTimeout(timer);
      document.removeEventListener('scrollend', settle, true);
      for (const type of USER_SCROLL_EVENTS) document.removeEventListener(type, stop, true);
    }
    function settle(): void {
      stop();
      // Not under a dialog that opened on its own meanwhile.
      if (getModalLayerCount() > 0) return;
      anchor.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    // Capture, to hear the end of an element scroller's scroll too. Bounded,
    // for when the anchor was already in place and no scroll happens.
    const timer = setTimeout(stop, 2000);
    document.addEventListener('scrollend', settle, true);
    for (const type of USER_SCROLL_EVENTS) document.addEventListener(type, stop, true);
    return stop;
    // Only a new request scrolls: the motion setting is read, not watched.
  }, [containerRef, revealSeq]);
}

/** What an editor's Disable does, and the label of the dimension it opens
 *  next (undefined after the last one). */
interface DisableAction { run: () => void; next: string | undefined }

/** Turns the dimension off from its open editor, so the user can drop one
 *  right after looking at its values instead of scrolling up to its pill. The
 *  editor's unsaved edits go with it, so it asks first when there are any. */
function DisableDimensionButton({ isDirty, action }: Readonly<{ isDirty: boolean; action: DisableAction }>): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => { if (isDirty) setConfirming(true); else action.run(); }}
        title={action.next === undefined ? 'Turn this dimension off' : `Turn this dimension off and open ${action.next}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-1.5 text-xs font-medium text-text-secondary hover:border-text-muted hover:text-text-primary transition-colors"
      >
        <EyeOff size={13} />
        Disable dimension
      </button>
      {confirming && (
        <ConfirmModal
          title="Disable this dimension?"
          message="Your unsaved edits to it will be discarded."
          confirmLabel="Disable"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => { setConfirming(false); action.run(); }}
          onCancel={() => { setConfirming(false); }}
        />
      )}
    </>
  );
}

/** Drag/drop is now indexed by position in the unified `order` array,
 *  not by (type, index) into the split built-in/tag arrays. Keeps a single
 *  reorder space so a tag can be dropped above a built-in and vice-versa. */
interface DragRef { orderIdx: number }

function builtInKey(name: string): string { return `builtin:${name}`; }

function defaultOrder(config: DimensionsConfig): string[] {
  const keys: string[] = [];
  for (const d of config.builtIn) {
    if (d.enabled !== false) keys.push(builtInKey(d.name));
  }
  for (const t of config.tags) {
    if (t.enabled !== false) keys.push(tagOrderKey(t));
  }
  return keys;
}

function collectValidKeys(config: DimensionsConfig): Set<string> {
  const valid = new Set<string>();
  for (const d of config.builtIn) {
    if (d.enabled !== false) valid.add(builtInKey(d.name));
  }
  for (const t of config.tags) {
    if (t.enabled !== false) valid.add(tagOrderKey(t));
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
    const k = tagOrderKey(t);
    if (t.enabled !== false && !seen.has(k)) { out.push(k); seen.add(k); }
  }
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Codepoint order, NOT localeCompare: this feeds a canonical serialization,
 *  and collation ties distinct strings (NFC vs NFD spellings), which would make
 *  the "stable" output depend on key insertion order. */
function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Order-insensitive serialization for dirty-checking: recursively sorts object
 *  keys so two configs that differ only in key insertion order compare equal.
 *  Array order is preserved (dimension/order arrays are semantically ordered).
 *  Without this, saving a dim editor — which rebuilds the dim object key-by-key
 *  in a different order than the on-disk baseline — would flip `dirty` true on a
 *  no-op save and offer a needless rollup rebuild. A field set to undefined
 *  (how the tag editor writes one it cleared) counts as absent, as it does in
 *  JSON and in the saved YAML. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort(compareCodepoint)
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',');
    return `{${entries}}`;
  }
  return JSON.stringify(value);
}

const CONCEPTS: { value: ConceptType; label: string }[] = [
  { value: 'environment', label: 'Environment' },
  { value: 'product', label: 'System' },
  { value: 'owner', label: 'Owner' },
  { value: 'unit', label: 'Unit' },
];

const NORMALIZE_RULES: { value: NormalizationRule; label: string }[] = [
  { value: 'lowercase', label: 'lowercase' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase-kebab', label: 'kebab-case (a-b-c)' },
  { value: 'lowercase-underscore', label: 'snake_case (a_b_c)' },
  { value: 'camelCase', label: 'camelCase' },
];

/** Per-dim "Default filter" picker. Click-to-open multi-select. Stays out of
 *  the DB — the enclosing editor already loads & displays the dim's values
 *  for its own preview, so we pipe that already-resolved list in via
 *  `available` (calling `getFilterValues` here would re-run the full
 *  alias-resolving pipeline against every row — we hit 70+s on an 86M-row
 *  scan in a prior iteration). */
function DefaultValuesPicker({ available, selected, onChange }: Readonly<{
  available: readonly string[];
  selected: readonly string[];
  onChange: (next: readonly string[]) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedSet = new Set(selected);
  // Surface selected values that aren't in the discovered window — so the
  // user always sees what they've picked, even if older.
  const allValues = [...new Set([...selected, ...available])];
  const filtered = search.length === 0
    ? allValues
    : allValues.filter(v => v.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!open) return;
      if (containerRef.current === null) return;
      if (!(e.target instanceof Node)) return;
      if (containerRef.current.contains(e.target)) return;
      setOpen(false);
      setSearch('');
    }
    document.addEventListener('mousedown', onDocClick);
    return () => { document.removeEventListener('mousedown', onDocClick); };
  }, [open]);

  function toggle(value: string): void {
    if (selectedSet.has(value)) onChange(selected.filter(v => v !== value));
    else onChange([...selected, value]);
  }

  let summary: string;
  if (selected.length === 0) summary = 'No defaults';
  else if (selected.length <= 3) summary = selected.join(', ');
  else summary = `${String(selected.length)} selected`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(v => !v); }}
        className="w-full flex items-center justify-between rounded border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary"
      >
        <span className={selected.length === 0 ? 'text-text-muted' : ''}>{summary}</span>
        <span className="text-text-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute z-10 left-0 right-0 mt-1 rounded border border-border bg-bg-secondary shadow-lg flex flex-col">
          {allValues.length > 6 && (
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); }}
              ref={focusOnMount}
              className="border-b border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none"
              placeholder="Search…"
            />
          )}
          {filtered.length === 0 ? (
            <span className="px-2 py-2 text-[10px] text-text-muted">
              {allValues.length === 0 ? 'No discovered values yet.' : 'No matches.'}
            </span>
          ) : (
            <div className="max-h-56 overflow-y-auto flex flex-col">
              {filtered.map(v => (
                <label key={v} className="flex items-center gap-2 px-2 py-1 text-xs text-text-primary cursor-pointer hover:bg-bg-tertiary">
                  <input type="checkbox" checked={selectedSet.has(v)} onChange={() => { toggle(v); }} />
                  <span className="truncate">{v}</span>
                </label>
              ))}
            </div>
          )}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => { onChange([]); }}
              className="border-t border-border px-2 py-1 text-[10px] text-text-muted hover:text-text-primary text-left"
            >Clear selection</button>
          )}
        </div>
      )}
    </div>
  );
}

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
  defaultFilterValues: readonly string[];
}

const TRANSFORM_FREE_FIELDS = new Set(['service', 'service_category']);

/** The preview runs strip patterns in the main process under a time budget —
 *  wait for the textarea to settle instead of re-running on every keystroke. */
const STRIP_PATTERN_PREVIEW_DEBOUNCE_MS = 300;

/** One pattern per non-blank line, trimmed — the same list the editor saves. */
function parseStripPatternLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function describePatternPositions(indexes: readonly number[]): { subject: string; plural: boolean } {
  const positions = indexes.map(i => String(i + 1)).join(', ');
  return indexes.length === 1
    ? { subject: `Pattern ${positions}`, plural: false }
    : { subject: `Patterns ${positions}`, plural: true };
}

/** User-facing lines for the patterns the preview could not apply. Positions
 *  are 1-based over the non-blank lines. None of these block saving: the same
 *  bounded executor skips them the same way when the account map is built. */
function stripIssueMessages(issues: StripPatternIssues): string[] {
  const messages: string[] = [];
  if (issues.slow.length > 0) {
    const { subject, plural } = describePatternPositions(issues.slow);
    messages.push(`${subject} took too long and ${plural ? 'were' : 'was'} skipped — simplify ${plural ? 'them' : 'it'} (nested quantifiers such as (.+)+ backtrack catastrophically).`);
  }
  if (issues.invalid.length > 0) {
    const { subject, plural } = describePatternPositions(issues.invalid);
    messages.push(`${subject} ${plural ? 'are' : 'is'} not a valid regular expression and ${plural ? 'were' : 'was'} skipped.`);
  }
  if (issues.skipped.length > 0) {
    const { subject, plural } = describePatternPositions(issues.skipped);
    messages.push(`${subject} ${plural ? 'were' : 'was'} not evaluated — the preview ran out of time.`);
  }
  return messages;
}

function buildDiscoverOptions(
  dim: { field: string },
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
    ...(isAnyRegionDim ? { useRegionNames: state.useRegionNames } : {}),
  };
}

function computeEnrichmentWarnings(
  dim: { name: string; field: string },
  state: EditingBuiltIn,
  regionInfoQuery: { status: string; data?: { count: number; lastError: string | null } | null },
  orgQuery: { status: string; data?: unknown },
): { regionWarning: { kind: 'missing' | 'error'; message?: string } | null; accountWarning: boolean } {
  const isRegionDim = dim.name === 'region';
  const isAccountDim = dim.field === 'account_id';

  const wantsRegionEnrichment = isRegionDim && state.useRegionNames;
  let regionWarning: { kind: 'missing' | 'error'; message?: string } | null = null;
  if (wantsRegionEnrichment && regionInfoQuery.status === 'success') {
    const regionInfo = regionInfoQuery.data ?? null;
    if (regionInfo === null || regionInfo.count === 0) regionWarning = { kind: 'missing' };
    else if (regionInfo.lastError !== null) regionWarning = { kind: 'error', message: regionInfo.lastError };
  }
  const accountWarning = isAccountDim && orgQuery.status === 'success' && orgQuery.data === null;
  return { regionWarning, accountWarning };
}

function BuiltInEditor({ dim, onSave, onCancel, onDisable, revealSeq, accountTagKeys }: Readonly<{
  dim: { name: string; field: string; editing: EditingBuiltIn };
  onSave: (edited: EditingBuiltIn) => void;
  onCancel: () => void;
  /** Undefined for a dimension that can't be turned off. */
  onDisable: DisableAction | undefined;
  /** See useRevealOnRequest; 0 = never scrolled to. */
  revealSeq: number;
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
  // Caps are checked on the live text (so Save disables immediately); the
  // preview only sees the debounced text, and never an over-limit list — the
  // main process would reject it. Patterns are never run in the renderer.
  const stripPatternViolations = isAccountDim ? nameStripPatternViolations(parseStripPatternLines(state.nameStripPatterns)) : [];
  const debouncedStripPatterns = useDebouncedValue(state.nameStripPatterns, STRIP_PATTERN_PREVIEW_DEBOUNCE_MS);
  const previewStripPatternList = parseStripPatternLines(debouncedStripPatterns);
  const previewBlocked = isAccountDim && nameStripPatternViolations(previewStripPatternList).length > 0;
  const stripPatternsKey = previewStripPatternList.join('\u0001');
  const normalize: NormalizationRule | undefined = state.normalize.length > 0 ? state.normalize as NormalizationRule : undefined;
  const discoverOptions = buildDiscoverOptions(dim, state, normalize, previewStripPatternList);
  const valuesQuery = useQuery(
    (): Promise<ColumnValuesPreview | null> => previewBlocked ? Promise.resolve(null) : api.discoverColumnValues(dim.field, discoverOptions),
    [dim.field, dim.name, isAccountDim, isAnyRegionDim, state.useOrgAccounts, state.useRegionNames, state.accountNameFromTag, stripPatternsKey, previewBlocked, normalize],
  );

  useClickOutsideDismiss(containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm);
  useRevealOnRequest(containerRef, revealSeq);

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
  const baseTagKeyOptions = state.accountNameFromTag.length > 0 && !accountTagKeys.includes(state.accountNameFromTag) && state.accountNameFromTag !== OU_PATH_SOURCE_KEY
    ? [state.accountNameFromTag, ...accountTagKeys]
    : [...accountTagKeys];
  const tagKeyOptions = [OU_PATH_SOURCE_KEY, ...baseTagKeyOptions];
  const nameSourceField = (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Name source (from org-sync)</span>
        <select
          value={nameSource}
          onChange={e => {
            const v = e.target.value;
            if (v === 'name') setState(s => ({ ...s, accountNameFromTag: '' }));
            else setState(s => ({ ...s, accountNameFromTag: s.accountNameFromTag.length > 0 ? s.accountNameFromTag : (accountTagKeys[0] ?? OU_PATH_SOURCE_KEY) }));
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
                {tagKeyOptions.map(t => <option key={t} value={t}>{formatAccountSource(t)}</option>)}
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
            : 'Sync Region Names from Data Management to enable.'}
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
  const stripIssueLines = isAccountDim && preview !== null ? stripIssueMessages(preview.stripIssues) : [];
  const stripPatternsField = (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Name strip patterns (one regex per line)</span>
        <textarea
          value={state.nameStripPatterns}
          onChange={e => { setState(s => ({ ...s, nameStripPatterns: e.target.value })); }}
          rows={3}
          className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary outline-none focus:border-accent"
          placeholder={'\\s+(production|staging|sandbox)$\n^Acme Corp '}
        />
      </label>
      {stripPatternViolations.length > 0 && (
        <div role="alert">
          <ul className="flex flex-col gap-0.5 text-[11px] text-negative">
            {stripPatternViolations.map(v => <li key={v}>Can't save: {v}.</li>)}
          </ul>
        </div>
      )}
      {stripIssueLines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[11px] text-warning">
          {stripIssueLines.map(m => <li key={m}>{m}</li>)}
        </ul>
      )}
    </div>
  );
  const aliasField = (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Alias Rules (canonical: alias1, alias2)</span>
      <textarea
        value={state.aliases}
        onChange={e => { setState(s => ({ ...s, aliases: e.target.value })); }}
        rows={3}
        className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary outline-none focus:border-accent"
        placeholder="S3: Amazon Simple Storage Service"
      />
    </label>
  );

  const { regionWarning, accountWarning } = computeEnrichmentWarnings(dim, state, regionInfoQuery, orgQuery);

  return (
    <div ref={containerRef} tabIndex={-1} className={EDITOR_CARD_CLASS}>
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
              Sync the <span className="font-medium">Region Names</span> section on Data Management to
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
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Default filter</span>
        <span className="text-[10px] text-text-muted">
          Pre-applied to the global filter bar when a view opens. Empty = no default.
        </span>
        <DefaultValuesPicker
          available={preview?.values.map(v => v.value) ?? []}
          selected={state.defaultFilterValues}
          onChange={vals => { setState(s => ({ ...s, defaultFilterValues: vals })); }}
        />
      </div>
      <div className="flex items-center justify-between pt-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { onSave(state); }}
            disabled={stripPatternViolations.length > 0}
            title={stripPatternViolations.length > 0 ? 'Fix the name strip patterns first' : undefined}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-bg-primary hover:bg-accent/90 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-accent"
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
        {onDisable === undefined ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <Lock size={13} />
            {LOCKED_DIMENSION_NOTE}
          </span>
        ) : <DisableDimensionButton isDirty={isDirty} action={onDisable} />}
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
        aria-expanded={expanded}
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
  pathSegIndex: string;
  defaultFilterValues: readonly string[];
}

/** OU Path values are joined by ` / ` in aws-org-client.ts when the path is
 *  built — it's an internal choice, not user data — so we hardcode the same
 *  separator wherever we segment it. */
const OU_PATH_SEPARATOR = ' / ';

/** The OU Path segment field's index (1-based, negative counts from the end),
 *  or undefined when it keeps the whole path: blank, 0 or not a number. */
function parsePathSegIndex(text: string): number | undefined {
  const index = Number.parseInt(text, 10);
  return Number.isInteger(index) && index !== 0 ? index : undefined;
}

/** The editor only shows a segment field for the OU Path source, so that
 *  segment is the editor's to write. A segment on any other source comes from
 *  the config file and is kept, unless the tag is moving off the OU Path,
 *  whose ` / ` split only fits the path. */
function editedPathSegment(editing: EditingTag, original: TagDimension | undefined): TagDimension['pathSegment'] {
  if (editing.fallbackTag === OU_PATH_SOURCE_KEY) {
    const index = parsePathSegIndex(editing.pathSegIndex);
    return index === undefined ? undefined : { separator: OU_PATH_SEPARATOR, index };
  }
  return original?.accountTagFallback === OU_PATH_SOURCE_KEY ? undefined : original?.pathSegment;
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
  return [...entries]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(e => e.aliases.length > 0
      ? `${e.key}: ${[...e.aliases].sort((a, b) => a.localeCompare(b)).join(', ')}`
      : `${e.key}:`)
    .join('\n');
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter(l => l.trim().length > 0);
}

/** The rule rows while the rules are being typed in: each shows exactly what
 *  was typed, and the rows keep the order and keys they had, so a rule being
 *  renamed neither moves nor remounts under the caret (or under the pointer,
 *  on its way to the rule's remove button). */
interface PinnedAliasRows {
  readonly lines: readonly string[];
  readonly keys: readonly string[];
}

/** Where `line` lands once `rows` are shown tidied, or null if it's dropped. */
function sortedRowIndex(rows: readonly string[], line: string | undefined): number | null {
  if (line === undefined) return null;
  const to = nonBlankLines(sortAliasText(rows.join('\n'))).indexOf(sortAliasText(line));
  return to >= 0 ? to : null;
}

/** React keys for the rule rows: the rule's name, numbered when two rows share
 *  one. A name can't contain ':', so `name:n` never equals another row's key. */
function aliasRowKeys(lines: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map(line => {
    const name = line.split(':')[0] ?? '';
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return `${name}:${String(n)}`;
  });
}

function AliasRulesEditor({ value, savedValue, activeLine, onChange, onLineFocus }: Readonly<{
  value: string;
  savedValue: string;
  activeLine: number | null;
  onChange: (v: string) => void;
  onLineFocus: (lineIdx: number | null) => void;
}>): React.JSX.Element {
  const newLineRef = useRef<HTMLInputElement>(null);
  // The rows show `value` tidied by sortAliasText, except while the rules are
  // typed in: tidying on every keystroke ate the ", " before the next alias
  // ("pay, PAY" came out "payPAY") and moved a rule being renamed. They stay
  // pinned until focus leaves the rules or Enter ends the edit, so nothing
  // re-sorts while the user moves between rules. A pin that no longer matches
  // `value` was overtaken by a change made elsewhere.
  const [pin, setPin] = useState<PinnedAliasRows | null>(null);
  const pinned = pin !== null && pin.lines.join('\n') === value ? pin : null;
  const sorted = nonBlankLines(sortAliasText(value));
  const lines = pinned?.lines ?? sorted;
  const keys = pinned?.keys ?? aliasRowKeys(sorted);
  const savedLines = new Set(nonBlankLines(sortAliasText(savedValue)));

  /** Lets the rows sort again, moving the highlight (the rule a clicked preview
   *  value is added to) along with its rule. */
  function finishEdit(): void {
    setPin(null);
    if (pinned !== null && activeLine !== null) onLineFocus(sortedRowIndex(pinned.lines, pinned.lines[activeLine]));
  }

  return (
    <div
      className="rounded border border-border bg-bg-primary overflow-hidden"
      onBlur={e => {
        if (e.relatedTarget !== null && e.currentTarget.contains(e.relatedTarget)) return;
        // Switching apps (to copy an alias, say) blurs the focused input but
        // leaves it the focused element: the edit isn't over yet.
        if (e.target.ownerDocument.activeElement === e.target) return;
        finishEdit();
      }}
    >
      {lines.map((line, i) => {
        const isNew = !savedLines.has(line);
        const isActive = activeLine === i;
        let borderStyle = 'border-l-transparent';
        if (isActive) borderStyle = 'border-l-accent bg-accent/10';
        else if (isNew) borderStyle = 'border-l-warning bg-warning/5';
        return (
          <div
            key={keys[i] ?? String(i)}
            className={`flex items-center gap-1 px-3 py-1 text-[11px] font-mono border-l-2 ${borderStyle} ${i > 0 ? 'border-t border-t-border/30' : ''}`}
          >
            <input
              type="text"
              value={line}
              onFocus={() => { onLineFocus(i); }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setPin(null);
                  onLineFocus(null);
                  newLineRef.current?.focus();
                }
              }}
              onChange={e => {
                const newLines = [...lines];
                newLines[i] = e.target.value;
                setPin({ lines: newLines, keys });
                onChange(newLines.join('\n'));
              }}
              className="flex-1 bg-transparent text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const rest = lines.filter((_, j) => j !== i);
                setPin(null);
                onChange(rest.join('\n'));
                if (activeLine !== null) onLineFocus(activeLine === i ? null : sortedRowIndex(rest, lines[activeLine]));
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

function camelStripSeparators(value: string): string {
  let out = '';
  let pending = '';
  for (const ch of value) {
    if (ch === '-' || ch === '_' || /\s/.test(ch)) {
      pending += ch;
    } else if (pending === '') {
      out += ch;
    } else {
      out += ch.toUpperCase();
      pending = '';
    }
  }
  return out + pending;
}

function applyPreviewNormalize(v: string, rule: string): string {
  switch (rule) {
    case 'lowercase': return v.toLowerCase();
    case 'uppercase': return v.toUpperCase();
    case 'lowercase-kebab': return v.replaceAll(/([a-z])([A-Z])/g, '$1-$2').replaceAll('_', '-').replaceAll(' ', '-').toLowerCase();
    case 'lowercase-underscore': return v.replaceAll(/([a-z])([A-Z])/g, '$1_$2').replaceAll('-', '_').replaceAll(' ', '_').toLowerCase();
    case 'camelCase': return camelStripSeparators(v).replace(/^(.)/, (_, c: string) => c.toLowerCase());
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
            onClick={onBadgeClick === undefined ? undefined : () => { onBadgeClick(resolved); }}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${sourceColor(source, aliased)} ${onBadgeClick === undefined ? '' : 'cursor-pointer hover:ring-1 hover:ring-accent/50'}`}
          >
            {resolved}
          </button>
        ))}
      </div>
    </div>
  );
}

function TagEditor({ tag, onSave, onCancel, onRemove, onDisable, revealSeq, idConflict, availableTags, discoveredTags: discovered, accountTagKeys: acctTags, orgAccounts }: Readonly<{
  tag: EditingTag;
  onSave: (tag: EditingTag) => void;
  onCancel: () => void;
  onRemove: (() => void) | undefined;
  /** Undefined for a tag that isn't in the list yet (the Add form). */
  onDisable: DisableAction | undefined;
  /** See useRevealOnRequest; 0 = never scrolled to (the Add form). */
  revealSeq: number;
  /** Why this tag can't be saved because another tag already has its
   *  dimension id, or null when the id is free. */
  idConflict: (tag: EditingTag) => string | null;
  availableTags: readonly string[];
  discoveredTags: readonly { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[];
  accountTagKeys: readonly string[];
  orgAccounts: readonly { tags: Readonly<Record<string, string>>; ouPath: string }[];
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
  useRevealOnRequest(containerRef, revealSeq);

  const tagOptions = state.tagName.length > 0 && !availableTags.includes(state.tagName)
    ? [state.tagName, ...availableTags]
    : [...availableTags];

  const tagMatch = discovered.find(t => t.key === state.tagName);

  const fallbackValues = (() => {
    if (state.fallbackTag === undefined || state.fallbackTag.length === 0) return [];
    const usesOuPath = state.fallbackTag === OU_PATH_SOURCE_KEY;
    const segIndex = usesOuPath ? parsePathSegIndex(state.pathSegIndex) : undefined;
    const counts = new Map<string, number>();
    for (const acct of orgAccounts) {
      const raw = usesOuPath ? acct.ouPath : acct.tags[state.fallbackTag];
      if (raw === undefined || raw.length === 0) continue;
      const val = segIndex === undefined ? raw : takeSegment(raw, OU_PATH_SEPARATOR, segIndex);
      if (val.length === 0) continue;
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();
  const fallbackOptions = [OU_PATH_SOURCE_KEY, ...acctTags];
  const noSourceWarning = state.tagName.length === 0 && (state.fallbackTag === undefined || state.fallbackTag.length === 0);
  const conflict = idConflict(state);

  // Resolved value list for the Default filter picker. Mirrors the same
  // transformation TagValuePreview applies (normalize + alias-resolve) so the
  // strings here match what flows through FilterMap at query time. Pulls from
  // already-loaded sources (resource-tag sample values, account-fallback
  // counts) — no DB call.
  const defaultValueOptions = (() => {
    const resourceVals = tagMatch === undefined ? [] : tagMatch.sampleValues;
    const accountVals = fallbackValues.map(([v]) => v);
    const allRaw = [...new Set([...resourceVals, ...accountVals])];
    if (allRaw.length === 0) return [] as readonly string[];
    const aliasMap = buildAliasMap(state.aliases, state.normalize);
    const resolved = new Set<string>();
    for (const raw of allRaw) {
      const normalized = applyPreviewNormalize(raw, state.normalize);
      resolved.add(aliasMap.get(normalized) ?? normalized);
    }
    return [...resolved].sort((a, b) => a.localeCompare(b));
  })();

  return (
    <div ref={containerRef} tabIndex={-1} className={EDITOR_CARD_CLASS}>
      {/* Row 1: Concept + Display Label + Normalization */}
      <div className="grid grid-cols-3 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Concept</span>
          <select
            value={state.concept}
            onChange={e => {
              const next = e.target.value;
              const nextLabel = CONCEPTS.find(c => c.value === next)?.label;
              setState(s => {
                // Auto-fill Display Label with the concept's label when the
                // user hasn't customised it yet — empty, or still equal to the
                // previously-selected concept's label.
                const prevConceptLabel = CONCEPTS.find(c => c.value === s.concept)?.label;
                const labelIsAutoFilled = s.label.length === 0 || (prevConceptLabel !== undefined && s.label === prevConceptLabel);
                const label = labelIsAutoFilled && nextLabel !== undefined ? nextLabel : s.label;
                return { ...s, concept: next, label };
              });
            }}
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
      <div className="grid grid-cols-3 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Resource Tag</span>
          <select
            value={state.tagName}
            onChange={e => {
              const name = e.target.value;
              const label = name
                .replaceAll('_', ' ')
                .replaceAll('-', ' ')
                .replaceAll(/\b\w/g, c => c.toUpperCase());
              setState(s => ({ ...s, tagName: name, label: s.label.length === 0 ? label : s.label }));
            }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">No resource tag</option>
            {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {tagMatch !== undefined && (
            <span className="text-[10px] text-text-muted">{String(tagMatch.coveragePct)}% coverage · {String(tagMatch.distinctCount)} distinct values</span>
          )}
          {state.tagName.length === 0 && (
            <span className="text-[10px] text-text-muted">Account-level only (no resource tag)</span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{state.tagName.length === 0 ? 'Account source' : 'Fallback (account)'}</span>
          <select
            value={state.fallbackTag ?? ''}
            onChange={e => {
              const next = e.target.value;
              setState(s => ({ ...s, fallbackTag: next.length > 0 ? next : undefined }));
            }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">{state.tagName.length === 0 ? 'Select a source…' : 'No fallback'}</option>
            {fallbackOptions.map(t => <option key={t} value={t}>{formatAccountSource(t)}</option>)}
          </select>
          {fallbackValues.length > 0 && (
            <span className="text-[10px] text-text-muted">{String(fallbackValues.length)} distinct values</span>
          )}
          {noSourceWarning && (
            <span className="text-[10px] text-warning">Pick a resource tag or an account source.</span>
          )}
        </label>
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
            {'{fallback}'} = account value
          </span>
        </label>
      </div>

      {conflict !== null && (
        <p className="text-xs text-negative" aria-live="polite">{conflict}</p>
      )}

      {/* OU-Path-only: extract a single segment of the slash-joined path.
          The OU Path is built with ` / ` in aws-org-client; users only pick
          which segment to keep, not the separator. */}
      {state.fallbackTag === OU_PATH_SOURCE_KEY && (
        <div className="grid grid-cols-3 gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">OU Path segment</span>
            <input
              type="number"
              value={state.pathSegIndex}
              onChange={e => { setState(s => ({ ...s, pathSegIndex: e.target.value })); }}
              className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary font-mono outline-none focus:border-accent"
              placeholder="full path"
            />
            <span className="text-[10px] text-text-muted">
              1-based; negative counts from the end (-1 = last). Blank keeps the full path.
            </span>
          </label>
        </div>
      )}

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
            const lines = nonBlankLines(sortAliasText(s.aliases));

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
            const sorted = nonBlankLines(sortAliasText(newAliases));
            const newIdx = sorted.findIndex(l => l.startsWith(value + ':'));
            if (newIdx >= 0) setActiveAliasLine(newIdx);
            return { ...s, aliases: newAliases };
          });
        }}
      />

      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Default filter</span>
        <span className="text-[10px] text-text-muted">
          Pre-applied to the global filter bar when a view opens. Empty = no default.
        </span>
        <DefaultValuesPicker
          available={defaultValueOptions}
          selected={state.defaultFilterValues}
          onChange={vals => { setState(s => ({ ...s, defaultFilterValues: vals })); }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { onSave(state); }}
            disabled={conflict !== null}
            title={conflict === null ? undefined : 'Another dimension already has this id'}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-accent"
          >
            Save
          </button>
          <button type="button" onClick={requestCancel} className="rounded-md px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary transition-colors">
            Cancel
          </button>
        </div>
        <div className="flex items-center gap-2">
          {onDisable !== undefined && <DisableDimensionButton isDirty={isDirty} action={onDisable} />}
          {onRemove !== undefined && (
            <button type="button" onClick={onRemove} className="rounded-md px-4 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted transition-colors">
              Remove Dimension
            </button>
          )}
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

function ToggleButton({ itemKey, hidden, onToggle }: Readonly<{ itemKey: string; hidden: boolean; onToggle: () => void }>): React.JSX.Element {
  return (
    <button
      key={itemKey}
      type="button"
      onClick={onToggle}
      aria-pressed={!hidden}
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

function pillClass(enabled: boolean, danger = false): string {
  let state: string;
  if (enabled && danger) {
    state = 'border-amber-500/50 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20';
  } else if (enabled) {
    state = 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/20';
  } else {
    state = 'border-border bg-bg-tertiary/20 text-text-muted hover:border-text-muted hover:text-text-secondary';
  }
  return ['rounded-full border px-3 py-1 text-xs font-medium transition-colors', state].join(' ');
}

/** The rollup grain column a built-in/tag dim contributes — mirrors
 *  `rollupGrainColumns` so the UI can match an estimate's per-dim verdict to a
 *  pill. */
function builtInGrainColumn(d: BuiltInDimension): string { return d.field; }

/** The draft config as the rollup estimator should see it: tags with neither
 *  a resource tag key nor an account-tag fallback are dropped. Such a tag is
 *  a half-filled editor row, not a dimension yet — the main process validates
 *  the estimate payload and would reject the whole candidate (surfacing the
 *  estimate error hint) over a row the user is still typing. */
export function withoutSourcelessTags(config: DimensionsConfig): DimensionsConfig {
  const tags = config.tags.filter(hasTagSource);
  return tags.length === config.tags.length ? config : { ...config, tags };
}

/** A digest of the ENABLED grain columns. Drives the estimate refetch: it
 *  changes when a dim is toggled (the grain changes) but not when a dim is
 *  reordered or relabelled (those never touch stored bytes). */
function grainSignature(config: DimensionsConfig): string {
  const cols: string[] = [];
  for (const d of config.builtIn) {
    if (d.enabled === false) continue;
    cols.push(d.field);
    if (d.displayField !== undefined && d.displayField.length > 0) cols.push(d.displayField);
  }
  for (const t of config.tags) if (t.enabled !== false) cols.push(tagSqlColumn(t));
  return [...new Set(cols)].sort((a, b) => a.localeCompare(b)).join(',');
}

const SIZE_BAND_LABEL: Record<RollupSizeBand, string> = {
  tiny: 'tiny', small: 'small', moderate: 'moderate', large: 'large', huge: 'very large',
};

function formatRebuild(seconds: number): string {
  if (seconds < 1) return '< 1s';
  if (seconds < 90) return `~${String(Math.round(seconds))}s`;
  return `~${String(Math.round(seconds / 60))} min`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

/** Chip on a pill whose dimension is high-cardinality enough to drive rollup
 *  size — shows its distinct-value count so the user can see WHY it's flagged.
 *  Such dims are best kept raw-only (their widgets fall back to raw Parquet). */
function RawOnlyBadge({ cardinality }: Readonly<{ cardinality: number | undefined }>): React.JSX.Element {
  const count = cardinality !== undefined && cardinality > 0 ? formatCount(cardinality) : null;
  const countSuffix = count === null ? '' : ` (~${count} distinct values)`;
  return (
    <span
      title={`High-cardinality${countSuffix} — a primary driver of rollup size. Best kept raw-only: widgets grouping by it query raw data instead of the rollup.`}
      className="ml-1.5 inline-flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-amber-500"
    >
      <Database className="h-2.5 w-2.5" />{count ?? 'raw'}
    </span>
  );
}

/** The enabled dimension a rollup grain column comes from, as its list key and
 *  label. Several built-ins can read one column and the grain probe lists the
 *  column once, so this is the first of them. */
function columnDimension(config: DimensionsConfig, column: string): { key: string; label: string } | undefined {
  const b = config.builtIn.find(d => d.enabled !== false && d.field === column);
  if (b !== undefined) return { key: builtInKey(b.name), label: b.label };
  const t = config.tags.find(tg => tg.enabled !== false && tagSqlColumn(tg) === column);
  return t === undefined ? undefined : { key: tagOrderKey(t), label: t.label };
}

/** Friendly label for a rollup grain column (for the heaviest-dimension list). */
function columnLabel(config: DimensionsConfig, column: string): string {
  const enabled = columnDimension(config, column);
  if (enabled !== undefined) return enabled.label;
  const b = config.builtIn.find(d => d.field === column);
  if (b !== undefined) return b.label;
  const t = config.tags.find(tg => tagSqlColumn(tg) === column);
  if (t !== undefined) return t.label;
  return column;
}

/** Opens the editor of the dimension behind a rollup grain column; undefined
 *  when no enabled dimension has it. */
type ColumnOpener = (column: string) => (() => void) | undefined;

/** A dimension's name in the Rollup impact panel: a link to its editor when
 *  it has one. */
function ImpactDimName({ label, onOpen, className, children }: Readonly<{
  label: string;
  onOpen: (() => void) | undefined;
  className: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  if (onOpen === undefined) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Configure ${label}`}
      // Named apart from the dimension's pill, which shows the same label.
      aria-label={`Configure ${label}`}
      data-opens-editor
      className={`${className} cursor-pointer text-left underline-offset-2 hover:underline focus-visible:underline`}
    >
      {children}
    </button>
  );
}

function ImpactStat({ label, value, hint }: Readonly<{ label: string; value: string; hint?: string }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className="text-sm font-semibold text-text-primary">{value}</span>
      {hint !== undefined && <span className="text-[10px] text-text-muted">{hint}</span>}
    </div>
  );
}

/** Eased progress feedback for the rollup estimate. The probe is an exact
 *  DuckDB scan (a few seconds; longer when resource_id is on) with no real
 *  per-query progress to read, so we ease asymptotically toward ~92% — slowing
 *  as it goes rather than stalling at a hard cap — and let completion unmount
 *  this (the panel only renders it while a probe is in flight). */
function EstimateProgress(): React.JSX.Element {
  const [pct, setPct] = useState(8);
  useEffect(() => {
    const id = setInterval(() => {
      setPct(p => (p >= 92 ? p : p + Math.max(0.6, (92 - p) * 0.1)));
    }, 150);
    return () => { clearInterval(id); };
  }, []);
  return (
    <div className="mt-3">
      <span className="text-xs text-text-muted">Estimating…</span>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
        <div className="h-full rounded-full bg-accent transition-all duration-200 ease-out" style={{ width: `${String(Math.round(pct))}%` }} />
      </div>
    </div>
  );
}

type RollupDimEstimate = RollupGrainEstimate['dims'][number];

function computeRowRatio(
  estimate: RollupGrainEstimate | null,
  matchedCurrent: RollupGrainEstimate['current'],
): number {
  if (estimate === null) return 0;
  if (matchedCurrent !== null && matchedCurrent.rows > 0) return estimate.raw.rows / matchedCurrent.rows;
  return estimate.compressionRate;
}

function ImpactWarning({ config, outlierDim, rawOnly, openColumn }: Readonly<{
  config: DimensionsConfig;
  outlierDim: RollupDimEstimate | undefined;
  rawOnly: RollupGrainEstimate['rawOnly'];
  openColumn: ColumnOpener;
}>): React.JSX.Element | null {
  if (outlierDim !== undefined) {
    const label = columnLabel(config, outlierDim.column);
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <p className="text-[11px] leading-snug text-text-secondary">
          <ImpactDimName label={label} onOpen={openColumn(outlierDim.column)} className="font-medium text-amber-500">{label}</ImpactDimName> alone multiplies the rollup ~×{outlierDim.marginalMultiplier.toFixed(1)} — most of the grain comes from this one dimension. Dimensions work best as filters with a handful of values; the detail table can still show every value when you need it, so keeping this one raw-only keeps dashboards fast.
        </p>
      </div>
    );
  }
  if (rawOnly.recommended) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <p className="text-[11px] leading-snug text-text-secondary">
          This grain is heavy for the rollup — {rawOnly.reason ?? 'it exceeds the size budget'}. Consider a leaner grain so dashboards stay fast.
        </p>
      </div>
    );
  }
  return null;
}

function impactReadout(d: RollupDimEstimate): string {
  if (d.marginalMultiplier < 1.05) return '~×1';
  const rows = d.marginalRows > 0 ? ` · +${formatCount(d.marginalRows)}` : '';
  return `×${d.marginalMultiplier.toFixed(1)}${rows}`;
}

function ImpactDimRow({ d, config, openColumn }: Readonly<{ d: RollupDimEstimate; config: DimensionsConfig; openColumn: ColumnOpener }>): React.JSX.Element {
  const label = columnLabel(config, d.column);
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <ImpactDimName
        label={label}
        onOpen={openColumn(d.column)}
        className={`flex w-28 shrink-0 items-center gap-1 truncate ${d.outlier ? 'font-medium text-amber-500' : 'text-text-secondary'}`}
      >
        {d.outlier && <AlertTriangle className="h-3 w-3 shrink-0" />}
        <span className="truncate">{label}</span>
      </ImpactDimName>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
        <span
          className={`block h-full rounded-full ${d.outlier ? 'bg-amber-500/70' : 'bg-accent/60'}`}
          style={{ width: `${String(Math.round(Math.min(1, d.impactShare) * 100))}%` }}
        />
      </span>
      <span className={`w-24 shrink-0 text-right tabular-nums ${d.outlier ? 'text-amber-500' : 'text-text-muted'}`}>{impactReadout(d)}</span>
    </li>
  );
}

function ImpactDetails({ estimate, matchedCurrent, sizeReduction, rowRatio, rankedDims, outlierDim, config, openColumn }: Readonly<{
  estimate: RollupGrainEstimate;
  matchedCurrent: RollupGrainEstimate['current'];
  sizeReduction: number;
  rowRatio: number;
  rankedDims: readonly RollupDimEstimate[];
  outlierDim: RollupDimEstimate | undefined;
  config: DimensionsConfig;
  openColumn: ColumnOpener;
}>): React.JSX.Element {
  return (
    <>
      <div className={`mt-3 grid grid-cols-2 gap-4 ${matchedCurrent === null ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
        <ImpactStat
          label="Raw data"
          value={formatBytes(estimate.raw.bytes)}
          hint={`${formatCount(estimate.raw.rows)} line items · ${String(estimate.months)} mo`}
        />
        {matchedCurrent === null ? (
          <ImpactStat
            label="Est. rollup"
            value={formatBytes(estimate.candidate.bytes)}
            hint={`${SIZE_BAND_LABEL[estimate.candidate.sizeBand]} · ${formatCount(estimate.candidate.rows)} rows`}
          />
        ) : (
          <ImpactStat
            label="Rollup"
            value={formatBytes(matchedCurrent.bytes)}
            hint={`${formatCount(matchedCurrent.rows)} rows`}
          />
        )}
        <ImpactStat
          label="Compression"
          value={sizeReduction >= 1.05 ? `${sizeReduction.toFixed(1)}×` : '~1×'}
          hint={`smaller than raw · ${rowRatio >= 1 ? rowRatio.toFixed(0) : rowRatio.toFixed(1)}× fewer rows`}
        />
        {matchedCurrent === null && (
          <ImpactStat
            label="Rebuild"
            value={formatRebuild(estimate.candidate.rebuildSeconds)}
            hint="background re-roll"
          />
        )}
      </div>
      {rankedDims.length > 0 && (
        <div className="mt-4">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Per-dimension impact</span>
          <ul className="mt-2 flex flex-col gap-1.5">
            {rankedDims.map(d => <ImpactDimRow key={d.column} d={d} config={config} openColumn={openColumn} />)}
          </ul>
          <ImpactWarning config={config} outlierDim={outlierDim} rawOnly={estimate.rawOnly} openColumn={openColumn} />
        </div>
      )}
    </>
  );
}

/** Cost/benefit summary for the current enabled grain (rollup design §8).
 *  Updates as dims are toggled so the user can weigh the rebuild before it
 *  happens. Numbers are directional (probed from one recent month). */
function RollupImpactPanel({ estimate, loading, stale, error, config, openColumn }: Readonly<{ estimate: RollupGrainEstimate | null; loading: boolean; stale: boolean; error: boolean; config: DimensionsConfig; openColumn: ColumnOpener }>): React.JSX.Element {
  const rankedDims = estimate === null
    ? []
    : [...estimate.dims].sort((a, b) => b.marginalMultiplier - a.marginalMultiplier);
  const outlierDim = rankedDims.find(d => d.outlier);
  // When the built rollup already matches this exact grain, show its ACTUAL
  // size/rows (the same numbers as the header Rollup popover) instead of the
  // directional estimate, and drop the Rebuild stat (nothing to rebuild).
  const matchedCurrent = estimate !== null && estimate.currentMatchesCandidate ? estimate.current : null;
  const rollupBytes = matchedCurrent === null ? (estimate?.candidate.bytes ?? 0) : matchedCurrent.bytes;
  const sizeReduction = estimate !== null && rollupBytes > 0 ? estimate.raw.bytes / rollupBytes : 0;
  const rowRatio = computeRowRatio(estimate, matchedCurrent);
  // When the probe has run and found no data on disk (probePeriod === ''), show
  // the sync hint even while stale/loading — toggling a dim on an un-synced
  // install must not flash the "Estimating…" spinner over the real "no data" state.
  const noData = estimate !== null && estimate.probePeriod.length === 0;
  const syncHint = <p className="mt-3 text-xs text-text-muted">Sync billing data to estimate the rollup size for this grain.</p>;
  const errorHint = <p className="mt-3 text-xs text-text-muted">Couldn’t estimate the rollup size for this grain — change a dimension to retry.</p>;
  // Branch order matters. `estimate === null` here means "not resolved yet" (the
  // panel only renders with a non-null config, and the probe always returns a
  // non-null estimate — empty when there's no data), so fold it into the loader
  // branch: that keeps EstimateProgress mounted across the debounce→fetch handoff
  // where `loading` lags the settled grain by one tick (otherwise that one frame
  // flashed a hint and remounted the bar, resetting its progress).
  //  - `stale || loading` wins over a leftover `error` so toggling after a failed
  //    probe shows "Estimating…", not the stale error.
  //  - a settled error (not stale/loading) shows a real error message, NOT the
  //    "sync billing data" hint — that would mislead a user who already has data.
  let body: React.JSX.Element;
  if (noData) {
    body = syncHint;
  } else if (estimate === null) {
    // Not resolved yet, or a terminal error. While loading/stale (or simply not
    // yet probed) show the bar; only a SETTLED error shows the error hint — so a
    // leftover error from a prior grain doesn't flash over the next "Estimating…".
    body = error && !stale && !loading ? errorHint : <EstimateProgress />;
  } else if (stale || loading) {
    // A non-null prior estimate is being re-probed for a changed grain.
    body = <EstimateProgress />;
  } else {
    body = (
      <ImpactDetails
        estimate={estimate}
        matchedCurrent={matchedCurrent}
        sizeReduction={sizeReduction}
        rowRatio={rowRatio}
        rankedDims={rankedDims}
        outlierDim={outlierDim}
        config={config}
        openColumn={openColumn}
      />
    );
  }
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/40 px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-text-muted" />
          <h3 className="text-sm font-medium text-text-secondary">Rollup impact</h3>
        </div>
        {!stale && estimate !== null && estimate.probePeriod.length > 0 && (
          matchedCurrent === null ? (
            <span
              title={`Directional estimate, probed from ${estimate.probePeriod}. Rebuild this grain to get exact numbers.`}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Estimated
            </span>
          ) : (
            <span
              title="These are the real size and row counts of the rollup already built for this grain."
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />Actual
            </span>
          )
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-text-muted">
        The rollup is a compact, pre-aggregated copy of your billing data grouped by these dimensions — dashboards query it instead of the raw line items, so a leaner grain keeps them fast.
      </p>

      {body}
    </div>
  );
}

function GripHandle({ attrs }: Readonly<{ attrs: React.HTMLAttributes<HTMLButtonElement> }>): React.JSX.Element {
  return (
    <button
      type="button"
      {...attrs}
      title="Drag to reorder"
      className="pointer-events-auto flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary cursor-grab active:cursor-grabbing"
    >
      <GripVertical size={16} />
    </button>
  );
}

/** A collapsed row of the enabled-dimensions list opens its editor from
 *  anywhere on the card: the open button's ::after covers the whole card (the
 *  card is `relative`), padding and "Built-in" label included. The reorder
 *  controls sit above that layer, and their wrapper lets a click between or
 *  beside them fall through to it. The card, not the button, shows the hover
 *  and press (`data-feedback="none"` drops the app-wide state layer, which
 *  would tint only the button's text column). */
const ROW_CARD_CLASS = 'scroll-mt-4 relative w-full rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between transition-colors hover:border-accent/40 hover:bg-bg-tertiary/60 has-[>button:active]:bg-bg-tertiary';
const ROW_OPEN_CLASS = "flex flex-col gap-1 text-left flex-1 min-w-0 cursor-pointer outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-accent";
const ROW_CONTROLS_CLASS = 'pointer-events-none relative z-10 flex items-center gap-3 shrink-0';

/** Marks, on the row a dragged one is over, the edge it will land on: a drop
 *  puts it above that row when it moves up the list and below it when it moves
 *  down (applyReorder). Green for up, blue for down. */
const DROP_ABOVE_SHADOW = 'inset 0 3px 0 var(--color-accent, #10b981)';
const DROP_BELOW_SHADOW = 'inset 0 -3px 0 #3b82f6';

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
    const idx = config.tags.findIndex(t => tagOrderKey(t) === key);
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

/** Every id lookup resolves to the first tag with an id, so a second tag with
 *  it (`cost_center` next to `cost-center`) would show the first one's data. */
function tagIdConflictMessage(candidate: TagDimension, owner: TagDimension): string {
  return `Can't save: ${describeTagSource(candidate)} maps to the same dimension id (${tagDimColumn(candidate)}) ` +
    `as ${describeTagSource(owner)}, used by "${owner.label}". Two dimensions can't share an id, so pick another ` +
    `source or remove "${owner.label}" first.`;
}

function tagIdCollisionMessage(owner: TagDimension, other: TagDimension, id: string): string {
  return `"${owner.label}" (${describeTagSource(owner)}) and "${other.label}" (${describeTagSource(other)}) ` +
    `share the dimension id ${id}, so both would show the data of "${owner.label}". ` +
    'Remove one of them to apply your changes.';
}

export function DimensionsView(): React.JSX.Element {
  const api = useCostApi();
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingBuiltInIdx, setEditingBuiltInIdx] = useState<number | null>(null);
  const [hiddenResourceCols, setHiddenResourceCols] = useState(new Set<string>());
  const [hiddenAccountCols, setHiddenAccountCols] = useState(new Set<string>());
  const [addingNew, setAddingNew] = useState(false);
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
  // Every opened editor scrolls up to the top of the page. The counter makes
  // a second request for the editor already open (a Rollup impact name)
  // scroll back to it.
  const [reveal, setReveal] = useState<{ key: string; seq: number } | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // Lazy-load the tag-discovery scan — it hits DuckDB. Fires when the user
  // opens Add Dimension (needs unmapped-tag suggestions), expands Resource
  // Tags, or edits a tag dim (TagEditor needs context for suggestions).
  const needsTagDiscovery = addingNew || resourceTagsExpanded || editingIdx !== null;
  const tagsQuery = useQuery(
    () => needsTagDiscovery ? api.discoverTagKeys() : Promise.resolve(null),
    [needsTagDiscovery],
  );
  const configQuery = useQuery(() => api.getDimensionsConfig(), []);
  const orgQuery = useQuery(() => api.getOrgSyncResult(), []);

  const tagsResult = tagsQuery.status === 'success' ? tagsQuery.data : null;
  const discoveredTags = tagsResult?.tags ?? [];

  // Draft-editing model: `config` is the working draft the user edits freely;
  // `savedConfig` is the last-persisted baseline. Edits stay LOCAL — toggling,
  // reordering, and the per-dim editors mutate only the draft, so the live
  // estimate and value previews update instantly while the expensive rollup
  // rebuild is deferred. Nothing persists (and so nothing re-rolls) until the
  // user clicks Apply, which writes the draft and lets the backend rebuild the
  // rollup for the new grain. Mirrors the draft/saved/dirty pattern in Cost Scope.
  const [config, setConfig] = useState<DimensionsConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<DimensionsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (configQuery.status !== 'success') return;
    const { config: migrated, changed } = migrateLocked(configQuery.data);
    // Normalize `order` up front so a toggle-on-then-off round-trips to a
    // byte-identical draft (no spurious dirty against the baseline).
    const baseline = { ...migrated, order: reconcileOrder(migrated) };
    setConfig(baseline);
    setSavedConfig(baseline);
    // A locked-dim migration is a correctness fix, not a user edit — persist it
    // immediately (matches the legacy behaviour) so the baseline is on disk.
    if (changed) api.saveDimensionsConfig(baseline).catch(() => undefined);
  }, [configQuery, api]);
  const orgData = orgQuery.status === 'success' ? orgQuery.data : null;

  // Draft is dirty when it diverges from the persisted baseline. Registers with
  // the app-wide unsaved-changes guard so navigating away prompts before the
  // in-progress draft is lost.
  const dirty = config !== null && savedConfig !== null && stableStringify(config) !== stableStringify(savedConfig);
  useUnsavedChanges(dirty, 'Dimensions');

  // Tags sharing a dimension id. The editors refuse to create one, but a
  // config loaded with one (the validator disabled the later tag) must be
  // resolved before it can be saved: the backend refuses it too.
  const idCollisions = config === null ? [] : findTagIdCollisions(config.tags);

  // Live rollup cost/benefit estimate for the current enabled grain. Keyed on
  // the grain signature so it refetches when a dim is toggled (the grain
  // changes) but not on reorder/relabel. The probe hits DuckDB, so this is
  // intentionally cheap and fire-and-forget.
  // Debounce the grain signature before probing: each dim toggle changes the
  // grain, and the probe is a heavy DuckDB scan (multi-second, multi-GB on real
  // data). Without this, dragging through several toggles fires a probe per
  // intermediate grain, stacking heavy queries against the worker pool. Wait for
  // the grain to settle (350 ms) so only the final grain is probed.
  const estimateCandidate = config === null ? null : withoutSourcelessTags(config);
  const estimateSig = estimateCandidate === null ? '' : grainSignature(estimateCandidate);
  const debouncedEstimateSig = useDebouncedValue(estimateSig, 350);
  const estimateQuery = useQuery(
    () => estimateCandidate === null ? Promise.resolve(null) : api.estimateRollupGrain(estimateCandidate),
    // Refetch ONLY when the (settled) draft grain changes. The estimate is a
    // pre-apply preview — it must NOT re-run when the rollup rebuilds. Applying
    // kicks off a re-roll, and re-probing on that transition would fire a heavy
    // DuckDB scan redundantly AND in contention with the rebuild it just started.
    // The actual/estimated badge therefore settles on the next grain change or a
    // remount, never mid-rebuild.
    [debouncedEstimateSig],
  );
  const estimate = estimateQuery.status === 'success' ? estimateQuery.data : null;
  const estimateLoading = estimateQuery.status === 'loading';
  // The grain changed but the (debounced) probe hasn't refired yet — the shown
  // estimate is for the previous grain. Surface the "Estimating…" cue instantly
  // (as it did before the debounce) for the 350 ms settle window so the panel
  // doesn't sit on the previous grain's numbers without a hint. (useQuery flips
  // to its own loading state one passive-effect tick after the window closes, so
  // a single handoff frame can still paint the prior estimate — acceptable.)
  const estimateStale = estimateSig !== debouncedEstimateSig;
  const rawOnlyColumns = new Set((estimate?.dims ?? []).filter(d => d.rawOnly).map(d => d.column));
  const cardinalityByColumn = new Map((estimate?.dims ?? []).map(d => [d.column, d.cardinality]));

  // Account tag keys from org sync
  const accountTagKeys = orgData === null
    ? []
    : [...new Set(orgData.accounts.flatMap(a => Object.keys(a.tags)))].sort((a, b) => a.localeCompare(b));

  // Which resource tags are already mapped as dimensions
  const mappedTagNames = new Set(
    (config?.tags ?? [])
      .map(t => t.tagName)
      .filter((n): n is string => n !== undefined && n.length > 0),
  );

  // Discovered resource tags for the primary dropdown — same order as table, exclude hidden columns
  const unmappedTagKeys = discoveredTags
    .map(t => t.key)
    .filter(k => !mappedTagNames.has(k) && !hiddenResourceCols.has(k));

  /** `original` (the tag being edited; undefined for a new one) with the fields
   *  the editor shows replaced by the editor's. The others — a description, a
   *  separator, a path segment on a source other than the OU Path — are kept
   *  as the config file has them: rebuilding the tag from the editor alone
   *  dropped them on every save. A field the editor cleared is written as
   *  undefined, which every reader treats as absent. */
  function editingToTagDimension(editing: EditingTag, original: TagDimension | undefined): TagDimension {
    return {
      ...original,
      label: editing.label,
      tagName: editing.tagName.length > 0 ? editing.tagName : undefined,
      concept: CONCEPTS.find(c => c.value === editing.concept)?.value,
      normalize: NORMALIZE_RULES.find(r => r.value === editing.normalize)?.value,
      aliases: textToAliases(editing.aliases),
      accountTagFallback: editing.fallbackTag !== undefined && editing.fallbackTag.length > 0 ? editing.fallbackTag : undefined,
      missingValueTemplate: editing.missingValueTemplate.length > 0 ? editing.missingValueTemplate : undefined,
      pathSegment: editedPathSegment(editing, original),
      defaultFilterValues: editing.defaultFilterValues.length > 0 ? [...editing.defaultFilterValues] : undefined,
    };
  }

  /** Refuses a tag whose dimension id another tag (other than the one at
   *  `skipIdx`, the tag being edited) already has. */
  function tagIdConflict(editing: EditingTag, skipIdx: number | null): string | null {
    if (config === null) return null;
    const candidate = editingToTagDimension(editing, skipIdx === null ? undefined : config.tags[skipIdx]);
    if (!hasTagSource(candidate)) return null;
    const id = tagDimColumn(candidate);
    const owner = config.tags.find((t, i) => i !== skipIdx && hasTagSource(t) && tagDimColumn(t) === id);
    return owner === undefined ? null : tagIdConflictMessage(candidate, owner);
  }

  function handleSaveTag(idx: number, editing: EditingTag): void {
    if (config === null || tagIdConflict(editing, idx) !== null) return;
    const tags = [...config.tags];
    tags[idx] = editingToTagDimension(editing, config.tags[idx]);
    setConfig({ ...config, tags, order: reconcileOrder({ ...config, tags }) });
    setEditingIdx(null);
  }

  function handleAddTag(editing: EditingTag): void {
    if (config === null || tagIdConflict(editing, null) !== null) return;
    const newTag = editingToTagDimension(editing, undefined);
    const tags = [...config.tags, newTag];
    setConfig({ ...config, tags, order: reconcileOrder({ ...config, tags }) });
    setAddingNew(false);
  }

  function handleRemoveTag(idx: number): void {
    if (config === null) return;
    const tags = config.tags.filter((_, i) => i !== idx);
    setConfig({ ...config, tags, order: reconcileOrder({ ...config, tags }) });
    // The clash banner can remove a tag while another one's editor is open:
    // keep that editor (and its unsaved edits) on its tag, now one index down.
    setEditingIdx(cur => {
      if (cur === null || cur === idx) return null;
      return cur > idx ? cur - 1 : cur;
    });
  }

  function handleSaveBuiltIn(idx: number, edited: EditingBuiltIn): void {
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
        ...(edited.defaultFilterValues.length > 0 ? { defaultFilterValues: [...edited.defaultFilterValues] } : {}),
      };
    });
    setConfig({ ...config, builtIn, order: reconcileOrder({ ...config, builtIn }) });
    setEditingBuiltInIdx(null);
  }

  // Draft mutation: paint the change into the local draft only. No persistence
  // here — the estimate and value previews react to the draft, but the rollup
  // rebuild waits for Apply. `order` is reconciled so disabled dims drop out and
  // newly-enabled ones append, keeping the visible list and serialized order in sync.
  function applyDraft(next: DimensionsConfig): void {
    setConfig({ ...next, order: reconcileOrder(next) });
  }

  // Commit point: persist the draft. The backend save drops the old rollup and
  // rebuilds it for the new grain (debounced, in the background) — this is the
  // ONLY path that triggers a re-roll now. Exploring/editing the draft never does.
  async function confirmChanges(): Promise<void> {
    if (config === null || idCollisions.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveDimensionsConfig(config);
      setSavedConfig(config);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save dimensions');
    } finally {
      setSaving(false);
    }
  }

  function discardChanges(): void {
    setConfig(savedConfig);
    setSaveError(null);
    setEditingIdx(null);
    setEditingBuiltInIdx(null);
    setAddingNew(false);
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
    applyDraft({ ...config, builtIn });
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
    applyDraft({ ...config, tags });
  }

  /** Opens a row's editor (closing any other) and scrolls it up to the top. */
  function openRow(row: OrderedRow): void {
    setAddingNew(false);
    if (row.kind === 'builtIn') {
      setEditingBuiltInIdx(row.idx);
      setEditingIdx(null);
    } else {
      setEditingIdx(row.idx);
      setEditingBuiltInIdx(null);
    }
    setReveal(cur => ({ key: row.key, seq: (cur?.seq ?? 0) + 1 }));
  }

  /** Disables the dimension at `orderIdx` of the list from its open editor
   *  and opens the one after it, so a review can go through the list without
   *  scrolling back up to the pills; closes the editor after the last one. */
  function disableAndAdvance(orderIdx: number): void {
    if (config === null) return;
    const row = resolveOrderedRows(config)[orderIdx];
    if (row === undefined || (row.kind === 'builtIn' && LOCKED_DIMENSIONS.has(row.dim.name))) return;
    const next = row.kind === 'builtIn'
      ? { ...config, builtIn: config.builtIn.map((d, i) => (i === row.idx ? { ...d, enabled: false } : d)) }
      : { ...config, tags: config.tags.map((t, i) => (i === row.idx ? { ...t, enabled: false } : t)) };
    applyDraft(next);
    // The disabled row leaves the list, so the next one takes its place.
    const following = resolveOrderedRows(next)[orderIdx];
    if (following === undefined) {
      setEditingBuiltInIdx(null);
      setEditingIdx(null);
      setReveal(null);
      // The focused Disable button goes with the editor: keep the keyboard
      // user in the list rather than back at the top of the page.
      listHeadingRef.current?.focus({ preventScroll: true });
    } else {
      openRow(following);
    }
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
    applyDraft({ ...config, order });
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
          if (isOver && dragFrom !== null) return { boxShadow: dragFrom.orderIdx > orderIdx ? DROP_ABOVE_SHADOW : DROP_BELOW_SHADOW };
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
      <div className="pointer-events-auto flex flex-col -space-y-1">
        <button
          type="button"
          disabled={!canUp}
          onClick={(e) => { e.stopPropagation(); applyReorder(orderIdx, orderIdx - 1); }}
          title="Move up"
          className="flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          disabled={!canDown}
          onClick={(e) => { e.stopPropagation(); applyReorder(orderIdx, orderIdx + 1); }}
          title="Move down"
          className="flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }

  const orderedRows = config === null ? [] : resolveOrderedRows(config);

  const openerForColumn: ColumnOpener = (column) => {
    const key = config === null ? undefined : columnDimension(config, column)?.key;
    const row = orderedRows.find(r => r.key === key);
    return row === undefined ? undefined : () => { openRow(row); };
  };
  const revealSeqFor = (key: string): number => (reveal?.key === key ? reveal.seq : 0);
  const disableAction = (orderIdx: number): DisableAction => ({
    run: () => { disableAndAdvance(orderIdx); },
    next: orderedRows[orderIdx + 1]?.dim.label,
  });



  return (
    <div className="flex flex-col gap-8 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Dimensions</h2>
          <p className="text-sm text-text-secondary mt-1">Map tags to cost allocation dimensions</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-2">
            {dirty ? (
              <>
                <button
                  type="button"
                  onClick={discardChanges}
                  disabled={saving}
                  className="rounded-md px-4 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => { confirmChanges().catch(() => undefined); }}
                  disabled={saving || idCollisions.length > 0}
                  title={idCollisions.length > 0 ? 'Two dimensions share an id: remove one of them first' : 'Save these dimensions and rebuild the rollup for the new grain'}
                  className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-bg-primary hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {saving ? 'Applying…' : 'Apply & rebuild rollup'}
                </button>
              </>
            ) : (
              <span className="text-xs text-text-muted">Saved</span>
            )}
          </div>
          {dirty && (
            <span className="text-[11px] text-text-muted max-w-xs text-right">
              Previewing changes — the rollup rebuilds only when you apply.
            </span>
          )}
        </div>
      </div>

      {saveError !== null && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-negative/50 bg-negative-muted px-4 py-2.5">
          <p className="text-sm text-negative">Couldn’t apply your changes: {saveError}</p>
          <button
            type="button"
            onClick={() => { setSaveError(null); }}
            className="text-xs font-medium text-negative/80 hover:text-negative"
          >
            Dismiss
          </button>
        </div>
      )}

      {config !== null && idCollisions.length > 0 && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-negative/50 bg-negative-muted px-4 py-2.5">
          {idCollisions.map(({ id, ownerIndex, index }) => {
            const owner = config.tags[ownerIndex];
            const other = config.tags[index];
            if (owner === undefined || other === undefined) return null;
            return (
              <div key={`${String(ownerIndex)}:${String(index)}`} className="flex items-start justify-between gap-3">
                <p className="text-sm text-negative">{tagIdCollisionMessage(owner, other, id)}</p>
                <div className="flex shrink-0 gap-2">
                  {[{ i: ownerIndex, tag: owner }, { i: index, tag: other }].map(({ i, tag }) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { handleRemoveTag(i); }}
                      title={describeTagSource(tag)}
                      className="text-xs font-medium text-negative/80 hover:text-negative"
                    >
                      Remove "{tag.label}"
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* SECTION 1 — Available dimensions as toggleable pills. Two rows: the
          fixed set of built-ins, then the user-defined tag dims with an
          inline + Add pill at the end. */}
      {config !== null && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider">Built-in dimensions</h3>
            <div className="flex flex-wrap gap-1.5">
              {[...config.builtIn.entries()]
                .sort(([, a], [, b]) => {
                  const la = LOCKED_DIMENSIONS.has(a.name) ? 0 : 1;
                  const lb = LOCKED_DIMENSIONS.has(b.name) ? 0 : 1;
                  return la - lb;
                })
                .map(([idx, d]) => {
                const locked = LOCKED_DIMENSIONS.has(d.name);
                const isOn = locked || d.enabled !== false;
                const rawOnly = isOn && rawOnlyColumns.has(builtInGrainColumn(d));
                let buttonTitle = 'Click to enable';
                if (locked) buttonTitle = LOCKED_DIMENSION_NOTE;
                else if (isOn) buttonTitle = 'Click to disable';
                return (
                  <button
                    key={d.name}
                    type="button"
                    onClick={locked ? undefined : () => { toggleBuiltInEnabled(idx); }}
                    title={buttonTitle}
                    className={`${pillClass(isOn, rawOnly)}${locked ? ' cursor-default' : ''}`}
                  >
                    {locked && <Lock className="inline-block w-3 h-3 mr-1 -mt-0.5" />}
                    {d.label}
                    {rawOnly && <RawOnlyBadge cardinality={cardinalityByColumn.get(builtInGrainColumn(d))} />}
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
                const rawOnly = isOn && rawOnlyColumns.has(tagSqlColumn(tag));
                return (
                  <button
                    key={tagOrderKey(tag)}
                    type="button"
                    onClick={() => { toggleTagEnabled(idx); }}
                    title={isOn ? 'Click to disable' : 'Click to enable'}
                    className={pillClass(isOn, rawOnly)}
                  >
                    {tag.label}
                    {rawOnly && <RawOnlyBadge cardinality={cardinalityByColumn.get(tagSqlColumn(tag))} />}
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

          {/* Rollup cost/benefit for the current draft grain — updates live as
              pills are toggled so the user can weigh the rebuild before applying. */}
          <RollupImpactPanel estimate={estimate} loading={estimateLoading} stale={estimateStale} error={estimateQuery.status === 'error'} config={config} openColumn={openerForColumn} />

          {/* New-tag-dim form appears inline right after the pill rows so the
              user sees where the new pill will land. */}
          {addingNew && (
            <TagEditor
              tag={quickAddState ?? { tagName: '', label: '', concept: '', normalize: '', aliases: '', fallbackTag: undefined, missingValueTemplate: '', pathSegIndex: '', defaultFilterValues: [] }}
              onSave={(edited) => { handleAddTag(edited); }}
              onCancel={() => { setAddingNew(false); setQuickAddState(null); }}
              onRemove={undefined}
              onDisable={undefined}
              revealSeq={0}
              idConflict={(edited) => tagIdConflict(edited, null)}
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
          <h3 ref={listHeadingRef} tabIndex={-1} className="scroll-mt-4 text-sm font-medium text-text-secondary outline-none">
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
                        defaultFilterValues: d.defaultFilterValues ?? [],
                      },
                    }}
                    onSave={(edited) => { handleSaveBuiltIn(row.idx, edited); }}
                    onCancel={() => { setEditingBuiltInIdx(null); }}
                    onDisable={LOCKED_DIMENSIONS.has(d.name) ? undefined : disableAction(orderIdx)}
                    revealSeq={revealSeqFor(row.key)}
                    accountTagKeys={accountTagKeys}
                  />
                );
              }
              return (
                <div key={row.key} {...dnd.row} className={ROW_CARD_CLASS}>
                  <button type="button" data-feedback="none" data-opens-editor onClick={() => { openRow(row); }} className={ROW_OPEN_CLASS}>
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
                  <div className={ROW_CONTROLS_CLASS}>
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
                    tagName: tag.tagName ?? '',
                    label: tag.label,
                    concept: tag.concept ?? '',
                    normalize: tag.normalize ?? '',
                    aliases: aliasesToText(tag.aliases),
                    fallbackTag: tag.accountTagFallback,
                    missingValueTemplate: tag.missingValueTemplate ?? '',
                    pathSegIndex: tag.pathSegment === undefined ? '' : String(tag.pathSegment.index),
                    defaultFilterValues: tag.defaultFilterValues ?? [],
                  }}
                  onSave={(edited) => { handleSaveTag(row.idx, edited); }}
                  onCancel={() => { setEditingIdx(null); }}
                  onRemove={() => { handleRemoveTag(row.idx); }}
                  onDisable={disableAction(orderIdx)}
                  revealSeq={revealSeqFor(row.key)}
                  idConflict={(edited) => tagIdConflict(edited, row.idx)}
                  availableTags={unmappedTagKeys}
                  discoveredTags={discoveredTags}
                  accountTagKeys={accountTagKeys}
                  orgAccounts={orgData?.accounts ?? []}
                />
              );
            }
            return (
              <div key={row.key} {...dnd.row} className={ROW_CARD_CLASS}>
                <button type="button" data-feedback="none" data-opens-editor onClick={() => { openRow(row); }} className={ROW_OPEN_CLASS}>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-text-primary">{tag.label}</span>
                    {tag.tagName !== undefined && tag.tagName.length > 0 && (
                      <span className="text-xs text-text-muted font-mono">tag:{tag.tagName}</span>
                    )}
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
                      <span className="text-[10px] text-text-muted">
                        {tag.tagName === undefined || tag.tagName.length === 0 ? 'source' : 'fallback'}: {formatAccountSource(tag.accountTagFallback)}
                      </span>
                    )}
                    {tag.missingValueTemplate !== undefined && (
                      <span className="text-[10px] text-text-muted font-mono">missing: {tag.missingValueTemplate}</span>
                    )}
                    {tag.pathSegment !== undefined && (
                      <span className="text-[10px] text-text-muted font-mono">segment {String(tag.pathSegment.index)}</span>
                    )}
                  </div>
                  {tag.description !== undefined && tag.description.length > 0 && (
                    <span className="text-[11px] text-text-muted leading-snug">{tag.description}</span>
                  )}
                </button>
                <div className={ROW_CONTROLS_CLASS}>
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
              if (tagsQuery.status !== 'success' || tagsQuery.data === null) return 'Tag keys discovered by scanning the latest billing period';
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
