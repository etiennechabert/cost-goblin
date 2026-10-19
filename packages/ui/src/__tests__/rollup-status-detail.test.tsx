import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RollupStats, RollupStatus } from '@costgoblin/core/browser';
import { RollupStatusDetail } from '../components/rollup-status-detail.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

function computing(overrides: Partial<Extract<RollupStatus, { state: 'computing' }>> = {}): RollupStatus {
  return { state: 'computing', done: 0, total: 0, periods: [], active: [], ...overrides };
}

function stats(overrides: Partial<RollupStats> = {}): RollupStats {
  return { months: 12, rollupRows: 500, rollupBytes: 512, rawBytes: 0, ...overrides };
}

/** The value cell of a KPI row, looked up by its label. */
function kpiValue(label: string): HTMLElement {
  const value = screen.getByText(label).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value next to "${label}"`);
  return value;
}

/** A month chip, by its rendered label. */
function chip(label: string): HTMLElement {
  return screen.getByText(label);
}

describe('RollupStatusDetail — computing', () => {
  it('shows the progress bar and month count while months remain', () => {
    const { container } = render(<RollupStatusDetail status={computing({ done: 3, total: 12 })} />);

    expect(screen.getByText(/Rebuilding the pre-aggregated rollup/)).toBeDefined();
    expect(screen.getByText('3 / 12 months')).toBeDefined();
    const fill = container.querySelector<HTMLElement>('.bg-accent.transition-all');
    if (fill === null) throw new Error('progress fill not rendered');
    expect(fill.style.width).toBe('25%');
  });

  it('omits the progress bar and chips before the batch is sized', () => {
    const { container } = render(<RollupStatusDetail status={computing()} />);

    expect(screen.getByText(/Rebuilding the pre-aggregated rollup/)).toBeDefined();
    expect(screen.queryByText(/months$/)).toBeNull();
    expect(container.querySelector('.transition-all')).toBeNull();
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('marks each month chip as rebuilt, building or pending', () => {
    render(<RollupStatusDetail status={computing({
      done: 1,
      total: 3,
      periods: ['2026-01', '2026-02', '2026-03'],
      active: ['2026-02'],
    })} />);

    const rebuilt = chip("Jan '26");
    const building = chip("Feb '26");
    const pending = chip("Mar '26");
    expect(rebuilt.title).toBe('Rebuilt');
    expect(building.title).toBe('Building…');
    expect(building.className).toContain('animate-pulse');
    expect(pending.title).toBe('Pending');
    expect(pending.className).toContain('text-text-muted');
    expect(rebuilt.className).not.toContain('animate-pulse');
  });

  it('rings the months the caller highlights, and only those', () => {
    render(<RollupStatusDetail
      status={computing({ done: 0, total: 2, periods: ['2026-04', '2026-05'], active: [] })}
      highlight={['2026-05']}
    />);

    expect(chip("May '26").className).toContain('ring-1');
    expect(chip("Apr '26").className).not.toContain('ring-1');
  });

  it('falls back to the raw text for periods that are not YYYY-MM', () => {
    render(<RollupStatusDetail status={computing({ done: 0, total: 2, periods: ['2026-13', 'Q1'], active: [] })} />);

    // An out-of-range month keeps its number; a period with no month at all
    // renders verbatim.
    expect(chip("13 '26")).toBeDefined();
    expect(chip('Q1')).toBeDefined();
  });
});

describe('RollupStatusDetail — ready', () => {
  it('shows only the month count when no stats are passed', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 14 }} />);

    expect(screen.getByText(/served from the pre-aggregated rollup/)).toBeDefined();
    expect(kpiValue('Months built').textContent).toBe('14');
    expect(screen.queryByText('Rollup size')).toBeNull();
    expect(screen.queryByText('Raw (daily)')).toBeNull();
    expect(screen.queryByText('Compression')).toBeNull();
  });

  it('treats an explicit null stats like no stats', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 2 }} stats={null} />);

    expect(kpiValue('Months built').textContent).toBe('2');
    expect(screen.queryByText('Rollup size')).toBeNull();
  });

  it('shows the rollup size but no raw or compression rows without raw bytes', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 1 }} stats={stats({ rollupBytes: 512, rollupRows: 999, rawBytes: 0 })} />);

    expect(kpiValue('Rollup size').textContent).toBe('512 B · 999 rows');
    expect(screen.queryByText('Raw (daily)')).toBeNull();
    expect(screen.queryByText('Compression')).toBeNull();
  });

  it('shows the raw size and an accented compression ratio', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 3 }} stats={stats({ rollupBytes: 5 * MB, rollupRows: 1500, rawBytes: 2 * GB })} />);

    expect(kpiValue('Rollup size').textContent).toBe('5 MB · 1.5K rows');
    expect(kpiValue('Raw (daily)').textContent).toBe('2.0 GB');
    const ratio = kpiValue('Compression');
    expect(ratio.textContent).toBe('410× smaller');
    expect(ratio.className).toContain('text-accent');
    expect(kpiValue('Raw (daily)').className).not.toContain('text-accent');
  });

  it('keeps one decimal on a small compression ratio', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 3 }} stats={stats({ rollupBytes: 2 * KB, rollupRows: 25_000, rawBytes: 5 * KB })} />);

    expect(kpiValue('Rollup size').textContent).toBe('2 KB · 25K rows');
    expect(kpiValue('Raw (daily)').textContent).toBe('5 KB');
    expect(kpiValue('Compression').textContent).toBe('2.5× smaller');
  });

  it('formats millions of rows and skips the ratio for an empty rollup', () => {
    render(<RollupStatusDetail status={{ state: 'ready', periods: 3 }} stats={stats({ rollupBytes: 0, rollupRows: 2_500_000, rawBytes: 3 * MB })} />);

    expect(kpiValue('Rollup size').textContent).toBe('0 B · 2.5M rows');
    expect(kpiValue('Raw (daily)').textContent).toBe('3 MB');
    // A zero-byte rollup would divide by zero.
    expect(screen.queryByText('Compression')).toBeNull();
  });
});

describe('RollupStatusDetail — failed and idle', () => {
  it('shows the failure message, the raw reason and the fallback hint', () => {
    render(<RollupStatusDetail status={{ state: 'failed', message: 'Rollup build failed', reason: 'Out of memory\nat month 2026-02', periods: 0 }} />);

    expect(screen.getByText('Rollup build failed').className).toContain('text-negative');
    expect(screen.getByText('Error')).toBeDefined();
    expect(screen.getByText(/Out of memory/).textContent).toBe('Out of memory\nat month 2026-02');
    expect(screen.getByText(/Dashboards fall back to raw data/)).toBeDefined();
  });

  it('explains that no rollup exists yet when idle', () => {
    render(<RollupStatusDetail status={{ state: 'idle' }} />);

    expect(screen.getByText('No rollup is built yet. Dashboards query the raw data directly.')).toBeDefined();
  });
});
