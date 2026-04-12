import { useState } from 'react';
import type { DimensionsConfig, TagDimension, ConceptType, NormalizationRule } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

const CONCEPTS: { value: ConceptType; label: string }[] = [
  { value: 'owner', label: 'Owner (team)' },
  { value: 'product', label: 'Product (system)' },
  { value: 'environment', label: 'Environment' },
];

const NORMALIZE_RULES: { value: NormalizationRule; label: string }[] = [
  { value: 'lowercase', label: 'lowercase' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase-kebab', label: 'kebab-case' },
];

interface EditingTag {
  tagName: string;
  label: string;
  concept: string;
  normalize: string;
  aliases: string;
  fallbackTag: string | undefined;
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
  discoveredTags: readonly { key: string; sampleValues: string[]; rowCount: number }[];
  accountTagKeys: readonly string[];
  orgAccounts: readonly { tags: Readonly<Record<string, string>> }[];
}>) {
  const [state, setState] = useState(tag);

  return (
    <div className="rounded-xl border border-accent/30 bg-bg-tertiary/10 px-5 py-4 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Tag Name (CUR column)</span>
          {(() => {
            // Build option list: current tag (if set) + all unmapped tags
            const options = state.tagName.length > 0 && !availableTags.includes(state.tagName)
              ? [state.tagName, ...availableTags]
              : [...availableTags];
            return (
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
                {options.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            );
          })()}
          {state.tagName.length > 0 && (() => {
            const match = discovered.find(t => t.key === state.tagName);
            if (match === undefined) return null;
            return (
              <div className="flex flex-wrap gap-1 mt-1">
                <span className="text-[10px] text-text-muted">{match.rowCount.toLocaleString()} rows:</span>
                {match.sampleValues.map(v => (
                  <span key={v} className="rounded bg-bg-tertiary/50 px-1.5 py-0.5 text-[10px] text-text-secondary">{v}</span>
                ))}
              </div>
            );
          })()}
        </div>
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
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Concept (dimension role)</span>
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

      {acctTags.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">Fallback account tag (used when resource tag is missing)</span>
          <select
            value={state.fallbackTag ?? ''}
            onChange={e => { setState(s => ({ ...s, fallbackTag: e.target.value.length > 0 ? e.target.value : undefined })); }}
            className="rounded border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          >
            <option value="">No fallback</option>
            {acctTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          {state.fallbackTag !== undefined && state.fallbackTag.length > 0 && (() => {
            const counts = new Map<string, number>();
            for (const acct of orgAccounts) {
              const val = acct.tags[state.fallbackTag];
              if (val !== undefined && val.length > 0) {
                counts.set(val, (counts.get(val) ?? 0) + 1);
              }
            }
            const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            if (sorted.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-1 mt-1">
                {sorted.map(([val, cnt]) => (
                  <span key={val} className="rounded bg-bg-tertiary/50 px-1.5 py-0.5 text-[10px] text-text-secondary">
                    {val} <span className="text-text-muted">({String(cnt)})</span>
                  </span>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">Alias Rules (one per line: canonical: alias1, alias2)</span>
        <textarea
          value={state.aliases}
          onChange={e => { setState(s => ({ ...s, aliases: e.target.value })); }}
          rows={4}
          className="rounded border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary font-mono outline-none focus:border-accent resize-y"
          placeholder="production: prod, prd, Production&#10;staging: stg, stage"
        />
      </label>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => { onSave(state); }} className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors">
            Save
          </button>
          <button type="button" onClick={onCancel} className="rounded-md px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary transition-colors">
            Cancel
          </button>
        </div>
        {onRemove !== undefined && (
          <button type="button" onClick={onRemove} className="rounded-md px-4 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted transition-colors">
            Remove Dimension
          </button>
        )}
      </div>
    </div>
  );
}

export function DimensionsView() {
  const api = useCostApi();
  const tagsQuery = useQuery(() => api.discoverTagKeys(), []);
  const configQuery = useQuery(() => api.getDimensionsConfig(), []);
  const orgQuery = useQuery(() => api.getOrgSyncResult(), []);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const discoveredTags = tagsQuery.status === 'success' ? tagsQuery.data : [];
  const config: DimensionsConfig | null = configQuery.status === 'success' ? configQuery.data : null;
  const orgData = orgQuery.status === 'success' ? orgQuery.data : null;

  // Account tag keys from org sync
  const accountTagKeys = orgData !== null
    ? [...new Set(orgData.accounts.flatMap(a => Object.keys(a.tags)))].sort()
    : [];

  // Which resource tags are already mapped as dimensions
  const mappedTagNames = new Set(config?.tags.map(t => t.tagName) ?? []);

  // Only CUR resource tags for the primary dropdown (not account tags)
  const unmappedTagKeys = discoveredTags
    .map(t => t.key)
    .filter(k => !mappedTagNames.has(k))
    .sort();

  function editingToTagDimension(editing: EditingTag): TagDimension {
    const base: { tagName: string; label: string } = { tagName: editing.tagName, label: editing.label };
    const concept = editing.concept.length > 0 ? editing.concept as ConceptType : undefined;
    const normalize = editing.normalize.length > 0 ? editing.normalize as NormalizationRule : undefined;
    const aliases = textToAliases(editing.aliases);
    const accountTagFallback = editing.fallbackTag !== undefined && editing.fallbackTag.length > 0 ? editing.fallbackTag : undefined;
    return { ...base, concept, normalize, aliases, accountTagFallback };
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

  // Quick-add a discovered tag as a dimension
  const [quickAddState, setQuickAddState] = useState<EditingTag | null>(null);

  void refreshKey; // used as useQuery dep to force re-fetch

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Dimensions</h2>
        <p className="text-sm text-text-secondary mt-1">Map tags to cost allocation dimensions</p>
      </div>

      {/* Current dimension mappings */}
      {config !== null && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-secondary">Active Dimensions</h3>
            <button
              type="button"
              onClick={() => { setAddingNew(true); setEditingIdx(null); setQuickAddState(null); }}
              className="rounded-md border border-accent/50 bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
            >
              + Add Dimension
            </button>
          </div>

          {/* Built-in dimensions (read-only) */}
          {config.builtIn.map(d => (
            <div key={d.name} className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-text-primary">{d.label}</span>
                <span className="text-xs text-text-muted font-mono">{d.field}</span>
                {d.displayField !== undefined && (
                  <span className="text-[10px] text-text-muted">display: {d.displayField}</span>
                )}
              </div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Built-in</span>
            </div>
          ))}

          {/* Tag dimensions (editable) */}
          {config.tags.map((tag, idx) => (
            <div key={tag.tagName}>
              {editingIdx === idx ? (
                <TagEditor
                  tag={{
                    tagName: tag.tagName,
                    label: tag.label,
                    concept: tag.concept ?? '',
                    normalize: tag.normalize ?? '',
                    aliases: aliasesToText(tag.aliases),
                    fallbackTag: tag.accountTagFallback,
                  }}
                  onSave={(edited) => { void handleSaveTag(idx, edited); }}
                  onCancel={() => { setEditingIdx(null); }}
                  onRemove={() => { void handleRemoveTag(idx); }}
                  availableTags={unmappedTagKeys}
                  discoveredTags={discoveredTags}
                  accountTagKeys={accountTagKeys}
                  orgAccounts={orgData?.accounts ?? []}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => { setEditingIdx(idx); setAddingNew(false); }}
                  className="w-full rounded-xl border border-border bg-bg-secondary/50 px-5 py-3 flex items-center justify-between text-left hover:bg-bg-tertiary/30 transition-colors"
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
                  </div>
                  <span className="text-xs text-text-muted">Edit →</span>
                </button>
              )}
            </div>
          ))}

          {/* Add new dimension form */}
          {addingNew && (
            <TagEditor
              tag={quickAddState ?? { tagName: '', label: '', concept: '', normalize: '', aliases: '', fallbackTag: undefined }}
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

      {/* Resource tags pivot table — columns are tag keys, rows are top values */}
      {discoveredTags.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-secondary">
              Resource Tags
              <span className="text-text-muted ml-1">({String(discoveredTags.length)} keys found in billing data)</span>
            </h3>
          </div>
          <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  {discoveredTags.map(t => (
                    <th key={t.key} className="px-3 py-2 font-medium whitespace-nowrap">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono">{t.key}</span>
                        <span className="text-[9px] text-text-muted font-normal">{t.rowCount.toLocaleString()} rows</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(...discoveredTags.map(t => t.sampleValues.length), 0) }, (_, rowIdx) => (
                  <tr key={rowIdx} className="border-b border-border-subtle">
                    {discoveredTags.map(t => {
                      const val = t.sampleValues[rowIdx];
                      return (
                        <td key={t.key} className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                          {val !== undefined ? val : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tagsQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Scanning billing data for tags...</div>
      )}

      {/* Account tags pivot table */}
      {accountTagKeys.length > 0 && orgData !== null && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-secondary">
              Account Tags
              <span className="text-text-muted ml-1">({String(accountTagKeys.length)} keys from AWS Organizations)</span>
            </h3>
          </div>
          <p className="text-xs text-text-muted">
            Values sorted by frequency. Can be used as fallback when resource-level tags are missing.
          </p>
          <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  {accountTagKeys.map(key => {
                    const count = orgData.accounts.filter(a => a.tags[key] !== undefined && a.tags[key] !== '').length;
                    return (
                      <th key={key} className="px-3 py-2 font-medium whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono">{key}</span>
                          <span className="text-[9px] text-text-muted font-normal">{String(count)}/{String(orgData.accounts.length)} accounts</span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // For each tag key, compute sorted unique values by frequency
                  const columnValues = accountTagKeys.map(key => {
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
                        <td key={accountTagKeys[colIdx]} className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                          {vals[rowIdx] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
