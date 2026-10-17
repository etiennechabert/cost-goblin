import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Dimension,
  ExplorerFilterValue,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerOverviewResult,
  ExplorerRowsParams,
  ExplorerRowsResult,
} from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ExplorerView } from '../views/explorer.js';

const OVERVIEW: ExplorerOverviewResult = {
  windowDays: 3,
  startDate: '2026-03-01',
  endDate: '2026-03-03',
  dailyTotals: [
    { date: '2026-03-01', cost: 100, rows: 10 },
    { date: '2026-03-02', cost: 120, rows: 12 },
    { date: '2026-03-03', cost: 90, rows: 9 },
  ],
  totalRows: 31,
  totalCost: 310,
  tagColumns: [],
};

const ROWS: ExplorerRowsResult = {
  sampleRows: [
    { date: '2026-03-03', hour: '', accountId: '111', accountName: 'prod-main', region: 'eu-central-1', service: 'Amazon EC2', serviceCategory: 'Compute', chargeCategory: 'Usage', operation: 'RunInstances', skuMeter: 'BoxUsage', description: 'EC2', resourceId: 'i-0abc', usageAmount: 1, cost: 50, listCost: 50, tags: {} },
    { date: '2026-03-03', hour: '', accountId: '222', accountName: 'staging', region: 'us-east-1', service: 'Amazon RDS', serviceCategory: 'Databases', chargeCategory: 'Usage', operation: 'CreateDBInstance', skuMeter: 'db.t4g', description: 'RDS', resourceId: 'db-1', usageAmount: 1, cost: 40, listCost: 40, tags: {} },
  ],
  tagColumns: [],
};

const VALUES: Readonly<Record<string, readonly ExplorerFilterValue[]>> = {
  service: [
    { value: 'Amazon EC2', label: 'Amazon EC2', cost: 18_000, rows: 8_400 },
    { value: 'Amazon RDS', label: 'Amazon RDS', cost: 9_500, rows: 3_200 },
    { value: 'Amazon S3', label: 'Amazon S3', cost: 6_200, rows: 12_800 },
  ],
  region: [
    { value: 'eu-central-1', label: 'eu-central-1', cost: 20_000, rows: 9_000 },
    { value: 'us-east-1', label: 'us-east-1', cost: 13_700, rows: 5_000 },
  ],
};

class FilterApi extends MockCostApi {
  readonly overviewCalls: ExplorerOverviewParams[] = [];
  readonly rowsCalls: ExplorerRowsParams[] = [];
  readonly valueCalls: ExplorerFilterValuesParams[] = [];

  override queryExplorerOverview(params?: ExplorerOverviewParams): Promise<ExplorerOverviewResult> {
    if (params !== undefined) this.overviewCalls.push(params);
    return Promise.resolve(OVERVIEW);
  }

  override queryExplorerRows(params?: ExplorerRowsParams): Promise<ExplorerRowsResult> {
    if (params !== undefined) this.rowsCalls.push(params);
    return Promise.resolve(ROWS);
  }

  override getExplorerFilterValues(params?: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
    if (params !== undefined) this.valueCalls.push(params);
    return Promise.resolve([...(VALUES[params?.dimensionId ?? ''] ?? [])]);
  }
}

/** Filter-value requests that the test settles by hand. */
class ManualValuesApi extends FilterApi {
  readonly pending: {
    readonly dimId: string;
    readonly resolve: (v: ExplorerFilterValue[]) => void;
    readonly reject: (e: unknown) => void;
  }[] = [];

  override getExplorerFilterValues(params?: ExplorerFilterValuesParams): Promise<ExplorerFilterValue[]> {
    const dimId = params?.dimensionId ?? '';
    return new Promise((resolve, reject) => { this.pending.push({ dimId, resolve, reject }); });
  }
}

