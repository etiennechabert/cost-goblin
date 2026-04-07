import { useState } from 'react';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { formatDollars } from './format.js';

export interface BarDay {
  readonly date: string;
  readonly total: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

export type HistogramTab = 'owner' | 'product' | 'service';

interface StackedBarChartProps {
  days: readonly BarDay[];
  highlightedGroup?: string | null;
  tab: HistogramTab;
  onTabChange: (tab: HistogramTab) => void;
  expanded?: boolean | undefined;
  onExpandToggle?: (() => void) | undefined;
}

export function StackedBarChart({ days, highlightedGroup, tab, onTabChange, expanded, onExpandToggle }: StackedBarChartProps) {
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  const allKeys = new Set<string>();
  for (const day of days) {
    for (const key of Object.keys(day.breakdown)) {
      allKeys.add(key);
    }
  }
  const breakdownKeys = [...allKeys];

  const maxCost = days.reduce((m, d) => Math.max(m, d.total), 0);

  const tabs: readonly { key: HistogramTab; label: string }[] = [
    { key: 'owner', label: 'Groups' },
    { key: 'product', label: 'Products' },
    { key: 'service', label: 'Services' },
  ];

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-secondary">Daily Costs</h3>
        <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => { onTabChange(t.key); }}
              className={[
                'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                tab === t.key
                  ? 'bg-accent text-bg-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
        {onExpandToggle !== undefined && (
          <button
            type="button"
            onClick={onExpandToggle}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
            title={expanded === true ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4M9 1h4v4M1 9v4h4M9 13h4v-4" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {days.length > 0 ? (
        <div>
          {/* Y axis label */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-text-muted w-10 text-right">{formatDollars(maxCost)}</span>
            <div className="flex-1 border-b border-border-subtle" />
          </div>

          <div className="flex items-end ml-12" style={{ height: expanded === true ? '360px' : '180px', gap: '2px' }}>
            {days.map((day) => {
              const barPct = maxCost > 0 ? (day.total / maxCost) * 100 : 0;
              const segments = breakdownKeys
                .map((key, ki) => ({
                  key,
                  value: day.breakdown[key] ?? 0,
                  colorIdx: ki,
                }))
                .filter(s => s.value > 0);
              const segTotal = segments.reduce((sum, s) => sum + s.value, 0);
              const isHovered = hoveredDay === day.date;

              return (
                <div
                  key={day.date}
                  className="group relative flex-1 min-w-0"
                  style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                  onMouseEnter={() => { setHoveredDay(day.date); }}
                  onMouseLeave={() => { setHoveredDay(null); }}
                >
                  <div
                    className="w-full overflow-hidden rounded-t-sm"
                    style={{ height: `${String(barPct)}%`, minHeight: barPct > 0 ? '2px' : '0' }}
                  >
                    {segments.map(seg => {
                      const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
                      const color = PALETTE_STANDARD[seg.colorIdx % PALETTE_STANDARD.length] ?? '#374151';
                      const isDimmed = highlightedGroup !== null && highlightedGroup !== undefined && highlightedGroup !== seg.key;
                      return (
                        <div
                          key={seg.key}
                          style={{
                            height: `${String(pct)}%`,
                            backgroundColor: color,
                            opacity: isDimmed ? 0.25 : 0.85,
                            transition: 'opacity 0.15s',
                          }}
                        />
                      );
                    })}
                  </div>

                  {isHovered && (
                    <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20">
                      <div className="rounded bg-bg-secondary/95 px-2.5 py-1.5 text-[10px] text-text-primary whitespace-nowrap shadow-lg border border-border">
                        <div className="font-medium">{day.date.slice(5)}</div>
                        <div>{formatDollars(day.total)}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* X axis */}
          <div className="flex ml-12 mt-1" style={{ gap: '2px' }}>
            {days.map((day, idx) => (
              <div key={day.date} className="flex-1 min-w-0 text-center">
                {idx % Math.max(1, Math.floor(days.length / 6)) === 0 ? (
                  <span className="text-[10px] text-text-muted">{day.date.slice(5)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-40 text-sm text-text-muted">No daily data</div>
      )}
    </div>
  );
}
