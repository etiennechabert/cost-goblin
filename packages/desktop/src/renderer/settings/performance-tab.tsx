import { useEffect, useState } from 'react';
import { useCostApi, useUnsavedChanges } from '@costgoblin/ui';
import type { PerformanceInfo } from '@costgoblin/core/browser';

/** Parse a numeric settings field. Empty/invalid → null ("auto"). */
function parseField(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fieldString(value: number | null): string {
  return value === null ? '' : String(value);
}

/** DuckDB resource tuning (memory limit + threads). Relocated out of the cramped
 *  options popover — where edits committed silently on blur and an Escape press
 *  discarded them — into a full settings tab with an explicit Save button and a
 *  dirty guard, so in-progress edits are never lost by accident. Blank = Auto. */
export function PerformanceTab(): React.JSX.Element {
  const api = useCostApi();
  const [info, setInfo] = useState<PerformanceInfo | null>(null);
  const [mem, setMem] = useState('');
  const [threads, setThreads] = useState('');
  const [rollupConc, setRollupConc] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getPerformanceInfo().then((i) => {
      if (cancelled) return;
      setInfo(i);
      setMem(fieldString(i.current.memoryLimitGB));
      setThreads(fieldString(i.current.threads));
      setRollupConc(fieldString(i.current.rollupConcurrency));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  const dirty = info !== null && (
    parseField(mem) !== info.current.memoryLimitGB ||
    parseField(threads) !== info.current.threads ||
    parseField(rollupConc) !== info.current.rollupConcurrency
  );
  useUnsavedChanges(dirty, 'Performance');

  if (info === null) {
    return <div className="p-6 text-sm text-text-muted">Loading…</div>;
  }

  const memCeiling = Math.min(info.maxMemoryGB, info.totalMemoryGB);
  const inputCls = 'w-24 rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-right text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

  function save(): void {
    if (info === null || saving) return;
    const next = { memoryLimitGB: parseField(mem), threads: parseField(threads), rollupConcurrency: parseField(rollupConc) };
    setSaving(true);
    setSavedAt(false);
    api.setPerformanceSettings(next)
      .then(() => {
        setInfo(prev => (prev === null ? prev : { ...prev, current: next }));
        setSavedAt(true);
      })
      .catch(() => undefined)
      .finally(() => { setSaving(false); });
  }

  function resetToAuto(): void {
    setMem('');
    setThreads('');
    setRollupConc('');
    setSavedAt(false);
  }

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Performance</h2>
        <p className="mt-1 text-sm text-text-secondary">Tune how much of this machine DuckDB may use. Leave blank for Auto.</p>
      </div>

      <div className="flex flex-col gap-5 rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="perf-mem" className="text-sm text-text-primary">Memory limit (GB)</label>
            <p className="mt-0.5 text-xs text-text-muted">
              Auto: {info.defaultMemoryGB} GB · range {info.minMemoryGB}–{memCeiling} · {info.totalMemoryGB} GB detected
            </p>
          </div>
          <input
            id="perf-mem"
            type="number"
            min={info.minMemoryGB}
            max={memCeiling}
            inputMode="numeric"
            className={inputCls}
            placeholder={`Auto (${String(info.defaultMemoryGB)})`}
            value={mem}
            onChange={(e) => { setMem(e.target.value); setSavedAt(false); }}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="perf-threads" className="text-sm text-text-primary">DuckDB threads</label>
            <p className="mt-0.5 text-xs text-text-muted">
              Auto: {info.defaultThreads} · range 1–{info.maxThreads} cores
            </p>
          </div>
          <input
            id="perf-threads"
            type="number"
            min={1}
            max={info.maxThreads}
            inputMode="numeric"
            className={inputCls}
            placeholder={`Auto (${String(info.defaultThreads)})`}
            value={threads}
            onChange={(e) => { setThreads(e.target.value); setSavedAt(false); }}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="perf-rollup-conc" className="text-sm text-text-primary">Parallel rollup builds</label>
            <p className="mt-0.5 text-xs text-text-muted">
              How many monthly rollup partitions build at once. Lower keeps the app snappier while a rebuild runs.
              Auto: {info.defaultRollupConcurrency} · range 1–{info.maxRollupConcurrency}
            </p>
          </div>
          <input
            id="perf-rollup-conc"
            type="number"
            min={1}
            max={info.maxRollupConcurrency}
            inputMode="numeric"
            className={inputCls}
            placeholder={`Auto (${String(info.defaultRollupConcurrency)})`}
            value={rollupConc}
            onChange={(e) => { setRollupConc(e.target.value); setSavedAt(false); }}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className={[
            'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
            !dirty || saving
              ? 'cursor-not-allowed bg-bg-tertiary text-text-muted'
              : 'bg-accent text-white hover:bg-accent-hover',
          ].join(' ')}
        >
          {saving ? 'Applying…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={resetToAuto}
          disabled={mem === '' && threads === '' && rollupConc === ''}
          className="rounded-md border border-border px-4 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset to Auto
        </button>
        {savedAt && !dirty && (
          <span className="text-sm text-positive">Applied</span>
        )}
        {dirty && (
          <span className="text-sm text-text-muted">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
