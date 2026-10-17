import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaselineRecord,
  BaselineScope,
  BaselinesListResult,
  CostGoblinConfig,
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  Dimension,
  EntityDetailParams,
  EntityDetailResult,
  ExplorerPreferences,
  ExplorerPreferencesUpdate,
} from '@costgoblin/core/browser';
import {
  asBucketPath,
  asDateString,
  asDimensionId,
  asDollars,
  asEntityRef,
  asProviderName,
  asTagValue,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { EntityDetail } from '../views/entity-detail.js';

const DETAIL: EntityDetailResult = {
  entity: asEntityRef('platform'),
  totalCost: asDollars(4_200),
  previousCost: asDollars(4_000),
  percentChange: 5,
  dailyCosts: [
    { date: asDateString('2026-03-01'), cost: asDollars(1_400), breakdown: {}, breakdownByAccount: {} },
    { date: asDateString('2026-03-02'), cost: asDollars(2_800), breakdown: {}, breakdownByAccount: {} },
  ],
  byAccount: [{ name: 'prod-main', cost: asDollars(4_200), percentage: 100 }],
  byService: [
    { name: 'Amazon EC2', cost: asDollars(3_000), percentage: 71.4 },
    { name: 'Amazon S3', cost: asDollars(1_200), percentage: 28.6 },
  ],
  bySubEntity: [],
};

/** Ten daily bars, or six hourly ones on 2026-03-10 when asked for hours. */
function dailyCosts(granularity: DailyCostsParams['granularity']): DailyCostsResult {
  const days = granularity === 'hourly'
    ? Array.from({ length: 6 }, (_, i) => `2026-03-10 ${String(10 + i).padStart(2, '0')}:00`)
    : Array.from({ length: 10 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
  return {
    days: days.map((date, i) => ({
      date: asDateString(date),
      total: asDollars(100 + i),
      breakdown: { 'Amazon EC2': asDollars(60 + i), 'Amazon S3': asDollars(40) },
    })),
    groups: ['Amazon EC2', 'Amazon S3'],
    totalCost: asDollars(1_045),
  };
}

const HOURLY_CONFIG: CostGoblinConfig = {
  providers: [
    {
      name: asProviderName('aws-main'),
      type: 'aws',
      credentialsProfile: 'default',
      sync: {
        daily: { bucket: asBucketPath('cur/daily'), retentionDays: 90 },
        hourly: { bucket: asBucketPath('cur/hourly'), retentionDays: 30 },
        intervalMinutes: 60,
      },
    },
  ],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

class DetailApi extends MockCostApi {
  readonly detailCalls: EntityDetailParams[] = [];
  readonly costCalls: CostQueryParams[] = [];
  readonly dailyCalls: DailyCostsParams[] = [];
  detail: EntityDetailResult = DETAIL;
  prefs: ExplorerPreferences = { hiddenColumns: [], columnOrder: [] };
  dailyKeys: 'by-granularity' | 'daily' = 'by-granularity';

  override queryEntityDetail(params?: EntityDetailParams): Promise<EntityDetailResult> {
    if (params !== undefined) this.detailCalls.push(params);
    return Promise.resolve(this.detail);
  }

  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params !== undefined) this.costCalls.push(params);
    return super.queryCosts();
  }

  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params !== undefined) this.dailyCalls.push(params);
    return Promise.resolve(dailyCosts(this.dailyKeys === 'daily' ? 'daily' : params?.granularity));
  }

  override getExplorerPreferences(): Promise<ExplorerPreferences> {
    return Promise.resolve(this.prefs);
  }
}

function renderDetail(api: MockCostApi = new DetailApi(), props: { entity?: string; dimension?: string } = {}) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <EntityDetail entity={props.entity ?? 'platform'} dimension={props.dimension ?? 'account'} onBack={vi.fn()} />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

