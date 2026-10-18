import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerPreferencesUpdate,
  ExplorerRowsParams,
  ExplorerRowsResult,
} from '@costgoblin/core/browser';
import { DEFAULT_EXPLORER_HIDDEN_COLUMNS, asDateString } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ExplorerView } from '../views/explorer.js';

const TAG_COLUMNS = [
  { id: 'tag_team', label: 'Team' },
  { id: 'tag_env', label: 'Environment' },
];

/** Six hourly buckets on one day — the shape the handler emits for the
 *  hourly tier ("YYYY-MM-DD HH:MM:SS"). */
const HOURLY_OVERVIEW: ExplorerOverviewResult = {
  windowDays: 1,
  startDate: '2026-03-10',
  endDate: '2026-03-10',
  dailyTotals: Array.from({ length: 6 }, (_, i) => ({
    date: `2026-03-10 ${String(10 + i).padStart(2, '0')}:00:00`,
    cost: 100 + i,
    rows: 10 + i,
  })),
  totalRows: 321,
  totalCost: 615,
  tagColumns: TAG_COLUMNS,
};

function dailyOverview(days: number, totalRows = 1_000): ExplorerOverviewResult {
  return {
    windowDays: days,
    startDate: '2026-03-01',
    endDate: `2026-03-${String(days).padStart(2, '0')}`,
    dailyTotals: Array.from({ length: days }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, '0')}`,
      cost: 1_000 + i * 10,
      rows: 100 + i,
    })),
    totalRows,
    totalCost: 10_000,
    tagColumns: TAG_COLUMNS,
  };
}

/** Rows that exercise every formatting fallback: a credit (negative cost), an
 *  account without a resolved name, zero usage, an hourly timestamp, a bare
 *  time, empty and unconfigured tags. */
const DETAIL_ROWS: ExplorerRowsResult = {
  sampleRows: [
    {
      date: '2026-03-10', hour: '2026-03-10 14:00:00', accountId: '111111111111', accountName: '',
      region: 'eu-central-1', service: 'Amazon EC2', serviceCategory: 'Compute', chargeCategory: 'Credit',
      operation: 'RunInstances', skuMeter: 'EUC1-BoxUsage:t3.medium', description: 'Promotional credit',
      resourceId: 'i-0abc', usageAmount: 0, cost: -12.5, listCost: -12.5,
      tags: { tag_team: 'platform', tag_env: '', tag_cost_center: 'cc-42' },
    },
    {
      date: '2026-03-10', hour: '15:30:00', accountId: '222', accountName: 'staging',
      region: 'us-east-1', service: 'Amazon RDS', serviceCategory: 'Databases', chargeCategory: 'Usage',
      operation: 'CreateDBInstance', skuMeter: 'RDS:db.t4g.micro', description: 'Aurora MySQL',
      resourceId: 'arn:rds:db', usageAmount: 24, cost: 420, listCost: 500,
      tags: {},
    },
    {
      date: '2026-03-09', hour: '', accountId: '333', accountName: 'sandbox',
      region: 'us-west-2', service: 'Amazon S3', serviceCategory: 'Storage', chargeCategory: 'Usage',
      operation: 'PutObject', skuMeter: 'Requests-Tier1', description: 'PUT requests',
      resourceId: 'arn:s3:::bucket', usageAmount: 12, cost: 3.6, listCost: 3.6,
      tags: { tag_team: 'data', tag_env: 'dev' },
    },
  ],
  tagColumns: TAG_COLUMNS,
};

class ExplorerApi extends MockCostApi {
  readonly overviewCalls: ExplorerOverviewParams[] = [];
  readonly rowsCalls: ExplorerRowsParams[] = [];
  overview: ExplorerOverviewResult = dailyOverview(10);
  rows: ExplorerRowsResult = DETAIL_ROWS;
  prefs: ExplorerPreferences = { hiddenColumns: [...DEFAULT_EXPLORER_HIDDEN_COLUMNS], columnOrder: [] };

  override queryExplorerOverview(params?: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
    if (params !== undefined) this.overviewCalls.push(params);
    return Promise.resolve(this.overview);
  }

  override queryExplorerRows(params?: ExplorerRowsParams): Promise<ExplorerRowsResult> {
    if (params !== undefined) this.rowsCalls.push(params);
    return Promise.resolve(this.rows);
  }

  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.resolve(this.prefs);
  }
}

/** Persisting preferences fails (read-only profile). Saves are recorded by the
 *  base mock before the rejection, so the payloads stay assertable. */
class ReadOnlyPrefsApi extends ExplorerApi {
  override saveExplorerPreferences(prefs: ExplorerPreferencesUpdate): Promise<void> {
    void super.saveExplorerPreferences(prefs);
    return Promise.reject(new Error('read-only preferences'));
  }
}

function renderExplorer(api: ExplorerApi) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <ExplorerView />
      </CostApiProvider>,
    ),
  };
}

function visibleHeaders(): string[] {
  return within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map(th => th.textContent.replace(/[↑↓↕]/g, '').trim());
}

/** Body rows of the sample table (the header row has no cells of its own). */
function bodyRows(): HTMLTableRowElement[] {
  const table = screen.getByRole('table');
  return [...table.querySelectorAll('tbody tr')].filter(
    (tr): tr is HTMLTableRowElement => tr instanceof HTMLTableRowElement && tr.cells.length > 1,
  );
}

function cell(row: number, header: string): HTMLTableCellElement {
  const idx = visibleHeaders().indexOf(header);
  const found = bodyRows()[row]?.cells.item(idx);
  if (found === null || found === undefined) throw new Error(`no cell ${header} in row ${String(row)}`);
  return found;
}

/** The bars container is the only role="button" div; jsdom reports zero-size
 *  rects, so pin a 300px-wide one before dragging. */
function barsContainer(): Element {
  const bars = document.querySelector('div[role="button"]');
  if (bars === null) throw new Error('histogram bars not rendered');
  bars.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  return bars;
}

function dragHistogram(fromX: number, toX: number): void {
  const bars = barsContainer();
  fireEvent.mouseDown(bars, { clientX: fromX, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: toX, clientY: 100 });
  fireEvent.mouseUp(window);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExplorerView — persisted session', () => {
  it('restores the last hourly range, labels hourly buckets, and drag-zooms to an hour window', async () => {
    const api = new ReadOnlyPrefsApi();
    api.overview = HOURLY_OVERVIEW;
    api.prefs = {
      hiddenColumns: [...DEFAULT_EXPLORER_HIDDEN_COLUMNS],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-10'), end: asDateString('2026-03-10') },
      lastUsedGranularity: 'hourly',
    };
    const cancel = vi.spyOn(api, 'cancelPendingQueries');
    renderExplorer(api);

    await waitFor(() => { expect(api.overviewCalls).toHaveLength(1); });
    expect(api.overviewCalls[0]).toEqual(expect.objectContaining({
      dateRange: { start: '2026-03-10', end: '2026-03-10' },
      granularity: 'hourly',
    }));
    expect(await screen.findByText('Hourly total')).toBeDefined();
    // Hourly buckets get "MM-DD HH:MM" axis labels.
    expect(await screen.findByText('03-10 10:00')).toBeDefined();

    dragHistogram(5, 95); // bars 0–1 of 6 → 10:00 and 11:00

    await waitFor(() => { expect(api.overviewCalls).toHaveLength(2); });
    expect(api.overviewCalls[1]?.dateRange).toEqual({
      start: '2026-03-10',
      end: '2026-03-10',
      startHour: '2026-03-10 10:00:00',
      endHour: '2026-03-10 11:00:00',
    });
    expect(api.overviewCalls[1]?.granularity).toBe('hourly');
    // The restore itself is not a change; the zoom is, so it cancels in-flight work.
    expect(cancel).toHaveBeenCalledOnce();
    // A failing save never surfaces — the UI keeps the zoomed window.
    await waitFor(() => {
      expect(api.savedExplorerPreferences.at(-1)?.lastUsedDateRange).toEqual(api.overviewCalls[1]?.dateRange);
    });
    expect(screen.queryByText('read-only preferences')).toBeNull();
  });

  it.each([
    { name: 'daily keys', keys: ['2026-03-10', '2026-03-11', '2026-03-12'] },
    { name: 'a malformed last key', keys: ['2026-03-10 10:00:00', '2026-03-10 11:00:00', '2026-03-10T12'] },
  ])('ignores an hourly drag over buckets that are not hour keys ($name)', async ({ keys }) => {
    const api = new ExplorerApi();
    api.overview = {
      ...HOURLY_OVERVIEW,
      dailyTotals: keys.map((date, i) => ({ date, cost: 100 + i, rows: 1 })),
    };
    api.prefs = {
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-10'), end: asDateString('2026-03-12') },
      lastUsedGranularity: 'hourly',
    };
    renderExplorer(api);
    await screen.findByText('Hourly total');
    await screen.findAllByRole('img');

    dragHistogram(5, 295); // all three bars

    // The range is unchanged: the picker still shows the restored dates.
    expect(screen.getByRole('button', { name: /2026-03-10 → 2026-03-12/ })).toBeDefined();
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(api.overviewCalls).toHaveLength(1);
  });

  it('applies the persisted column order, skipping unknown and repeated keys, and resets it', async () => {
    const api = new ExplorerApi();
    api.prefs = {
      hiddenColumns: [...DEFAULT_EXPLORER_HIDDEN_COLUMNS],
      columnOrder: ['cost', 'usage_date', 'not_a_column', 'cost'],
    };
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    expect(visibleHeaders()).toEqual([
      'Cost', 'Date', 'Charge Category', 'Service Category', 'Region',
      'Account', 'Resource', 'Description', 'SKU Meter', 'Team', 'Environment',
    ]);

    await user.click(screen.getByRole('button', { name: /^Columns/ }));
    await user.click(screen.getByRole('button', { name: 'Reset order' }));

    expect(api.savedExplorerPreferences.at(-1)).toEqual({ columnOrder: [] });
    await waitFor(() => { expect(visibleHeaders().slice(0, 3)).toEqual(['Date', 'Charge Category', 'Cost']); });
  });
});

describe('ExplorerView — sample rows', () => {
  it('formats credits, unnamed accounts, zero usage and hour cells', async () => {
    const api = new ExplorerApi();
    api.overview = HOURLY_OVERVIEW;
    api.prefs = {
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-10'), end: asDateString('2026-03-10') },
      lastUsedGranularity: 'hourly',
    };
    renderExplorer(api);
    await screen.findByText('Hourly total');
    await screen.findByRole('table');

    expect(visibleHeaders()).toEqual(expect.arrayContaining(['Hour', 'List', 'Usage', 'Service', 'Operation']));
    expect(cell(0, 'Hour').textContent).toBe('14:00:00');
    expect(cell(1, 'Hour').textContent).toBe('15:30:00');
    // A row from the daily tier carries no hour at all.
    expect(cell(2, 'Hour').textContent).toBe('');
    // No resolved account name: fall back to the id.
    expect(cell(0, 'Account').textContent).toBe('111111111111');
    expect(cell(1, 'Account').textContent).toBe('staging');
    // Credits are signed and flagged.
    const credit = within(cell(0, 'Cost')).getByText('-$12.50');
    expect(credit.className).toContain('text-warning');
    expect(cell(0, 'List').textContent).toBe('-$12.50');
    expect(cell(1, 'Cost').textContent).toBe('$420.00');
    // Zero usage renders blank rather than "0".
    expect(cell(0, 'Usage').textContent).toBe('');
    expect(cell(1, 'Usage').textContent).toBe('24');
    // A row without the tag shows an empty cell.
    expect(cell(1, 'Team').textContent).toBe('');
  });

  it('expands a row into a detail grid that omits empty fields and labels tags', async () => {
    const api = new ExplorerApi();
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    await user.click(cell(0, 'Date'));

    const detail = screen.getByText('Account ID').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    const value = (label: string): string | null => {
      const labelEl = within(detail).queryByText(label, { selector: 'span' });
      return labelEl?.nextElementSibling?.textContent ?? null;
    };
    expect(value('Account ID')).toBe('111111111111');
    expect(value('Hour')).toBe('2026-03-10 14:00:00');
    expect(value('Cost')).toBe('-$12.50');
    expect(value('List Cost')).toBe('-$12.50');
    expect(value('Charge Category')).toBe('Credit');
    expect(value('Resource')).toBe('i-0abc');
    // Configured tag → its label; unconfigured tag → its raw key.
    expect(value('Team')).toBe('platform');
    expect(value('tag_cost_center')).toBe('cc-42');
    // Empty values are dropped entirely.
    expect(value('Account Name')).toBeNull();
    expect(value('Usage Amount')).toBeNull();
    expect(value('Environment')).toBeNull();

    // Clicking again collapses it.
    await user.click(cell(0, 'Date'));
    expect(screen.queryByText('Account ID')).toBeNull();
  });

  it('shows the formatted usage amount in the detail grid when non-zero', async () => {
    const api = new ExplorerApi();
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    await user.click(cell(1, 'Date'));
    const detail = screen.getByText('Usage Amount').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    expect(within(detail).getByText('Usage Amount').nextElementSibling?.textContent).toBe('24');
    expect(within(detail).getByText('Account Name').nextElementSibling?.textContent).toBe('staging');
  });
});

describe('ExplorerView — histogram', () => {
  it('shows a hover tooltip, hidden while dragging, and live drag edge labels', async () => {
    const api = new ExplorerApi();
    renderExplorer(api);
    const bars = await screen.findAllByRole('img');
    const third = bars[2];
    if (third === undefined) throw new Error('bar not rendered');

    fireEvent.mouseEnter(third);
    expect(screen.getByText('Rows')).toBeDefined();
    expect(screen.getByText('102')).toBeDefined();
    fireEvent.mouseLeave(third);
    expect(screen.queryByText('Rows')).toBeNull();

    const container = barsContainer();
    fireEvent.mouseDown(container, { clientX: 5, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 85, clientY: 100 });
    // Mid-drag: hovering a bar shows no tooltip, the edges show their dates.
    fireEvent.mouseEnter(third);
    expect(screen.queryByText('Rows')).toBeNull();
    expect(screen.getByText('Mar 1')).toBeDefined();
    expect(screen.getByText('Mar 3')).toBeDefined();
    fireEvent.mouseUp(window);
    expect(screen.queryByText('Mar 1')).toBeNull();
  });

  it('labels a single-bucket histogram at the left edge', async () => {
    const api = new ExplorerApi();
    api.overview = dailyOverview(1);
    renderExplorer(api);
    await screen.findAllByRole('img');
    const label = screen.getByText('03-01');
    expect(label.style.left).toBe('0%');
  });
});

/** Overview/rows calls that the test settles by hand, in any order. */
class ManualApi extends ExplorerApi {
  readonly overviewSettlers: { resolve: (v: ExplorerOverviewResult) => void; reject: (e: unknown) => void }[] = [];
  readonly rowsSettlers: { resolve: (v: ExplorerRowsResult) => void; reject: (e: unknown) => void }[] = [];

  override queryExplorerOverview(params?: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
    if (params !== undefined) this.overviewCalls.push(params);
    return new Promise((resolve, reject) => { this.overviewSettlers.push({ resolve, reject }); });
  }

  override queryExplorerRows(params?: ExplorerRowsParams): Promise<ExplorerRowsResult> {
    if (params !== undefined) this.rowsCalls.push(params);
    return new Promise((resolve, reject) => { this.rowsSettlers.push({ resolve, reject }); });
  }
}

/** The totals line for a row count, in whatever grouping the runtime locale uses. */
function lineItems(rows: number): RegExp {
  return new RegExp(`${rows.toLocaleString()} line items`);
}

function settler<T>(list: readonly T[], idx: number): T {
  const s = list[idx];
  if (s === undefined) throw new Error(`no pending call #${String(idx)}`);
  return s;
}