function renderExplorer(api: FilterApi = new FilterApi()) {
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

function searchBox(): HTMLElement | null {
  return screen.queryByPlaceholderText('Search values…');
}

function visibleHeaders(): string[] {
  return within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map(th => th.textContent.replace(/[↑↓↕]/g, '').trim());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExplorerView — dimension defaults', () => {
  it('seeds filters from dimension defaults and keeps a disabled dim visible only while filtered', async () => {
    const dims: Dimension[] = [
      { name: asDimensionId('service'), label: 'Service', field: 'service', defaultFilterValues: ['Amazon EC2'] },
      { name: asDimensionId('region'), label: 'Region', field: 'region', defaultFilterValues: [] },
      { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', enabled: false, defaultFilterValues: ['i-0abc'] },
      { name: asDimensionId('operation'), label: 'Operation', field: 'operation', enabled: false },
    ];
    const api = new FilterApi();
    vi.spyOn(api, 'getDimensions').mockResolvedValue(dims);
    const { user } = renderExplorer(api);

    await waitFor(() => { expect(api.rowsCalls.length).toBeGreaterThan(0); });
    expect(api.rowsCalls.at(-1)?.filters).toEqual({ service: ['Amazon EC2'], resource_id: ['i-0abc'] });
    expect(screen.getByRole('button', { name: 'Service: Amazon EC2' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Region' })).toBeDefined();
    // Resource is disabled but carries a filter, so its chip stays editable;
    // Operation is disabled and unfiltered, so it has no chip.
    expect(screen.getByRole('button', { name: 'Resource: i-0abc' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Operation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear all (2)' })).toBeDefined();

    // Clearing a dim's draft and applying removes that dim's filter.
    await user.click(screen.getByRole('button', { name: 'Service: Amazon EC2' }));
    await screen.findByRole('checkbox', { name: /Amazon EC2/ });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('checkbox', { name: /Amazon EC2/ })).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => { expect(api.rowsCalls.at(-1)?.filters).toEqual({ resource_id: ['i-0abc'] }); });
    expect(screen.getByRole('button', { name: 'Service' })).toBeDefined();
  });

  it('says so when no dimensions are configured, including when loading them fails', async () => {
    const api = new FilterApi();
    vi.spyOn(api, 'getDimensions').mockRejectedValue(new Error('dimensions.yaml unreadable'));
    renderExplorer(api);
    expect(await screen.findByText('No dimensions configured.')).toBeDefined();
  });
});

describe('ExplorerView — filter value picker', () => {
  it('toggles closed when its chip is clicked again, and closes on an outside click', async () => {
    const { user } = renderExplorer();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await screen.findByRole('checkbox', { name: /Amazon EC2/ });
    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(searchBox()).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Region' }));
    await screen.findByRole('checkbox', { name: /eu-central-1/ });
    await user.click(screen.getByText('Inspect the raw billing dataset.'));
    expect(searchBox()).toBeNull();
  });

  it('applies on Enter and discards on Escape', async () => {
    const { api, user } = renderExplorer();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(await screen.findByRole('checkbox', { name: /Amazon RDS/ }));
    const search = searchBox();
    if (search === null) throw new Error('search box not shown');
    await user.click(search);
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('button', { name: 'Service: Amazon RDS' })).toBeDefined();
    await waitFor(() => { expect(api.rowsCalls.at(-1)?.filters).toEqual({ service: ['Amazon RDS'] }); });
    const callsAfterApply = api.rowsCalls.length;

    await user.click(screen.getByRole('button', { name: 'Service: Amazon RDS' }));
    await user.click(await screen.findByRole('checkbox', { name: /Amazon S3/ }));
    await user.type(screen.getByPlaceholderText('Search values…'), 's3{Escape}');
    expect(searchBox()).toBeNull();
    expect(screen.getByRole('button', { name: 'Service: Amazon RDS' })).toBeDefined();
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(api.rowsCalls).toHaveLength(callsAfterApply);
  });

  it('reports when the search matches nothing', async () => {
    const { user } = renderExplorer();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await screen.findByRole('checkbox', { name: /Amazon EC2/ });
    await user.type(screen.getByPlaceholderText('Search values…'), 'lambda');
    expect(screen.getByText('No matching values.')).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /Amazon/ })).toBeNull();
  });

  it('counts multi-value chips and keeps their column, ignoring a cell click on a value already picked', async () => {
    const { api, user } = renderExplorer();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Region' }));
    await user.click(await screen.findByRole('checkbox', { name: /eu-central-1/ }));
    await user.click(screen.getByRole('checkbox', { name: /us-east-1/ }));
    // Ticking and unticking leaves the draft unchanged.
    await user.click(screen.getByRole('checkbox', { name: /us-east-1/ }));
    await user.click(screen.getByRole('checkbox', { name: /us-east-1/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByRole('button', { name: 'Region · 2' })).toBeDefined();
    await waitFor(() => { expect(api.rowsCalls.at(-1)?.filters).toEqual({ region: ['eu-central-1', 'us-east-1'] }); });
    // Two values: the column still varies, so it is not auto-hidden.
    await screen.findByRole('table');
    expect(visibleHeaders()).toContain('Region');

    const calls = api.rowsCalls.length;
    const cellButton = screen.getAllByRole('button', { name: 'eu-central-1' })[0];
    if (cellButton === undefined) throw new Error('region cell not clickable');
    await user.click(cellButton);
    expect(screen.getByRole('button', { name: 'Region · 2' })).toBeDefined();
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(api.rowsCalls).toHaveLength(calls);
  });

  it.each([
    { rejection: new Error('values query exploded'), shown: 'Failed to load: values query exploded' },
    { rejection: 'values timed out', shown: 'Failed to load: values timed out' },
  ])('shows "$shown" when the values fail to load', async ({ rejection, shown }) => {
    const api = new FilterApi();
    vi.spyOn(api, 'getExplorerFilterValues').mockRejectedValue(rejection);
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByText(shown)).toBeDefined();
  });

  it('drops answers for a dim the user has moved away from', async () => {
    const api = new ManualValuesApi();
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    // Service is still loading when the user opens Region instead.
    await user.click(screen.getByRole('button', { name: 'Service' }));
    expect(screen.getByText('Loading…')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Region' }));
    const [service, region] = api.pending;
    if (service === undefined || region === undefined) throw new Error('expected two value requests');
    expect([service.dimId, region.dimId]).toEqual(['service', 'region']);

    service.resolve([...(VALUES['service'] ?? [])]);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.queryByRole('checkbox', { name: /Amazon EC2/ })).toBeNull();
    expect(screen.getByText('Loading…')).toBeDefined();

    region.resolve([...(VALUES['region'] ?? [])]);
    expect(await screen.findByRole('checkbox', { name: /eu-central-1/ })).toBeDefined();
  });

  it('drops a failure for a dim the user has moved away from', async () => {
    const api = new ManualValuesApi();
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(screen.getByRole('button', { name: 'Region' }));
    const [service, region] = api.pending;
    if (service === undefined || region === undefined) throw new Error('expected two value requests');

    service.reject(new Error('stale failure'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.queryByText(/stale failure/)).toBeNull();
    expect(screen.getByText('Loading…')).toBeDefined();

    region.reject(new Error('region failure'));
    expect(await screen.findByText('Failed to load: region failure')).toBeDefined();
  });

  it('stays closed when answers arrive after the picker was dismissed', async () => {
    const api = new ManualValuesApi();
    const { user } = renderExplorer(api);
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(screen.getByRole('button', { name: 'Service' }));
    await user.click(screen.getByRole('button', { name: 'Region' }));
    await user.click(screen.getByText('Inspect the raw billing dataset.'));
    expect(api.pending.map(p => p.dimId)).toEqual(['service', 'region']);
    const [service, region] = api.pending;
    if (service === undefined || region === undefined) throw new Error('expected value requests');

    service.resolve([...(VALUES['service'] ?? [])]);
    region.reject(new Error('late failure'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(searchBox()).toBeNull();
    expect(screen.queryByText(/late failure/)).toBeNull();
  });
});