/** The histogram's drag surface; jsdom has no layout, so pin a 300px rect. */
function dragHistogram(fromX: number, toX: number): void {
  const bars = document.querySelector('div[role="button"]');
  if (bars === null) throw new Error('histogram bars not rendered');
  bars.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  fireEvent.mouseDown(bars, { clientX: fromX, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: toX, clientY: 100 });
  fireEvent.mouseUp(window);
}

async function waitForBars(): Promise<void> {
  await waitFor(() => { expect(document.querySelector('div[role="button"]')).not.toBeNull(); });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EntityDetail — CSV export', () => {
  let exported: Blob | undefined;
  const urlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const revoked: string[] = [];

  beforeEach(() => {
    exported = undefined;
    revoked.length = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob): string => {
        exported = blob;
        return 'blob:entity-csv';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string): void => { revoked.push(url); },
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of [['createObjectURL', urlDescriptor], ['revokeObjectURL', revokeDescriptor]] as const) {
      if (descriptor === undefined) Reflect.deleteProperty(URL, key);
      else Object.defineProperty(URL, key, descriptor);
    }
  });

  it('downloads the summary, daily series and breakdowns as one CSV', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { user } = renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    if (exported === undefined) throw new Error('nothing was exported');
    expect((await exported.text()).split('\n')).toEqual([
      'Entity,platform',
      'Total Cost,4200',
      'Percent Change,5',
      '',
      'Date,Cost',
      '2026-03-01,1400',
      '2026-03-02,2800',
      '',
      'Account,Cost,Percentage',
      'prod-main,4200,100',
      '',
      'Service,Cost,Percentage',
      'Amazon EC2,3000,71.4',
      'Amazon S3,1200,28.6',
    ]);
    const link = click.mock.contexts[0];
    if (!(link instanceof HTMLAnchorElement)) throw new Error('no download link clicked');
    expect(link.download).toBe('costgoblin-platform-detail.csv');
    expect(link.href).toBe('blob:entity-csv');
    expect(revoked).toEqual(['blob:entity-csv']);
  });
});

