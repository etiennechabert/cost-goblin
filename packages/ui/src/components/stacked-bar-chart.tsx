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
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4M9 1h4v4M1 9v4h4M9 13h4v-4" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {days.length > 0 ? (() => {
        const chartHeight = expanded ? 360 : 180;
        const ticks = [1, 0.75, 0.5, 0.25, 0];
        return (
        <div className="relative">
          {/* Y axis ticks */}
          <div className="absolute left-0 top-0 w-10 h-full" style={{ height: `${String(chartHeight)}px` }}>
            {ticks.map(pct => (
              <div
                key={pct}
                className="absolute right-0 flex items-center"
                style={{ top: `${String((1 - pct) * 100)}%`, transform: 'translateY(-50%)' }}
              >
                <span className="text-[10px] text-text-muted tabular-nums">{formatDollars(maxCost * pct)}</span>
              </div>
            ))}
          </div>

          {/* Grid lines */}
          <div className="absolute left-12 right-0 top-0" style={{ height: `${String(chartHeight)}px` }}>
            {ticks.map(pct => (
              <div
                key={pct}
                className="absolute left-0 right-0 border-b border-border-subtle/50"
                style={{ top: `${String((1 - pct) * 100)}%` }}
              />
            ))}
          </div>

          <div className="flex items-end ml-12 relative z-10" style={{ height: `${String(chartHeight)}px`, gap: '2px' }}>
            {days.map((day) => {
              const barPct = maxCost > 0 ? (day.total / maxCost) * 100 : 0;
              const segments = breakdownKeys
                .map((key, ki) => ({
                  key,
                  value: day.breakdown[key] ?? 0,
                  colorIdx: ki,
                }))
                .filter(s => s.value > 0)
                .sort((a, b) => b.value - a.value);
              const segTotal = segments.reduce((sum, s) => sum + s.value, 0);
              const isHovered = hoveredDay === day.date;

              return (
                <div
                  key={day.date}
                  className="group relative flex-1 min-w-0"
                  style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                  role="button"
                  tabIndex={0}
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
                      <div className="rounded-lg bg-bg-secondary/95 px-3 py-2 text-[11px] text-text-primary whitespace-nowrap shadow-lg border border-border min-w-[160px]">
                        <div className="font-semibold mb-1.5 text-xs">{day.date}</div>
                        <div className="flex items-center justify-between font-medium mb-1 pb-1 border-b border-border-subtle">
                          <span>Total</span>
                          <span>{formatDollars(day.total)}</span>
                        </div>
                        <div className="flex flex-col gap-0.5 mt-1">
                          {segments
                            .slice(0, 8)
                            .map(seg => {
                              const color = PALETTE_STANDARD[seg.colorIdx % PALETTE_STANDARD.length] ?? '#374151';
                              const isHighlighted = highlightedGroup === seg.key;
                              return (
                                <div
                                  key={seg.key}
                                  className={`flex items-center justify-between gap-3 rounded px-1 -mx-1 ${isHighlighted ? 'bg-white/10' : ''}`}
                                >
                                  <div className="flex items-center gap-1.5">
                                    <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                                    <span className={`truncate max-w-[120px] ${isHighlighted ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{seg.key}</span>
                                  </div>
                                  <span className={`tabular-nums ${isHighlighted ? 'text-text-primary font-medium' : 'text-text-primary'}`}>{formatDollars(seg.value)}</span>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* X axis */}
          <div className="flex ml-12 mt-1" style={{ gap: '2px' }}>
            {days.map((day, idx) => {
              const step = Math.max(1, Math.ceil(days.length / 7));
              return (
              <div key={day.date} className="flex-1 min-w-0 text-center overflow-hidden">
                {idx % step === 0 ? (
                  <span className="text-[10px] text-text-muted whitespace-nowrap">{day.date.slice(5)}</span>
                ) : null}
              </div>
              );
            })}
          </div>
        </div>
        );
      })() : (
        <div className="flex items-center justify-center h-40 text-sm text-text-muted">No daily data</div>
      )}
    </div>
  );
}
