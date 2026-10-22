import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryCard } from '../components/summary-card.js';

// Ten days: 2026-03-01 … 2026-03-10 inclusive.
const RANGE = { start: '2026-03-01', end: '2026-03-10' };
// Five days: 2026-02-19 … 2026-02-23 inclusive.
const SHORT_PREVIOUS = { start: '2026-02-19', end: '2026-02-23' };

/** The "vs Previous Period" panel, or null when the card does not show it. */
function comparisonPanel(): HTMLElement | null {
  const heading = screen.queryByText('vs Previous Period');
  return heading === null ? null : heading.parentElement;
}

/** The value line of the "vs Previous Period" panel. */
function deltaLine(): HTMLElement {
  const panel = comparisonPanel();
  const line = panel?.querySelector('p.text-2xl');
  if (!(line instanceof HTMLElement)) throw new Error('no delta line');
  return line;
}

/** The value line of the "Daily Average" panel. */
function dailyAverageLine(): HTMLElement {
  const line = screen.getByText('Daily Average').nextElementSibling;
  if (!(line instanceof HTMLElement)) throw new Error('no daily average line');
  return line;
}

describe('SummaryCard', () => {
  it('shows placeholders, not $0.00, before the total has loaded', () => {
    render(<SummaryCard totalCost={null} dateRange={RANGE} />);

    expect(screen.getByText('Total Cost').nextElementSibling?.textContent).toBe('—');
    expect(dailyAverageLine().textContent).toBe('—');
    expect(comparisonPanel()).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    expect(screen.getByText('Mar 1, 2026 – Mar 10, 2026')).toBeDefined();
  });

  it('reports the previous daily average even while the current total loads', () => {
    render(<SummaryCard totalCost={null} previousCost={500} dateRange={RANGE} />);

    // No delta without a current total, so no comparison panel yet.
    expect(comparisonPanel()).toBeNull();
    expect(screen.getByText('Previous: $50.00/day')).toBeDefined();
  });

  it('flags an increase in red with an up arrow and the signed difference', () => {
    render(<SummaryCard totalCost={1_500} previousCost={1_000} dateRange={RANGE} />);

    expect(screen.getByText('$1.5k')).toBeDefined();
    const line = deltaLine();
    expect(line.textContent).toBe('▲50.0%(+$500.00)');
    expect(line.className).toContain('text-negative');
    expect(screen.getByText('Previous: $1.0k')).toBeDefined();

    // $150/day now vs $100/day before.
    const avg = dailyAverageLine();
    expect(avg.textContent).toBe('$150.00(+$50.00)');
    expect(screen.getByText('(+$50.00)').className).toContain('text-negative');
    expect(screen.getByText('Previous: $100.00/day')).toBeDefined();
  });

  it('flags a decrease in green with a down arrow', () => {
    render(<SummaryCard totalCost={800} previousCost={1_000} dateRange={RANGE} />);

    const line = deltaLine();
    expect(line.textContent).toMatch(/^▼20\.0%\(.*200\.00\)$/);
    expect(line.textContent).not.toContain('+');
    expect(line.className).toContain('text-positive');

    // $80/day vs $100/day: the daily-average difference is a saving too.
    const badge = dailyAverageLine().querySelector('span');
    expect(badge?.textContent).toMatch(/^\(.*20\.00\)$/);
    expect(badge?.className).toContain('text-positive');
  });

  it('shows a flat change neutrally, without an arrow', () => {
    render(<SummaryCard totalCost={1_000} previousCost={1_000} dateRange={RANGE} />);

    const line = deltaLine();
    expect(line.textContent).toBe('0.0%(+$0.00)');
    expect(line.className).toContain('text-text-secondary');
    const badge = dailyAverageLine().querySelector('span');
    expect(badge?.textContent).toBe('(+$0.00)');
    expect(badge?.className).toContain('text-text-secondary');
  });

  it('compares daily averages over each period’s own length', () => {
    // Same total, but the previous period was half as long: $100/day now
    // against $200/day before.
    render(<SummaryCard totalCost={1_000} previousCost={1_000} dateRange={RANGE} previousDateRange={SHORT_PREVIOUS} />);

    expect(deltaLine().textContent).toBe('0.0%(+$0.00)');
    expect(screen.getByText('Previous: $200.00/day')).toBeDefined();
    const badge = dailyAverageLine().querySelector('span');
    expect(badge?.textContent).toMatch(/^\(.*100\.00\)$/);
    expect(badge?.className).toContain('text-positive');
  });

  it('shows a placeholder delta when the previous period is known to be missing', () => {
    render(<SummaryCard totalCost={1_000} previousCost={null} dateRange={RANGE} />);

    const panel = comparisonPanel();
    expect(panel).not.toBeNull();
    expect(deltaLine().textContent).toBe('—');
    expect(deltaLine().className).toContain('text-text-muted');
    expect(screen.queryByText(/^Previous:/)).toBeNull();
    expect(dailyAverageLine().textContent).toBe('$100.00');
  });

  it('has no comparison when the previous period cost nothing', () => {
    render(<SummaryCard totalCost={1_000} previousCost={0} dateRange={RANGE} />);

    // A ratio against zero is meaningless: no panel, no average badge.
    expect(comparisonPanel()).toBeNull();
    expect(dailyAverageLine().textContent).toBe('$100.00');
    expect(screen.getByText('Previous: $0.00/day')).toBeDefined();
  });

  it('omits the comparison entirely when no previous cost was requested', () => {
    render(<SummaryCard totalCost={1_000} dateRange={RANGE} />);

    expect(comparisonPanel()).toBeNull();
    expect(screen.queryByText(/Previous/)).toBeNull();
  });

  it('divides the daily average by the days actually read, not the whole selection', () => {
    // A Monthly "Last 3 months" (Aug 1 – Oct 31, 92 days) read up to Oct 19: 80 days.
    const selection = { start: '2026-08-01', end: '2026-10-31' };
    const read = { start: '2026-08-01', end: '2026-10-19' };
    const previousSelection = { start: '2026-05-01', end: '2026-07-31' };
    render(<SummaryCard
      totalCost={8_000}
      previousCost={9_200}
      dateRange={selection}
      previousDateRange={previousSelection}
      coveredRange={read}
      previousCoveredRange={previousSelection}
    />);

    // 8000 / 80 = $100 (not 8000 / 92 = $86.96); the previous period is whole: 9200 / 92 = $100.
    expect(dailyAverageLine().textContent).toBe('$100.00(+$0.00)');
    expect(screen.getByText('Previous: $100.00/day')).toBeDefined();
    expect(screen.getByText('Aug 1, 2026 – Oct 31, 2026')).toBeDefined();
  });
});