describe('ExplorerView — out-of-order responses', () => {
  it('only applies the latest overview and rows answers', async () => {
    const api = new ManualApi();
    const { user } = renderExplorer(api);
    await waitFor(() => { expect(api.overviewSettlers).toHaveLength(1); });

    // A second request supersedes the first while both are in flight.
    await user.click(screen.getByRole('checkbox', { name: /Apply Cost Scope/ }));
    await waitFor(() => { expect(api.overviewSettlers).toHaveLength(2); });
    await waitFor(() => { expect(api.rowsSettlers).toHaveLength(2); });

    // The stale request failing must not end the newer request's loading state.
    settler(api.overviewSettlers, 0).reject(new Error('stale overview failure'));
    settler(api.rowsSettlers, 0).reject(new Error('stale rows failure'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.queryByText('No data in the selected range.')).toBeNull();
    expect(screen.queryByText('stale rows failure')).toBeNull();

    settler(api.overviewSettlers, 1).resolve(dailyOverview(10, 2_222));
    settler(api.rowsSettlers, 1).resolve(DETAIL_ROWS);
    expect(await screen.findByText(lineItems(2_222))).toBeDefined();
    await screen.findByRole('table');

    // A third request answered first; the second's late answer is ignored.
    await user.click(screen.getByRole('radio', { name: /Billed/ }));
    await waitFor(() => { expect(api.overviewSettlers).toHaveLength(3); });
    await user.click(screen.getByRole('radio', { name: /List price/ }));
    await waitFor(() => { expect(api.overviewSettlers).toHaveLength(4); });
    await waitFor(() => { expect(api.rowsSettlers).toHaveLength(4); });
    settler(api.overviewSettlers, 3).resolve(dailyOverview(10, 4_444));
    settler(api.rowsSettlers, 3).resolve({ sampleRows: [], tagColumns: TAG_COLUMNS });
    expect(await screen.findByText(lineItems(4_444))).toBeDefined();
    settler(api.overviewSettlers, 2).resolve(dailyOverview(10, 3_333));
    settler(api.rowsSettlers, 2).resolve(DETAIL_ROWS);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.getByText(lineItems(4_444))).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a non-Error rows rejection as text', async () => {
    const api = new ManualApi();
    renderExplorer(api);
    await waitFor(() => { expect(api.rowsSettlers).toHaveLength(1); });
    settler(api.rowsSettlers, 0).reject('rows query timed out');
    settler(api.overviewSettlers, 0).reject('overview query timed out');
    expect(await screen.findByText('rows query timed out')).toBeDefined();
    expect(await screen.findByText('No data in the selected range.')).toBeDefined();
  });
});
