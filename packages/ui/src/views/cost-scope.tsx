import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  CostMetric,
  CostPerspective,
  CostScopeCapabilities,
  CostScopeConfig,
  CostScopeDailyRow,
  CostScopePreviewResult,
  CostScopePreviewRow,
  CostScopeSampleRow,
  ExclusionCondition,
  ExclusionRule,
  Dimension,
} from '@costgoblin/core/browser';
import { BUILTIN_EXCLUSION_RULES, COST_METRICS, DEFAULT_COST_SCOPE, asDimensionId } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useUnsavedChanges } from '../hooks/use-unsaved-changes.js';
import { formatDollars } from '../components/format.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';

const METRIC_LABELS: Record<CostMetric, { label: string; description: string }> = {
  unblended: {
    label: 'Unblended',
    description: 'Cost as billed each day. Upfront RI/SP fees land as a lump on their purchase day; RI/SP-covered usage shows the discounted rate. Default.',
  },
  blended: {
    label: 'Blended',
    description: 'Consolidated-billing rate — each linked account is charged the org-wide weighted average for the same usage type. Accounting construct for per-account comparisons; not what you actually pay.',
  },
  amortized: {
    label: 'Amortized',
    description: 'Spreads RI/SP purchases over the commitment term and uses effective cost for covered usage. Smooths the bursts in Unblended; best for run-rate and forecasting.',
  },
};

function formatExcluded(cost: number, rows: number): string {
  if (rows === 0 && cost === 0) return 'no data';
  return `${formatDollars(cost)} excluded · ${String(rows)} rows`;
}

interface PreviewState {
  result: CostScopePreviewResult | null;
  loading: boolean;
}

