import { useEffect, useState } from 'react';
import { useCostApi } from '@costgoblin/ui';
import type { PerformanceInfo } from '@costgoblin/core/browser';

/** Parse a numeric settings field. Empty/invalid → null ("auto"). */
function parseField(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Self-contained DuckDB performance controls (memory limit + threads) for the
 *  options menu. Reads the machine-derived defaults/ranges + current overrides
 *  from the backend, and persists + applies changes live. Blank = "auto". */
export function PerformanceSettings(): React.JSX.Element {
  const api = useCostApi();
  const [info, setInfo] = useState<PerformanceInfo | null>(null);
  const [mem, setMem] = useState('');
  const [threads, setThreads] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.getPerformanceInfo().then((i) => {
      if (cancelled) return;
      setInfo(i);
      setMem(i.current.memoryLimitGB === null ? '' : String(i.current.memoryLimitGB));
      setThreads(i.current.threads === null ? '' : String(i.current.threads));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  if (info === null) {
    return <div className="px-2 py-1.5 text-xs text-text-muted">Loading…</div>;
  }

  const memCeiling = Math.min(info.maxMemoryGB, info.totalMemoryGB);

  function commit(nextMem: string, nextThreads: string): void {
    void api.setPerformanceSettings({
      memoryLimitGB: parseField(nextMem),
      threads: parseField(nextThreads),
    }).catch(() => undefined);
  }

  const inputCls = 'w-20 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-right text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="space-y-3 px-2 py-1.5">
      <p className="text-xs text-text-muted">Leave blank for Auto. Changes apply immediately.</p>

      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm text-text-secondary">
          <span>Memory limit (GB)</span>
          <input
            type="number"
            min={info.minMemoryGB}
            max={memCeiling}
            inputMode="numeric"
            className={inputCls}
            placeholder={`Auto (${String(info.defaultMemoryGB)})`}
            value={mem}
            onChange={(e) => { setMem(e.target.value); }}
            onBlur={() => { commit(mem, threads); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
          />
        </label>
        <p className="text-[11px] text-text-muted">
          Auto: {info.defaultMemoryGB} GB · range {info.minMemoryGB}–{memCeiling} · {info.totalMemoryGB} GB detected
        </p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm text-text-secondary">
          <span>DuckDB threads</span>
          <input
            type="number"
            min={1}
            max={info.maxThreads}
            inputMode="numeric"
            className={inputCls}
            placeholder={`Auto (${String(info.defaultThreads)})`}
            value={threads}
            onChange={(e) => { setThreads(e.target.value); }}
            onBlur={() => { commit(mem, threads); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
          />
        </label>
        <p className="text-[11px] text-text-muted">
          Auto: {info.defaultThreads} · range 1–{info.maxThreads} cores
        </p>
      </div>
    </div>
  );
}
