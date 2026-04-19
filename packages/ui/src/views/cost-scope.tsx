import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  CostMetric,
  CostScopeConfig,
  CostScopeDailyRow,
  CostScopePreviewResult,
  ExclusionCondition,
  ExclusionRule,
  Dimension,
} from '@costgoblin/core/browser';
import { COST_METRICS, DEFAULT_COST_SCOPE, asDimensionId } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
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

  const enabledDims = dimensions.filter(d => d.enabled !== false);
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
        {enabledDims.map(d => {
          const id = dimIdFor(d);
          return <option key={id} value={id}>{d.label}</option>;
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

interface CostScopePreviewRow {
  ruleId: string;
  excludedCost: number;
  excludedRows: number;
}

function RuleCard({ rule, preview, dimensions, suggestionsByDim, onUpdate, onDelete }: RuleCardProps) {
  function setEnabled(enabled: boolean) {
    onUpdate({ ...rule, enabled });
  }

  function setName(name: string) {
    onUpdate({ ...rule, name });
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
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${rule.enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
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
            <span className="text-xs text-text-muted shrink-0 px-1" title="Built-in rules can be disabled but not deleted">
              built-in
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {rule.description !== undefined && rule.description.length > 0 && (
          <p className="text-xs text-text-muted">{rule.description}</p>
        )}
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
  readonly height?: number;
}

/** Compact stacked bar chart for the Cost Scope preview. Each day shows
 *  `kept` (solid accent) over `excluded` (muted). Purpose-built rather than
 *  reusing the dashboard's StackedBarChart because that component is tied
 *  to the Groups/Products/Services tab model. */
function PreviewHistogram({ days, height = 120 }: PreviewHistogramProps) {
  const maxTotal = days.reduce((m, d) => Math.max(m, d.keptCost + d.excludedCost), 0);
  if (days.length === 0 || maxTotal === 0) {
    return (
      <div className="h-[120px] flex items-center justify-center text-xs text-text-muted">
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const draftError = describeDraftError(draft);
  const canSave = dirty && draftError === null && !saving;

  useEffect(() => {
    void api.getCostScope().then(cfg => {
      setDraft(cfg);
      setSaved(cfg);
    });
    void api.getDimensions().then(setDimensions);
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
          const vals = await api.getFilterValues(id, {});
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

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
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
              </div>
            </label>
          ))}
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

      {/* Preview */}
      <PreviewPanel preview={preview} loading={preview.loading} combinedText={combinedText} metric={draft.costMetric} hasEnabledRules={enabledRules.length > 0} />
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

function PreviewPanel({ preview, loading, combinedText, metric, hasEnabledRules }: PreviewPanelProps): React.JSX.Element {
  const result = preview.result;
  const metricLabel = METRIC_LABELS[metric].label;
  const excludedPct = useMemo(() => {
    if (result === null || result.unscopedTotalCost <= 0) return 0;
    return ((result.unscopedTotalCost - result.scopedTotalCost) / result.unscopedTotalCost) * 100;
  }, [result]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Preview</CardTitle>
          <span className="text-xs text-text-muted">Last 30 days · {metricLabel}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary row */}
        <div className="grid grid-cols-3 gap-3">
          <SummaryTile
            label="Unscoped total"
            value={result !== null ? formatDollars(result.unscopedTotalCost) : loading ? '…' : '—'}
            hint={`Raw ${metricLabel.toLowerCase()} over the window`}
          />
          <SummaryTile
            label="After scope"
            value={result !== null ? formatDollars(result.scopedTotalCost) : loading ? '…' : '—'}
            hint={hasEnabledRules ? `${excludedPct.toFixed(1)}% excluded` : 'No rules enabled'}
            emphasis
          />
          <SummaryTile
            label="Excluded"
            value={hasEnabledRules ? combinedText : '—'}
            hint={hasEnabledRules ? 'Union of enabled rules' : 'Toggle a rule above'}
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
          <PreviewHistogram days={result?.dailyTotals ?? []} />
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

function SummaryTile({ label, value, hint, emphasis }: { label: string; value: string; hint: string; emphasis?: boolean }): React.JSX.Element {
  return (
    <div className={`rounded-md border border-border px-3 py-2 ${emphasis ? 'bg-bg-tertiary/40' : 'bg-bg-secondary/60'}`}>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${emphasis ? 'text-text-primary' : 'text-text-secondary'}`}>{value}</div>
      <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>
    </div>
  );
}