function dimIdFor(d: Dimension): string {
  return 'name' in d ? String(d.name) : `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

interface ConditionRowProps {
  condition: ExclusionCondition;
  dimensions: Dimension[];
  suggestions: readonly string[];
  onUpdate: (next: ExclusionCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
  invalid: boolean;
}

function ConditionRow({ condition, dimensions, suggestions, onUpdate, onRemove, canRemove, invalid }: ConditionRowProps) {
  const [valuesInput, setValuesInput] = useState(condition.values.join(', '));

  // Sync local input state when the condition prop changes externally (e.g.
  // a sibling condition was removed and array-index keys make React hand this
  // component a different condition at the same slot). Without this, the text
  // field shows stale values and the next blur would overwrite the underlying
  // condition with the wrong data.
  useEffect(() => {
    setValuesInput(condition.values.join(', '));
  }, [condition.values]);

  function handleDimChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const parsed = e.target.value.trim();
    if (parsed.length === 0) return;
    onUpdate({ dimensionId: asDimensionId(parsed), values: condition.values });
  }

  function commitValues() {
    const values = valuesInput.split(',').map(v => v.trim()).filter(v => v.length > 0);
    // Empty is valid local state (draft in-progress) — parent decides how to
    // treat it (disables save, skips preview). We still push the empty array
    // so the parent sees the latest user intent.
    onUpdate({ dimensionId: condition.dimensionId, values });
  }

  // Show ALL dims in the rule picker, not just `enabled !== false` ones.
  // `enabled=false` is a UX preference for hiding a dim from normal
  // group-by / filter pickers; exclusion rules should still be able to
  // target its column (critical for the built-ins that reference
  // line_item_type even when the user has hidden that dim). Disabled dims
  // get a "(hidden)" suffix so it's clear they're not in normal rotation.
  const currentDimId = String(condition.dimensionId);
  const inputBorder = invalid ? 'border-negative' : 'border-border';

  return (
    <div className="flex items-start gap-2">
      <select
        className="rounded border border-border bg-bg-secondary text-text-primary text-sm px-2 py-1 min-w-36"
        value={currentDimId}
        onChange={handleDimChange}
      >
        {currentDimId.length === 0 && <option value="">— pick dimension —</option>}
        {dimensions.map(d => {
          const id = dimIdFor(d);
          const hidden = d.enabled === false;
          return <option key={id} value={id}>{hidden ? `${d.label} (hidden)` : d.label}</option>;
        })}
      </select>
      <div className="flex-1 flex flex-col gap-1">
        <input
          className={`rounded border ${inputBorder} bg-bg-secondary text-text-primary text-sm px-2 py-1 w-full`}
          placeholder="Values (comma-separated)"
          value={valuesInput}
          onChange={e => { setValuesInput(e.target.value); }}
          onBlur={commitValues}
          list={`suggestions-${currentDimId}`}
        />
        {suggestions.length > 0 && (
          <datalist id={`suggestions-${currentDimId}`}>
            {suggestions.slice(0, 50).map(s => <option key={s} value={s} />)}
          </datalist>
        )}
      </div>
      {canRemove && (
        <button
          type="button"
          className="text-text-muted hover:text-negative text-sm px-1 py-1 rounded shrink-0"
          onClick={onRemove}
          title="Remove condition"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface RuleCardProps {
  rule: ExclusionRule;
  preview: CostScopePreviewRow | undefined;
  dimensions: Dimension[];
  suggestionsByDim: ReadonlyMap<string, readonly string[]>;
  onUpdate: (next: ExclusionRule) => void;
  onDelete: () => void;
}

/** For a built-in rule, returns the shipped seed version (name, description,
 *  conditions) so the UI can offer a "Reset" affordance when the user has
 *  drifted from it. Returns null for user rules. */
function seedForBuiltIn(rule: ExclusionRule): ExclusionRule | null {
  if (!rule.builtIn) return null;
  return BUILTIN_EXCLUSION_RULES.find(s => s.id === rule.id) ?? null;
}

/** True if any editable field of a built-in rule differs from its seed.
 *  `enabled` is deliberately excluded from the check — toggling a built-in
 *  on/off is expected, not a "drift" we want to offer resetting. */
function builtInDiverges(rule: ExclusionRule, seed: ExclusionRule): boolean {
  if (rule.name !== seed.name) return true;
  if ((rule.description ?? '') !== (seed.description ?? '')) return true;
  // Conditions: compare as JSON — the arrays are small and order-sensitive
  // by design (the UI preserves condition order on save).
  if (JSON.stringify(rule.conditions) !== JSON.stringify(seed.conditions)) return true;
  return false;
}

function RuleCard({ rule, preview, dimensions, suggestionsByDim, onUpdate, onDelete }: RuleCardProps) {
  const seed = seedForBuiltIn(rule);
  const diverged = seed !== null && builtInDiverges(rule, seed);

  function resetToSeed() {
    if (seed === null) return;
    // Preserve the user's enabled choice; everything else reverts.
    onUpdate({ ...seed, enabled: rule.enabled });
  }

  function setEnabled(enabled: boolean) {
    onUpdate({ ...rule, enabled });
  }

  function setName(name: string) {
    onUpdate({ ...rule, name });
  }

  function setDescription(description: string) {
    // Empty string collapses to undefined so the serializer omits the key
    // entirely — a YAML with `description:` and no value is noisier than
    // no key at all. Same treatment the validator gives it on load.
    onUpdate({
      ...rule,
      ...(description.length > 0 ? { description } : { description: undefined }),
    });
  }

  function updateCondition(index: number, next: ExclusionCondition) {
    const conditions = rule.conditions.map((c, i) => i === index ? next : c);
    onUpdate({ ...rule, conditions });
  }

  function removeCondition(index: number) {
    const conditions = rule.conditions.filter((_, i) => i !== index);
    if (conditions.length === 0) return;
    onUpdate({ ...rule, conditions });
  }

  function addCondition() {
    const firstDim = dimensions.find(d => d.enabled !== false);
    const dimId = firstDim !== undefined ? dimIdFor(firstDim) : 'service';
    onUpdate({
      ...rule,
      conditions: [...rule.conditions, { dimensionId: asDimensionId(dimId), values: [] }],
    });
  }

  const previewText = preview !== undefined
    ? formatExcluded(preview.excludedCost, preview.excludedRows)
    : '—';

  return (
    <Card className={`transition-opacity ${rule.enabled ? '' : 'opacity-60'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={rule.enabled}
            onClick={() => { setEnabled(!rule.enabled); }}
            className={[
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              rule.enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
                rule.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
              ].join(' ')}
            />
          </button>
          <input
            className="flex-1 bg-transparent font-semibold text-text-primary text-sm focus:outline-none border-b border-transparent focus:border-border"
            value={rule.name}
            onChange={e => { setName(e.target.value); }}
            placeholder="Rule name"
          />
          <span className="text-xs text-text-muted shrink-0">{previewText}</span>
          {!rule.builtIn && (
            <button
              type="button"
              className="text-text-muted hover:text-negative text-sm px-1 rounded shrink-0"
              onClick={onDelete}
              title="Delete rule"
            >
              Delete
            </button>
          )}
          {rule.builtIn && (
            <div className="flex items-center gap-2 shrink-0">
              {diverged && (
                <button
                  type="button"
                  className="text-xs text-text-muted hover:text-text-primary underline decoration-dotted"
                  onClick={resetToSeed}
                  title="Restore this rule's name, description, and conditions to the shipped defaults. Your enable/disable choice is kept."
                >
                  Reset
                </button>
              )}
              <span className="text-xs text-text-muted px-1" title="Built-in rules can be disabled but not deleted">
                built-in
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <textarea
          className="w-full rounded border border-border bg-bg-secondary text-text-muted text-xs px-2 py-1 resize-y min-h-[2rem] focus:outline-none focus:border-accent/50"
          placeholder="Optional description — what this rule excludes and why."
          value={rule.description ?? ''}
          onChange={e => { setDescription(e.target.value); }}
          rows={Math.max(2, Math.min(5, Math.ceil((rule.description ?? '').length / 80) + 1))}
        />
        <div className="text-xs font-medium text-text-secondary mb-1">Conditions (AND)</div>
        <div className="space-y-2">
          {rule.conditions.map((cond, i) => (
            <ConditionRow
              key={i}
              condition={cond}
              dimensions={dimensions}
              suggestions={suggestionsByDim.get(String(cond.dimensionId)) ?? []}
              onUpdate={next => { updateCondition(i, next); }}
              onRemove={() => { removeCondition(i); }}
              canRemove={rule.conditions.length > 1}
              invalid={rule.enabled && cond.values.length === 0}
            />
          ))}
        </div>
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text-primary mt-1"
          onClick={addCondition}
        >
          + Add condition
        </button>
      </CardContent>
    </Card>
  );
}

interface PreviewHistogramProps {
  readonly days: readonly CostScopeDailyRow[];
  readonly loading: boolean;
  readonly hasResult: boolean;
  readonly height?: number;
}

/** Compact stacked bar chart for the Cost Scope preview. Each day shows
 *  `kept` (solid accent) over `excluded` (muted). Purpose-built rather than
 *  reusing the dashboard's StackedBarChart because that component is tied
 *  to the Groups/Products/Services tab model. */
function PreviewHistogram({ days, loading, hasResult, height = 120 }: PreviewHistogramProps) {
  if (loading && !hasResult) {
    // Initial load — show an explicit label so tests / users can tell
    // "loading" apart from "no data". Once a result arrives we keep
    // rendering it even while the next debounce is in-flight (below).
    return (
      <div
        data-testid="preview-histogram-loading"
        className="h-[120px] flex items-center justify-center text-xs text-text-muted"
      >
        Loading preview…
      </div>
    );
  }
  const maxTotal = days.reduce((m, d) => Math.max(m, d.keptCost + d.excludedCost), 0);
  if (days.length === 0 || maxTotal === 0) {
    return (
      <div
        data-testid="preview-histogram-empty"
        className="h-[120px] flex items-center justify-center text-xs text-text-muted"
      >
        No data in the last 30 days.
      </div>
    );
  }
  // Render as flex-bars so we don't have to measure container width — each
  // day takes an equal share, heights are proportional to maxTotal.
  return (
    <div className="flex items-end gap-px" style={{ height }}>
      {days.map(d => {
        const total = d.keptCost + d.excludedCost;
        const totalPct = (total / maxTotal) * 100;
        const keptPct = total > 0 ? (d.keptCost / total) * 100 : 0;
        return (
          <div
            key={d.date}
            className="flex-1 flex flex-col justify-end min-w-0 group relative"
            style={{ height: '100%' }}
            title={`${d.date}\nkept: ${formatDollars(d.keptCost)}\nexcluded: ${formatDollars(d.excludedCost)}`}
          >
            <div className="flex flex-col" style={{ height: `${String(totalPct)}%` }}>
              <div className="bg-negative/40 w-full" style={{ height: `${String(100 - keptPct)}%` }} />
              <div className="bg-accent w-full" style={{ height: `${String(keptPct)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface SampleRowsTableProps {
  readonly rows: readonly CostScopeSampleRow[];
  readonly tagColumns: readonly { readonly id: string; readonly label: string }[];
  readonly totalRowCount: number;
  readonly hasEnabledRules: boolean;
  readonly loading: boolean;
  readonly hasResult: boolean;
}

/** Signed-dollar formatter — keeps the sign so credits/refunds read as
 *  clearly negative rather than showing as absolute dollars. */
function formatSignedDollars(n: number): string {
  if (n < 0) return `-${formatDollars(-n)}`;
  return formatDollars(n);
}

/** Dense inspection table: raw line items in the preview window, sorted
 *  by absolute cost so the largest charges and the largest credits/refunds
 *  sit at the top. Horizontal scroll + sticky header + vertical scroll;
 *  rendered as a plain table rather than TanStack because sort/pagination
 *  are server-side and there's no interaction beyond "look". */
function SampleRowsTable({ rows, tagColumns, totalRowCount, hasEnabledRules, loading, hasResult }: SampleRowsTableProps): React.JSX.Element {
  // Default on: most of the time the user wants to inspect what made it
  // *into* scope, not what was carved out. The handler returns up to N
  // kept + N excluded so flipping this off still shows something useful.
  const [hideExcluded, setHideExcluded] = useState(true);

  if (loading && !hasResult) {
    return (
      <div data-testid="preview-table-loading" className="text-xs text-text-muted py-4 text-center">
        Loading preview…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div data-testid="preview-table-empty" className="text-xs text-text-muted py-4 text-center">
        No line items in the window — sync data to populate.
      </div>
    );
  }
  const keptCount = rows.length - rows.filter(r => r.excluded).length;
  // If the user has "Hide excluded" on but every sampled row is excluded,
  // the table body would render empty with no hint why. Flip the toggle
  // implicitly (on the display only) by falling back to showing
  // excluded rows with a callout, so the table is never blank when we
  // know there IS data.
  const showEmptyKeptBanner = hideExcluded && keptCount === 0;

  // When hiding excluded, drop client-side — the handler returns top-N
  // of each bucket (kept + excluded) so flipping shows rows instantly
  // without a re-query. Fall back to excluded rows if kept is empty
  // (showEmptyKeptBanner) so the table is never blank.
  const visibleRows = hideExcluded && keptCount > 0
    ? rows.filter(r => !r.excluded)
    : rows;
  const keptInSample = rows.length - rows.filter(r => r.excluded).length;
  const excludedInSample = rows.filter(r => r.excluded).length;
  const showing = visibleRows.length;

  return (
    <div className="space-y-2">
      {showEmptyKeptBanner && (
        <div className="rounded-md border border-warning/40 bg-warning/5 text-xs text-text-secondary px-3 py-2">
          Every row in the top-{String(rows.length)} sample is excluded by the
          active rules — showing excluded rows so the table isn't blank.
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-text-muted gap-4">
        <span className="min-w-0">
          Top <span className="text-text-secondary tabular-nums">{showing.toLocaleString()}</span>
          {' '}rows
          {hideExcluded && excludedInSample > 0 && (
            <> (<span className="tabular-nums">{excludedInSample.toLocaleString()}</span> excluded hidden)</>
          )}
          {!hideExcluded && excludedInSample > 0 && keptInSample > 0 && (
            <> (<span className="tabular-nums">{keptInSample.toLocaleString()}</span> kept + <span className="tabular-nums">{excludedInSample.toLocaleString()}</span> excluded)</>
          )}
          {totalRowCount > rows.length && (
            <> of <span className="text-text-secondary tabular-nums">{totalRowCount.toLocaleString()}</span> in window</>
          )}
          , sorted by |cost| desc.
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {hasEnabledRules && excludedInSample > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none hover:text-text-secondary">
              <input
                type="checkbox"
                className="accent-accent"
                checked={hideExcluded}
                onChange={e => { setHideExcluded(e.target.checked); }}
              />
              Hide excluded
            </label>
          )}
          {hasEnabledRules && !hideExcluded && (
            <span>
              <span className="inline-block w-2 h-2 rounded-sm bg-negative/40 mr-1 align-middle" />
              excluded
            </span>
          )}
        </span>
      </div>
      <div className="border border-border rounded-md overflow-auto max-h-[480px]">
        <table className="text-[11px] w-full border-collapse">
          {/* Column order prioritises what the user is scanning for:
              Date → Cost → List (the two $$ fields sit together and stay on
              screen without horizontal scroll) → Service & Account (the
              two main "who/what" anchors) → Line type → then the long-tail
              metadata (region, family, usage type, operation, usage,
              tags, resource id, description) */}
          <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
            <tr className="text-left text-text-secondary">
              <Th>Date</Th>
              <Th align="right">Cost</Th>
              <Th align="right">List</Th>
              <Th>Service</Th>
              <Th>Account</Th>
              <Th>Line type</Th>
              <Th>Region</Th>
              <Th>Family</Th>
              <Th>Usage type</Th>
              <Th>Operation</Th>
              <Th align="right">Usage</Th>
              {tagColumns.map(t => <Th key={t.id}>{t.label}</Th>)}
              <Th>Resource</Th>
              <Th>Description</Th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => (
              <tr
                key={`${String(i)}-${r.resourceId}`}
                className={`border-t border-border/40 ${r.excluded ? 'bg-negative/5 text-text-muted' : 'hover:bg-bg-tertiary/30'}`}
              >
                <Td mono>{r.date}</Td>
                <Td align="right" mono className={r.cost < 0 ? 'text-warning' : ''}>{formatSignedDollars(r.cost)}</Td>
                <Td align="right" mono>{formatSignedDollars(r.listCost)}</Td>
                <Td>{r.service}</Td>
                <Td title={r.accountId}>{r.accountName.length > 0 ? r.accountName : r.accountId}</Td>
                <Td>{r.lineItemType}</Td>
                <Td mono>{r.region}</Td>
                <Td>{r.serviceFamily}</Td>
                <Td mono>{r.usageType}</Td>
                <Td>{r.operation}</Td>
                <Td align="right" mono>{r.usageAmount === 0 ? '' : r.usageAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</Td>
                {tagColumns.map(t => <Td key={t.id}>{r.tags[t.id] ?? ''}</Td>)}
                <Td mono truncate title={r.resourceId}>{r.resourceId}</Td>
                <Td truncate title={r.description}>{r.description}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }): React.JSX.Element {
  return <th className={`px-2 py-1.5 font-medium whitespace-nowrap ${align === 'right' ? 'text-right' : ''}`}>{children}</th>;
}

function Td({ children, align = 'left', mono, truncate, className, title }: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  truncate?: boolean;
  className?: string;
  title?: string;
}): React.JSX.Element {
  const classes = [
    'px-2 py-1 whitespace-nowrap',
    align === 'right' ? 'text-right' : '',
    mono === true ? 'tabular-nums font-mono' : '',
    truncate === true ? 'max-w-[260px] overflow-hidden text-ellipsis' : '',
    className ?? '',
  ].filter(c => c.length > 0).join(' ');
  return <td className={classes} title={title}>{children}</td>;
}

/** A draft is saveable iff every enabled rule has at least one condition and
 *  every condition has at least one value. Disabled rules can hold empty
 *  conditions without blocking saves — they're effectively draft scaffolding.
 *  The validator on the main-process side enforces the same shape, so we
 *  mirror it here to surface the check as UI affordance rather than a silent
 *  IPC rejection. */
function describeDraftError(draft: CostScopeConfig): string | null {
  for (const rule of draft.rules) {
    if (!rule.enabled) continue;
    if (rule.conditions.length === 0) {
      return `Rule '${rule.name}' has no conditions.`;
    }
    for (const cond of rule.conditions) {
      if (cond.values.length === 0) {
        return `Rule '${rule.name}' has a condition with no values — fill in the values field or disable the rule.`;
      }
    }
  }
  return null;
}

export function CostScopeView(): React.JSX.Element {
  const api = useCostApi();
  const [draft, setDraft] = useState(DEFAULT_COST_SCOPE);
  const [saved, setSaved] = useState(DEFAULT_COST_SCOPE);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ result: null, loading: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [suggestionsByDim, setSuggestionsByDim] = useState(new Map<string, readonly string[]>());
  const [capabilities, setCapabilities] = useState<CostScopeCapabilities | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const draftError = describeDraftError(draft);
  const canSave = dirty && draftError === null && !saving;
  useUnsavedChanges(dirty, 'Cost Scope');

  useEffect(() => {
    void api.getCostScope().then(cfg => {
      setDraft(cfg);
      setSaved(cfg);
    });
    void api.getDimensions().then(setDimensions);
    void api.getCostScopeCapabilities().then(setCapabilities).catch(() => {
      // capabilities are advisory — if the probe fails, assume
      // everything is present (matches legacy behaviour).
      setCapabilities({ hasEffectiveCostColumns: true, hasBlendedColumn: true, hasNetColumns: true });
    });
  }, [api]);

  // Pre-fetch filter-value suggestions once per enabled dim so every
  // ConditionRow's datalist shares a single IPC round-trip. Without this,
  // every condition row fires its own identical fetch on mount.
  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      const enabled = dimensions.filter(d => d.enabled !== false);
      const next = new Map<string, readonly string[]>();
      await Promise.all(enabled.map(async d => {
        const id = dimIdFor(d);
        try {
          // bypassCostScope: users composing an exclusion rule need to
          // see every value a dim can take, including ones the saved
          // cost-scope rules already exclude. Otherwise once Tax is
          // excluded globally, the autocomplete in a new rule can't
          // suggest 'Tax' for them to add to a second rule.
          const vals = await api.getFilterValues(id, {}, undefined, { bypassCostScope: true });
          next.set(id, vals.map(v => v.value));
        } catch {
          next.set(id, []);
        }
      }));
      if (!cancelled) setSuggestionsByDim(next);
    }
    if (dimensions.length > 0) void run();
    return () => { cancelled = true; };
  }, [api, dimensions]);

  const refreshPreview = useCallback((config: CostScopeConfig) => {
    setPreview(p => ({ ...p, loading: true }));
    void api.previewCostScope(config)
      .then(result => { setPreview({ result, loading: false }); })
      .catch(() => { setPreview({ result: null, loading: false }); });
  }, [api]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    // Skip preview for drafts the main-process validator would reject — those
    // IPC calls always fail and would blank the preview, making the user
    // think the numbers dropped to zero while they were mid-edit.
    if (describeDraftError(draft) !== null) {
      setPreview({ result: null, loading: false });
      return;
    }
    debounceRef.current = setTimeout(() => { refreshPreview(draft); }, 300);
    return () => { clearTimeout(debounceRef.current); };
  }, [draft, refreshPreview]);

  function updateDraft(next: CostScopeConfig) {
    setDraft(next);
    setSaveError(null);
  }

  function handleMetricChange(metric: CostMetric) {
    updateDraft({ ...draft, costMetric: metric });
  }

  function handlePerspectiveChange(perspective: CostPerspective) {
    // Rebuild the config without `costPerspective` when the user picks
    // the default ('gross') so the serializer writes clean YAML.
    // exactOptionalPropertyTypes forbids writing `undefined`, so we
    // enumerate the retained fields instead of spreading + overwriting.
    const base: CostScopeConfig = { costMetric: draft.costMetric, rules: draft.rules };
    updateDraft(perspective === 'gross' ? base : { ...base, costPerspective: perspective });
  }

  function updateRule(index: number, next: ExclusionRule) {
    const rules = draft.rules.map((r, i) => i === index ? next : r);
    updateDraft({ ...draft, rules });
  }

  function deleteRule(index: number) {
    const rules = draft.rules.filter((_, i) => i !== index);
    updateDraft({ ...draft, rules });
  }

  function addRule() {
    const firstDim = dimensions.find(d => d.enabled !== false);
    const dimId = firstDim !== undefined ? dimIdFor(firstDim) : 'service';
    // New rules start disabled: they have empty `values` by default, which
    // fails validation — shipping them enabled by default would instantly
    // block saves and blank the preview until the user fills the field in.
    const newRule: ExclusionRule = {
      id: `user:${crypto.randomUUID()}`,
      name: 'New rule',
      enabled: false,
      builtIn: false,
      conditions: [{ dimensionId: asDimensionId(dimId), values: [] }],
    };
    updateDraft({ ...draft, rules: [...draft.rules, newRule] });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveCostScope(draft);
      setSaved(draft);
      refreshPreview(draft);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(saved);
    setSaveError(null);
  }

  const enabledRules = draft.rules.filter(r => r.enabled);
  const combinedText = preview.result !== null
    ? formatExcluded(preview.result.combined.excludedCost, preview.result.combined.excludedRows)
    : preview.loading ? 'loading…' : 'no data';

  function getPreviewRow(ruleId: string): CostScopePreviewRow | undefined {
    return preview.result?.perRule.find(p => p.ruleId === ruleId);
  }

  const preview_ = (
    <PreviewPanel
      preview={preview}
      loading={preview.loading}
      combinedText={combinedText}
      metric={draft.costMetric}
      hasEnabledRules={enabledRules.length > 0}
    />
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Header — full width above the two-column grid so Save/Cancel
          stay easy to reach regardless of scroll position. */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Cost Scope</h1>
          <p className="text-sm text-text-muted mt-1">
            Define what counts as cost: pick the cost metric and exclude polluting line items from all queries.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-xs text-text-muted hover:text-text-secondary"
              onClick={() => { void api.revealCostScopeFolder(); }}
            >
              Reveal YAML
            </button>
            {dirty && (
              <>
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={() => { void handleSave(); }}
                  disabled={!canSave}
                  title={draftError ?? undefined}
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
            {!dirty && <span className="text-xs text-text-muted">Saved</span>}
          </div>
          {(saveError !== null || draftError !== null) && (
            <span className="text-xs text-negative max-w-sm text-right">
              {saveError ?? draftError}
            </span>
          )}
        </div>
      </div>

      {/* Two-column grid on wide screens: config on the left (metric + rules),
          sticky Preview floating on the right so the user always sees the
          effect of a toggle without scrolling. On narrow screens the grid
          collapses to a single column — `order` keeps the preview ABOVE
          the rules there so it's still the first thing in the viewport,
          without rendering the component twice in the DOM. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-6 items-start">
        <div className="space-y-6 min-w-0 order-2 lg:order-1">
          {/* Cost metric */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cost metric</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {COST_METRICS.map(metric => (
                <label key={metric} className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="radio"
                    name="costMetric"
                    value={metric}
                    checked={draft.costMetric === metric}
                    onChange={() => { handleMetricChange(metric); }}
                    className="mt-0.5 accent-accent"
                  />
                  <div>
                    <span className="text-sm font-medium text-text-primary">{METRIC_LABELS[metric].label}</span>
                    <span className="ml-2 text-xs text-text-muted">{METRIC_LABELS[metric].description}</span>
                    {metric === 'amortized' && capabilities !== null && !capabilities.hasEffectiveCostColumns && (
                      <div className="mt-1 text-xs text-warning">
                        Degraded → falls back to Unblended because your CUR export doesn't include
                        <code className="mx-1 text-[11px]">reservation_effective_cost</code>
                        /
                        <code className="mx-1 text-[11px]">savings_plan_savings_plan_effective_cost</code>.
                        Enable <em>Include Resource IDs</em> on your CUR report in AWS Billing to get
                        an accurate amortized view (takes one billing cycle to land).
                      </div>
                    )}
                    {metric === 'blended' && capabilities !== null && !capabilities.hasBlendedColumn && (
                      <div className="mt-1 text-xs text-warning">
                        Degraded → falls back to Unblended because your CUR export doesn't include
                        <code className="mx-1 text-[11px]">line_item_blended_cost</code>.
                      </div>
                    )}
                  </div>
                </label>
              ))}

              {/* Gross vs Net toggle — orthogonal to the metric axis.
                  Disabled when the net columns aren't available, with a
                  warning explaining the CUR-side fix. */}
              <div className="pt-2 mt-2 border-t border-border">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Perspective</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      Net applies credits, refunds, and promotional discounts on top of the chosen metric.
                    </div>
                  </div>
                  <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-0.5 shrink-0">
                    {(['gross', 'net'] as const).map(perspective => {
                      const disabled = perspective === 'net' && capabilities !== null && !capabilities.hasNetColumns;
                      const active = (draft.costPerspective ?? 'gross') === perspective;
                      return (
                        <button
                          key={perspective}
                          type="button"
                          disabled={disabled}
                          onClick={() => { handlePerspectiveChange(perspective); }}
                          className={[
                            'px-3 py-1 text-xs rounded-md transition-colors capitalize',
                            active ? 'bg-accent text-bg-primary' : 'text-text-secondary hover:text-text-primary',
                            disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                          ].join(' ')}
                          title={disabled ? 'Requires line_item_net_unblended_cost — enable "Include Net Columns" on the CUR report.' : undefined}
                        >
                          {perspective}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(draft.costPerspective ?? 'gross') === 'net' && capabilities !== null && !capabilities.hasNetColumns && (
                  <div className="mt-2 text-xs text-warning">
                    Degraded → falls back to Gross because your CUR export doesn't include
                    <code className="mx-1 text-[11px]">line_item_net_unblended_cost</code>.
                    Enable <em>Include Net Columns</em> on your CUR report in AWS Billing.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Exclusion rules */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-text-primary">Exclusion rules</h2>
                <p className="text-xs text-text-muted mt-0.5">Rows matching any enabled rule are excluded from every query.</p>
              </div>
              <Button variant="outline" size="sm" onClick={addRule}>Add rule</Button>
            </div>

            {draft.rules.length === 0 && (
              <p className="text-sm text-text-muted py-4 text-center">No rules defined.</p>
            )}

            {draft.rules.map((rule, i) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                preview={getPreviewRow(rule.id)}
                dimensions={dimensions}
                suggestionsByDim={suggestionsByDim}
                onUpdate={next => { updateRule(i, next); }}
                onDelete={() => { deleteRule(i); }}
              />
            ))}
          </div>
        </div>

        {/* Sticky preview — on lg+ floats as a sidebar; on narrow screens
            `order-1` puts it above the rules in the stacked layout. top-24
            clears the app's sticky nav bar (h-10 title + ~34px button row +
            pb-2 padding ≈ 82px); max-h bounds the panel. */}
        <aside className="order-1 lg:order-2 lg:sticky lg:top-24 lg:self-start lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
          {preview_}
        </aside>
      </div>

      {/* Line items — full-width card below so the ~14-col table keeps its
          horizontal budget. Separate card lets the sticky preview above
          stay compact. */}
      <LineItemsCard preview={preview} loading={preview.loading} hasEnabledRules={enabledRules.length > 0} />
    </div>
  );
}

interface PreviewPanelProps {
  readonly preview: PreviewState;
  readonly loading: boolean;
  readonly combinedText: string;
  readonly metric: CostMetric;
  readonly hasEnabledRules: boolean;
}

/** Compact "always-visible" preview rendered in the sticky right column on
 *  wide screens, and inline (full width) on narrow screens. Holds the
 *  summary tiles + histogram — just enough to see the effect of rule
 *  toggles while scrolling through a long rules list. The detailed line-
 *  items table lives in its own full-width card below. */
function PreviewPanel({ preview, loading, combinedText, metric, hasEnabledRules }: PreviewPanelProps): React.JSX.Element {
  const result = preview.result;
  const metricLabel = METRIC_LABELS[metric].label;
  const excludedPct = useMemo(() => {
    if (result === null || result.unscopedTotalCost <= 0) return 0;
    return ((result.unscopedTotalCost - result.scopedTotalCost) / result.unscopedTotalCost) * 100;
  }, [result]);

  // The handler returns a zero-filled result when there are no periods on
  // disk — showing "$0.00 · 0.0% excluded" in that state looks like a
  // real answer. Collapse both "no result yet" and "handler returned
  // zeros" into a single "no data" rendering that matches the histogram.
  const hasData = result !== null && result.dailyTotals.length > 0;
  const placeholder = loading ? '…' : '—';

  return (
    <Card data-testid="cost-scope-preview" className="shadow-lg @container">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Preview</CardTitle>
          <span className="text-xs text-text-muted">
            Last 30 days · {metricLabel}
            {loading && (
              <>
                {' · '}
                <span data-testid="preview-loading" className="text-accent">loading…</span>
              </>
            )}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary tiles — single column on narrow container (sticky right
            panel is ~400px wide), expand to 3 cols when there's room. */}
        <div className="grid grid-cols-1 @md:grid-cols-3 gap-2">
          <SummaryTile
            label="Unscoped total"
            value={hasData ? formatDollars(result.unscopedTotalCost) : placeholder}
            hint={`Raw ${metricLabel.toLowerCase()} over the window`}
          />
          <SummaryTile
            label="After scope"
            value={hasData ? formatDollars(result.scopedTotalCost) : placeholder}
            hint={!hasData ? '' : hasEnabledRules ? `${excludedPct.toFixed(1)}% excluded` : 'No rules enabled'}
            emphasis
          />
          <SummaryTile
            label="Excluded"
            value={hasData && hasEnabledRules ? combinedText : placeholder}
            hint={!hasData ? '' : hasEnabledRules ? 'Union of enabled rules' : 'Toggle a rule'}
          />
        </div>

        {/* Histogram */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary">Daily cost</span>
            <div className="flex items-center gap-3 text-xs text-text-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent inline-block" /> kept</span>
              {hasEnabledRules && (
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-negative/40 inline-block" /> excluded</span>
              )}
            </div>
          </div>
          <PreviewHistogram
            days={result?.dailyTotals ?? []}
            loading={loading}
            hasResult={result !== null}
          />
          {result !== null && result.dailyTotals.length > 0 && (
            <div className="flex justify-between text-[10px] text-text-muted mt-1">
              <span>{result.startDate}</span>
              <span>{result.endDate}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface LineItemsCardProps {
  readonly preview: PreviewState;
  readonly loading: boolean;
  readonly hasEnabledRules: boolean;
}

/** Full-width card holding the raw line-items inspection table. Separated
 *  from PreviewPanel so the sticky summary stays compact and this stays
 *  wide enough to show the ~14-column table without horizontal scroll. */
function LineItemsCard({ preview, loading, hasEnabledRules }: LineItemsCardProps): React.JSX.Element {
  const result = preview.result;
  return (
    <Card data-testid="cost-scope-line-items">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Line items</CardTitle>
      </CardHeader>
      <CardContent>
        <SampleRowsTable
          rows={result?.sampleRows ?? []}
          tagColumns={result?.tagColumns ?? []}
          totalRowCount={result?.sampleTotalRowCount ?? 0}
          hasEnabledRules={hasEnabledRules}
          loading={loading}
          hasResult={result !== null}
        />
      </CardContent>
    </Card>
  );
}

function SummaryTile({ label, value, hint, emphasis }: { label: string; value: string; hint: string; emphasis?: boolean }): React.JSX.Element {
  return (
    <div className={`rounded-md border border-border px-3 py-2 ${emphasis ? 'bg-bg-tertiary/40' : 'bg-bg-secondary/60'}`}>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${emphasis ? 'text-text-primary' : 'text-text-secondary'}`}>{value}</div>
      <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>
    </div>
  );
}