describe('EntityDetail — summary', () => {
  it.each([
    { percentChange: -4.5, shown: '-4.5%', color: 'text-positive' },
    { percentChange: 0, shown: '+0.0%', color: 'text-text-secondary' },
    { percentChange: 12, shown: '+12.0%', color: 'text-negative' },
  ])('colours a $shown change $color', async ({ percentChange, shown, color }) => {
    const api = new DetailApi();
    api.detail = { ...DETAIL, percentChange };
    renderDetail(api);
    const change = await screen.findByText(shown);
    expect(change.className).toContain(color);
  });

  it('shows zero shares for an entity whose breakdowns cost nothing', async () => {
    class ZeroApi extends DetailApi {
      override queryCosts(): Promise<CostResult> {
        return Promise.resolve({
          rows: [{ entity: asEntityRef('idle'), totalCost: asDollars(0), serviceCosts: {} }],
          totalCost: asDollars(0),
          topServices: [],
          dateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-03-10') },
        });
      }
    }
    renderDetail(new ZeroApi());
    const zeroShares = await screen.findAllByText('$0.00 (0.0%)');
    expect(zeroShares.length).toBeGreaterThan(0);
  });

  it('shows the query error instead of the summary', async () => {
    const api = new DetailApi();
    vi.spyOn(api, 'queryEntityDetail').mockRejectedValue(new Error('Catalog Error: table not found'));
    renderDetail(api);
    expect(await screen.findByText('Catalog Error: table not found')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('expands the histogram over the summary cards and collapses it back', async () => {
    const { user } = renderDetail();
    await screen.findByText('vs Previous Period');

    await user.click(screen.getByTitle('Expand'));
    expect(screen.queryByText('vs Previous Period')).toBeNull();
    await user.click(screen.getByTitle('Collapse'));
    expect(screen.getByText('vs Previous Period')).toBeDefined();
  });
});

describe('EntityDetail — pies and histogram tabs', () => {
  it('orders the pie dimension pickers by concept and re-queries a changed pie', async () => {
    const api = new DetailApi();
    const dims: Dimension[] = [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
      { tagName: 'cost_center', label: 'Cost center' },
      { name: asDimensionId('service'), label: 'Service', field: 'service' },
      { tagName: 'bu', label: 'Business unit', concept: 'unit' },
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { tagName: 'product', label: 'Product', concept: 'product' },
      { tagName: 'env', label: 'Environment', concept: 'environment' },
    ];
    vi.spyOn(api, 'getDimensions').mockResolvedValue(dims);
    const { user } = renderDetail(api);

    await waitFor(() => { expect(screen.getAllByRole('combobox', { name: 'Group by dimension' })).toHaveLength(3); });
    const pickers = screen.getAllByRole('combobox', { name: 'Group by dimension' });
    const [first] = pickers;
    if (first === undefined) throw new Error('no pie picker');
    expect(within(first).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Environment', 'Product', 'Team', 'Business unit', 'Account', 'Service', 'Cost center',
    ]);
    // Defaults: account, then the product tag, then service.
    expect(pickers.map(p => (p instanceof HTMLSelectElement ? p.value : ''))).toEqual(['account', 'tag_product', 'service']);

    await user.selectOptions(first, 'service');
    await waitFor(() => {
      expect(api.costCalls.some(c => c.origin === 'entity-detail:pie1:service')).toBe(true);
    });
    const pie1 = api.costCalls.find(c => c.origin === 'entity-detail:pie1:service');
    expect(pie1?.filters).toEqual({ account: ['platform'] });
  });

  it('groups the histogram by the owner and product tags, falling back to service', async () => {
    const api = new DetailApi();
    const { user } = renderDetail(api);
    await screen.findByText('Daily Costs');

    await user.click(screen.getByRole('button', { name: 'Groups' }));
    await waitFor(() => { expect(api.dailyCalls.at(-1)?.groupBy).toBe('tag_team'); });
    await user.click(screen.getByRole('button', { name: 'Products' }));
    await waitFor(() => { expect(api.dailyCalls.at(-1)?.groupBy).toBe('tag_product'); });
    expect(api.dailyCalls.at(-1)?.origin).toBe('entity-detail:histogram:tag_product');
  });

  it('keeps the histogram on service when the owner and product tags are missing', async () => {
    const api = new DetailApi();
    vi.spyOn(api, 'getDimensions').mockResolvedValue([
      { name: asDimensionId('service'), label: 'Service', field: 'service' },
      { name: asDimensionId('region'), label: 'Region', field: 'region' },
    ]);
    const { user } = renderDetail(api);
    await screen.findByText('Daily Costs');
    await waitFor(() => { expect(api.costCalls.some(c => c.origin === 'entity-detail:pie2:region')).toBe(true); });

    await user.click(screen.getByRole('button', { name: 'Groups' }));
    await user.click(screen.getByRole('button', { name: 'Products' }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(new Set(api.dailyCalls.map(c => c.groupBy))).toEqual(new Set(['service']));
  });
});

describe('EntityDetail — date range', () => {
  it('zooms into a dragged daily range without a hint when it spans more than a week', async () => {
    const api = new DetailApi();
    renderDetail(api);
    await waitForBars();

    dragHistogram(0, 270); // bars 0–8 → Mar 1 … Mar 9
    await waitFor(() => {
      expect(api.detailCalls.at(-1)?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-09' });
    });
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
    await waitFor(() => {
      expect(api.savedExplorerPreferences.at(-1)?.lastUsedDateRange).toEqual({ start: '2026-03-01', end: '2026-03-09' });
    });
  });

  it('cancels the queries in flight when the user changes a restored range, but not for the restore itself', async () => {
    const api = new DetailApi();
    api.prefs = {
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-03-10') },
      lastUsedGranularity: 'daily',
    };
    const cancel = vi.spyOn(api, 'cancelPendingQueries');
    renderDetail(api);
    await waitFor(() => {
      expect(api.detailCalls.at(-1)?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-10' });
    });
    await waitForBars();
    expect(cancel).not.toHaveBeenCalled();

    dragHistogram(0, 270);
    await waitFor(() => { expect(cancel).toHaveBeenCalledOnce(); });
  });

  it('hints at the hourly tier for a short daily range when it is not configured', async () => {
    const api = new DetailApi();
    const { user } = renderDetail(api);
    await waitForBars();

    dragHistogram(0, 90); // bars 0–2 → Mar 1 … Mar 3
    expect(await screen.findByText(/hourly tier isn/)).toBeDefined();
    expect(api.detailCalls.at(-1)?.granularity).toBe('daily');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });

  it('switches a short daily range to hourly when the hourly tier is configured', async () => {
    const api = new DetailApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(HOURLY_CONFIG);
    renderDetail(api);
    await waitForBars();

    dragHistogram(0, 90);
    expect(await screen.findByText('Hourly Costs')).toBeDefined();
    await waitFor(() => { expect(api.detailCalls.at(-1)?.granularity).toBe('hourly'); });
    expect(api.detailCalls.at(-1)?.dateRange).toEqual({ start: '2026-03-01', end: '2026-03-03' });
    expect(screen.queryByText(/hourly tier isn/)).toBeNull();
  });

  it('zooms an hourly histogram into an hour window', async () => {
    const api = new DetailApi();
    api.prefs = {
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-10'), end: asDateString('2026-03-10') },
      lastUsedGranularity: 'hourly',
    };
    renderDetail(api);
    expect(await screen.findByText('Hourly Costs')).toBeDefined();
    await waitFor(() => { expect(api.dailyCalls.at(-1)?.granularity).toBe('hourly'); });
    await waitForBars();

    dragHistogram(5, 95); // bars 0–1 of 6 → 10:00 and 11:00
    await waitFor(() => {
      expect(api.detailCalls.at(-1)?.dateRange).toEqual({
        start: '2026-03-10',
        end: '2026-03-10',
        startHour: '2026-03-10 10:00:00',
        endHour: '2026-03-10 11:00:00',
      });
    });
  });

  it('ignores an hourly drag over bars that carry no hour', async () => {
    const api = new DetailApi();
    api.dailyKeys = 'daily';
    api.prefs = {
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: asDateString('2026-03-01'), end: asDateString('2026-03-10') },
      lastUsedGranularity: 'hourly',
    };
    renderDetail(api);
    await screen.findByText('Hourly Costs');
    await waitFor(() => { expect(api.detailCalls.at(-1)?.granularity).toBe('hourly'); });
    await waitForBars();
    const callsBefore = api.detailCalls.length;

    dragHistogram(0, 270);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(api.detailCalls).toHaveLength(callsBefore);
    expect(screen.getByRole('button', { name: /2026-03-01 → 2026-03-10/ })).toBeDefined();
  });

  it('re-queries every panel for a preset range', async () => {
    const api = new DetailApi();
    const { user } = renderDetail(api);
    await screen.findByText('Daily Costs');

    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 90 days' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Last 90 days/ })).toBeDefined();
    });
    const range = api.detailCalls.at(-1)?.dateRange;
    expect(api.dailyCalls.at(-1)?.dateRange).toEqual(range);
    expect(api.costCalls.at(-1)?.dateRange).toEqual(range);
  });

  it('still persists ranges after the saved preferences fail to load', async () => {
    class BrokenPrefsApi extends DetailApi {
      override getExplorerPreferences(): Promise<ExplorerPreferences> {
        return Promise.reject(new Error('prefs unreadable'));
      }

      override saveExplorerPreferences(prefs: ExplorerPreferencesUpdate): Promise<void> {
        void super.saveExplorerPreferences(prefs);
        return Promise.reject(new Error('prefs read-only'));
      }
    }
    const api = new BrokenPrefsApi();
    renderDetail(api);
    await waitForBars();
    expect(api.savedExplorerPreferences).toHaveLength(0);

    dragHistogram(0, 270);
    await waitFor(() => {
      expect(api.savedExplorerPreferences.at(-1)).toEqual({
        lastUsedDateRange: { start: '2026-03-01', end: '2026-03-09' },
        lastUsedGranularity: 'daily',
      });
    });
    expect(screen.queryByText('prefs read-only')).toBeNull();
  });
});

describe('EntityDetail — baselines panel', () => {
  function baseline(id: string, scope: BaselineScope, scopeLabel: string, potentialMonthly: number, name?: string): BaselineRecord {
    return {
      spec: {
        id,
        source: 'discovered',
        scope,
        basis: { costMetric: 'effective', rules: [] },
        basisSnapshotAt: '2026-03-01T00:00:00Z',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
        ...(name === undefined ? {} : { name }),
      },
      stats: null,
      current: null,
      savings: {
        potentialDaily: asDollars(potentialMonthly / 30),
        realizedDaily: asDollars(0),
        potentialMonthly: asDollars(potentialMonthly),
        realizedMonthly: asDollars(0),
      },
      status: potentialMonthly > 0 ? 'over' : 'in-band',
      triageStatus: 'new',
      effectiveLower: asDollars(90),
      effectiveUpper: asDollars(110),
      currentDaily: asDollars(100),
      potentialDaily: asDollars(potentialMonthly / 30),
      realizedDaily: asDollars(0),
      bestAchieved: null,
      scopeLabel,
      triage: { notes: [] },
    };
  }

  function listResult(items: readonly BaselineRecord[]): BaselinesListResult {
    return {
      items,
      totalPotentialMonthly: asDollars(0),
      totalRealizedMonthly: asDollars(0),
      total: items.length,
      counts: { all: items.length, open: items.length, 'new': items.length, tracking: 0, acting: 0, resolved: 0, dismissed: 0, ignored: 0 },
    };
  }

  const account = asDimensionId('account');
  const team = asDimensionId('tag_team');

  it('lists the baselines scoped to this account, by value or by resolved name', async () => {
    const api = new DetailApi();
    vi.spyOn(api, 'listBaselines').mockResolvedValue(listResult([
      baseline('by-value', { kind: 'filter', filters: { [account]: [asTagValue('platform')] } }, 'platform', 120, 'Platform spend'),
      baseline('by-label', { kind: 'filter', filters: { [account]: [asTagValue('123456789012')] } }, 'platform · Amazon EC2', 0),
      baseline('view-scope', { kind: 'view', viewId: 'overview' }, 'Cost Overview', 50),
      baseline('other-dim', { kind: 'filter', filters: { [asDimensionId('service')]: [asTagValue('Amazon EC2')] } }, 'Amazon EC2', 50),
      baseline('other-account', { kind: 'filter', filters: { [account]: [asTagValue('999999999999')] } }, 'sandbox', 50),
    ]));
    renderDetail(api);

    const panel = (await screen.findByText('Baselines')).parentElement;
    if (panel === null) throw new Error('baselines panel not rendered');
    const names = within(panel).getAllByTitle(/./).filter(el => el.tagName === 'SPAN').map(el => el.textContent);
    expect(names).toEqual(['Platform spend', 'platform · Amazon EC2']);
    expect(within(panel).getByText('$120.00/mo').className).toContain('text-warning');
    expect(within(panel).getByText('$0.00/mo').className).toContain('text-text-muted');
  });

  it('matches tag-scoped baselines by value only', async () => {
    const api = new DetailApi();
    vi.spyOn(api, 'listBaselines').mockResolvedValue(listResult([
      baseline('team-platform', { kind: 'filter', filters: { [team]: [asTagValue('platform')] } }, 'platform', 75),
      baseline('team-data', { kind: 'filter', filters: { [team]: [asTagValue('data')] } }, 'platform · data', 75),
    ]));
    renderDetail(api, { dimension: 'tag_team' });

    const panel = (await screen.findByText('Baselines')).parentElement;
    if (panel === null) throw new Error('baselines panel not rendered');
    expect(within(panel).getAllByText('$75.00/mo')).toHaveLength(1);
    expect(within(panel).getByTitle('platform').textContent).toBe('platform');
    expect(within(panel).queryByTitle('platform · data')).toBeNull();
  });
});
