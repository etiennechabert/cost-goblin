import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  Dimension,
  DimensionId,
  DimensionsConfig,
  FilterMap,
  ViewSpec,
  WidgetSpec,
} from '@costgoblin/core/browser';
import {
  QUERY_CANCELLED_MESSAGE,
  asDateString,
  asDimensionId,
  asDollars,
  asEntityRef,
  asTagValue,
} from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { daysAgo } from '../lib/dates.js';
import { CustomView } from '../views/custom-view.js';
import { WIDGET_REGISTRY } from '../widgets/registry.js';
import { setReducedMotion } from './setup.js';

const ACCOUNT = asDimensionId('account');
const REGION = asDimensionId('region');
const SERVICE = asDimensionId('service');
const SERVICE_CATEGORY = asDimensionId('service_category');
const SKU_METER = asDimensionId('sku_meter');
const DESCRIPTION = asDimensionId('description');

/** What a GCP-only workspace is left with: its export can't fill Service
 *  Category or SKU Meter, and Description is off by default. */
const GCP_ONLY: DimensionsConfig = {
  builtIn: [
    { name: ACCOUNT, label: 'Project', field: 'account_id', displayField: 'account_name' },
    { name: REGION, label: 'Region', field: 'region' },
    { name: SERVICE, label: 'Service', field: 'service' },
    { name: DESCRIPTION, label: 'Description', field: 'description', enabled: false },
  ],
  tags: [],
};

/** SKU Meter is off by default on AWS, and still where a service drills down
 *  to. An AWS-only workspace has no Description. */
const AWS_ONLY: DimensionsConfig = {
  builtIn: [
    { name: ACCOUNT, label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: REGION, label: 'Region', field: 'region' },
    { name: SERVICE, label: 'Service', field: 'service' },
    { name: SERVICE_CATEGORY, label: 'Service Category', field: 'service_category' },
    { name: SKU_METER, label: 'SKU Meter', field: 'sku_meter', enabled: false },
  ],
  tags: [],
};

/** A cancelled query as the renderer receives it: Electron prefixes a rejection
 *  from the main process. */
const CANCELLED_OVER_IPC = `Error invoking remote method 'query:costs': Error: ${QUERY_CANCELLED_MESSAGE}`;

const COST_PER_GROUP = 100;

function costResult(groups: readonly string[]): CostResult {
  return {
    rows: groups.map(group => ({ entity: asEntityRef(group), totalCost: asDollars(COST_PER_GROUP), serviceCosts: {} })),
    totalCost: asDollars(COST_PER_GROUP * groups.length),
    topServices: [],
    dateRange: { start: daysAgo(30), end: daysAgo(1) },
  };
}

function dailyResult(groups: readonly string[]): DailyCostsResult {
  const breakdown = Object.fromEntries(groups.map(group => [group, asDollars(COST_PER_GROUP)]));
  const total = asDollars(COST_PER_GROUP * groups.length);
  return {
    days: groups.length === 0 ? [] : [{ date: asDateString(daysAgo(5)), total, breakdown }],
    groups: [...groups],
    totalCost: total,
  };
}

/** Answers as main does: a dimension splits into the values listed for it, a
 *  filter on it leaves the values picked, and one the config doesn't have is
 *  refused, as `resolveField` refuses it. */
class WorkspaceApi extends MockCostApi {
  readonly costCalls: CostQueryParams[] = [];
  readonly dailyCalls: DailyCostsParams[] = [];
  /** Messages the next queries grouped by a dimension fail with, oldest first. */
  readonly failures = new Map<DimensionId, string[]>();
  configError: Error | null = null;
  configReads = 0;
  private readonly config: DimensionsConfig;
  private readonly values: Readonly<Record<string, readonly string[]>>;

  constructor(config: DimensionsConfig, values: Readonly<Record<string, readonly string[]>>) {
    super();
    this.config = config;
    this.values = values;
  }

  override getDimensions(): Promise<Dimension[]> {
    return Promise.resolve(this.config.builtIn.filter(d => d.enabled !== false));
  }

  override getDimensionsConfig(): Promise<DimensionsConfig> {
    this.configReads += 1;
    return this.configError === null ? Promise.resolve(this.config) : Promise.reject(this.configError);
  }

  private groups(groupBy: DimensionId, filters: FilterMap): readonly string[] {
    const failure = this.failures.get(groupBy)?.shift();
    if (failure !== undefined) throw new Error(failure);
    if (!this.config.builtIn.some(d => d.name === groupBy)) {
      throw new Error(`Unknown dimension "${String(groupBy)}" — not found in dimensions config.`);
    }
    const picked = filters[groupBy];
    return picked === undefined || picked.length === 0 ? this.values[String(groupBy)] ?? [] : picked.map(String);
  }

  /** A throw in the executor is the rejection main's refusal comes back as. */
  private answer<R>(params: { readonly groupBy: DimensionId; readonly filters: FilterMap }, build: (groups: readonly string[]) => R): Promise<R> {
    return new Promise(resolve => { resolve(build(this.groups(params.groupBy, params.filters))); });
  }

  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params === undefined) return super.queryCosts();
    this.costCalls.push(params);
    return this.answer(params, costResult);
  }

  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params === undefined) return super.queryDailyCosts();
    this.dailyCalls.push(params);
    return this.answer(params, dailyResult);
  }
}

function groupBys(calls: readonly { readonly groupBy: DimensionId }[]): string[] {
  return calls.map(c => String(c.groupBy));
}

function pieOnly(groupBy: DimensionId): ViewSpec {
  return {
    id: 'pie-view',
    name: 'Pie view',
    rows: [{ widgets: [{ id: 'pie', type: 'pie', size: 'medium', groupBy }] }],
  };
}

const BARS_AND_PIE: ViewSpec = {
  id: 'overview',
  name: 'Overview',
  rows: [
    { widgets: [{ id: 'bars', type: 'stackedBar', size: 'full', groupBy: SERVICE }] },
    { widgets: [{ id: 'pie', type: 'pie', size: 'medium', groupBy: SERVICE }] },
  ],
};

const FILTERED_TO_BIGQUERY: FilterMap = { [SERVICE]: [asTagValue('BigQuery')] };

function renderView(api: WorkspaceApi, spec: ViewSpec, initialFilter?: FilterMap) {
  const view = render(
    <PaletteProvider>
      <CostApiProvider value={api}>
        <CustomView spec={spec} initialFilter={initialFilter} />
      </CostApiProvider>
    </PaletteProvider>,
  );
  return {
    /** The widget's slot, once it has mounted. */
    slot: (id: string): Promise<HTMLElement> => waitFor(() => {
      const el = view.container.querySelector(`[data-widget-id="${id}"]`);
      if (!(el instanceof HTMLElement)) throw new Error(`no slot ${id}`);
      return el;
    }),
  };
}

// As in custom-view.test.tsx: animated loaders set state every frame, which
// keeps restarting the transition a query result commits in.
beforeEach(() => { setReducedMotion(true); });

describe('charts grouped by Service once the filters leave one service', () => {
  describe('on a GCP-only workspace', () => {
    const GCP_VALUES = {
      service: ['BigQuery', 'Compute Engine'],
      description: ['Analysis', 'Long Term Storage'],
      account: ['acme-prod', 'acme-dev'],
      region: ['us', 'europe-west1'],
    };

    it('keeps the pie and the histogram drawn when a service is clicked, split by Description', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const user = userEvent.setup();
      const { slot } = renderView(api, BARS_AND_PIE);
      const pie = within(await slot('pie'));
      const bars = within(await slot('bars'));

      await user.click(await pie.findByRole('button', { name: /^BigQuery/ }));

      expect(await pie.findByRole('button', { name: /^Analysis/ })).toBeDefined();
      expect(pie.getByRole('button', { name: /^Long Term Storage/ })).toBeDefined();
      expect(await bars.findByRole('button', { name: 'Description' })).toBeDefined();
      // One segment per description, on the one day the fixture holds. The
      // drag-to-select plot is an unnamed role="button" too, on a <div>.
      expect(bars.getAllByRole('button', { name: '' }).filter(el => el instanceof HTMLButtonElement)).toHaveLength(2);

      // Nothing asked main for a dimension it would refuse.
      for (const asked of [groupBys(api.costCalls), groupBys(api.dailyCalls)]) {
        expect(asked).not.toContain('service_category');
        expect(asked).not.toContain('sku_meter');
      }
      expect(api.costCalls.at(-1)?.origin).toBe('widget:pie:service/fallback');
      expect(api.dailyCalls.at(-1)?.origin).toBe('widget:stackedBar:service/fallback');
    });

    it('titles the chart with the label of a dimension that is off', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      await pie.findByRole('button', { name: /^Analysis/ });
      expect(pie.getByRole('button', { name: 'Description' })).toBeDefined();
      expect(pie.queryByRole('button', { name: 'description' })).toBeNull();
    });

    it('filters on the dimension it fell back to, with a chip that clears it alone', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const user = userEvent.setup();
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      await user.click(await pie.findByRole('button', { name: /^Analysis/ }));

      // One description left too, so the pie moves on to Project.
      expect(await pie.findByRole('button', { name: /^acme-prod/ })).toBeDefined();
      expect(api.costCalls.at(-1)?.filters).toEqual({ [SERVICE]: ['BigQuery'], [DESCRIPTION]: ['Analysis'] });

      expect(await screen.findByRole('button', { name: 'Description: Analysis' })).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'Clear Description filter' }));

      expect(await pie.findByRole('button', { name: /^Analysis/ })).toBeDefined();
      expect(api.costCalls.at(-1)?.filters).toEqual({ [SERVICE]: ['BigQuery'] });
      expect(screen.queryByRole('button', { name: 'Description: Analysis' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Description filter' })).toBeNull();
    });

    it('keeps the filter on a dimension that is off when another chip is cleared', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const user = userEvent.setup();
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      await user.click(await pie.findByRole('button', { name: /^Analysis/ }));
      await screen.findByRole('button', { name: 'Description: Analysis' });
      await user.click(screen.getByRole('button', { name: 'Clear Service filter' }));

      await waitFor(() => { expect(api.costCalls.at(-1)?.filters).toEqual({ [DESCRIPTION]: ['Analysis'] }); });
    });

    it('moves on to Project when the service has one description', async () => {
      const api = new WorkspaceApi(GCP_ONLY, { ...GCP_VALUES, description: ['Analysis'] });
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^acme-prod/ })).toBeDefined();
      expect(pie.getByRole('button', { name: 'Project' })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'description', 'account']);
    });

    it('moves on to Region when the service is in one project too', async () => {
      const api = new WorkspaceApi(GCP_ONLY, { ...GCP_VALUES, description: ['Analysis'], account: ['acme-prod'] });
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^europe-west1/ })).toBeDefined();
      expect(pie.getByRole('button', { name: 'Region' })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'description', 'account', 'region']);
    });

    it('keeps the one service when nothing splits it', async () => {
      const api = new WorkspaceApi(GCP_ONLY, { ...GCP_VALUES, description: ['Analysis'], account: ['acme-prod'], region: ['us'] });
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^BigQuery/ })).toBeDefined();
      expect(pie.getByRole('button', { name: 'Service' })).toBeDefined();
    });

    it('skips a general split the user disabled', async () => {
      const accountOff: DimensionsConfig = {
        ...GCP_ONLY,
        builtIn: GCP_ONLY.builtIn.map(d => (d.name === ACCOUNT ? { ...d, enabled: false } : d)),
      };
      const api = new WorkspaceApi(accountOff, { ...GCP_VALUES, description: ['Analysis'] });
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^europe-west1/ })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'description', 'region']);
    });

    it('keeps the one service when a fallback query fails', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      api.failures.set(DESCRIPTION, ['IO Error: could not read file']);
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^BigQuery/ })).toBeDefined();
      expect(pie.getByRole('button', { name: 'Service' })).toBeDefined();
    });

    it('keeps the one service when the dimensions config does not load', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      api.configError = new Error('dimensions.yaml: bad indentation');
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^BigQuery/ })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service']);
    });

    it('leaves a cancelled fallback to useQuery to retry, rather than settling on the one service', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      api.failures.set(DESCRIPTION, [CANCELLED_OVER_IPC]);
      const { slot } = renderView(api, pieOnly(SERVICE), FILTERED_TO_BIGQUERY);
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^Analysis/ })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'description', 'service', 'description']);
    });

    it('retries a cancelled first query, rather than showing an error', async () => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      api.failures.set(SERVICE, [CANCELLED_OVER_IPC]);
      const { slot } = renderView(api, pieOnly(SERVICE));
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^BigQuery/ })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'service']);
    });

    it.each<WidgetSpec>([
      { id: 'chart', type: 'line', size: 'full', groupBy: SERVICE },
      { id: 'chart', type: 'heatmap', size: 'full', groupBy: SERVICE },
      { id: 'chart', type: 'topNBar', size: 'full', groupBy: SERVICE },
      { id: 'chart', type: 'treemap', size: 'full', groupBy: SERVICE },
    ])('titles a $type chart with the label of a dimension that is off', async spec => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const view: ViewSpec = { id: 'chart-view', name: 'Chart view', rows: [{ widgets: [spec] }] };
      const { slot } = renderView(api, view, FILTERED_TO_BIGQUERY);
      const chart = within(await slot('chart'));

      // The line and heatmap titles go on: "Description over time".
      expect(await chart.findByRole('button', { name: /^Description/ })).toBeDefined();
      expect(chart.queryByRole('button', { name: /^description/ })).toBeNull();
    });

    it.each<WidgetSpec>([
      { id: 'chart', type: 'pie', size: 'medium', groupBy: SERVICE },
      { id: 'chart', type: 'topNBar', size: 'full', groupBy: SERVICE },
      { id: 'chart', type: 'treemap', size: 'full', groupBy: SERVICE },
      { id: 'chart', type: 'line', size: 'full', groupBy: SERVICE },
    ])('compares a $type chart that fell back on the dimension it shows', async spec => {
      const api = new WorkspaceApi(GCP_ONLY, GCP_VALUES);
      const Widget = WIDGET_REGISTRY[spec.type];
      const range = { start: daysAgo(30), end: daysAgo(1) };
      render(
        <PaletteProvider>
          <CostApiProvider value={api}>
            <Widget
              spec={spec}
              dateRange={range}
              previousDateRange={range}
              compareEnabled
              granularity="daily"
              globalFilters={FILTERED_TO_BIGQUERY}
              dimensions={[]}
              onSetFilter={() => undefined}
            />
          </CostApiProvider>
        </PaletteProvider>,
      );

      const previousGroupBys = (): string[] => groupBys(
        [...api.costCalls, ...api.dailyCalls].filter(call => call.origin?.endsWith('/prev') === true),
      );
      await waitFor(() => { expect(previousGroupBys()).toContain('description'); });
      if (spec.type === 'pie') {
        // Each row found its value from the previous period.
        expect(await screen.findAllByText('↑0.0%')).toHaveLength(2);
      }
    });

    it('asks for nothing more when the filters leave no data', async () => {
      const api = new WorkspaceApi(GCP_ONLY, { ...GCP_VALUES, service: [] });
      const { slot } = renderView(api, pieOnly(SERVICE));
      await slot('pie');

      await waitFor(() => { expect(groupBys(api.costCalls)).toEqual(['service']); });
      // Past the commit of the empty result, so a fallback would have started.
      await new Promise(resolve => { setTimeout(resolve, 50); });
      expect(groupBys(api.costCalls)).toEqual(['service']);
      expect(api.configReads).toBe(0);
    });
  });

  describe('on an AWS-only workspace', () => {
    it('still drills down through Service Category, then a SKU Meter that is off, titled by its label', async () => {
      const api = new WorkspaceApi(AWS_ONLY, {
        service: ['Amazon EC2'],
        service_category: ['Compute'],
        sku_meter: ['BoxUsage:m5.large', 'EBS:VolumeUsage.gp3'],
        account: ['prod', 'staging'],
      });
      const { slot } = renderView(api, pieOnly(SERVICE));
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^BoxUsage:m5\.large/ })).toBeDefined();
      expect(pie.getByRole('button', { name: 'SKU Meter' })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'service_category', 'sku_meter']);
    });

    it('falls back to Account where the SKU Meter does not split the service either, and never asks for Description', async () => {
      const api = new WorkspaceApi(AWS_ONLY, {
        service: ['AWS Support'],
        service_category: ['Management and Governance'],
        sku_meter: ['Support-Business'],
        account: ['prod', 'staging'],
      });
      const { slot } = renderView(api, pieOnly(SERVICE));
      const pie = within(await slot('pie'));

      expect(await pie.findByRole('button', { name: /^prod/ })).toBeDefined();
      expect(groupBys(api.costCalls)).toEqual(['service', 'service_category', 'sku_meter', 'account']);
    });
  });

  it('tries SKU Meter before Description on a mixed workspace, as AWS services expect', async () => {
    const mixed: DimensionsConfig = {
      ...AWS_ONLY,
      builtIn: [...AWS_ONLY.builtIn, { name: DESCRIPTION, label: 'Description', field: 'description', enabled: false }],
    };
    const api = new WorkspaceApi(mixed, {
      service: ['Cloud Run'],
      service_category: [''],
      sku_meter: ['A1C3-9B27-4D65'],
      description: ['CPU Allocation Time', 'Memory Allocation Time'],
    });
    const { slot } = renderView(api, pieOnly(SERVICE));
    const pie = within(await slot('pie'));

    expect(await pie.findByRole('button', { name: /^CPU Allocation Time/ })).toBeDefined();
    expect(groupBys(api.costCalls)).toEqual(['service', 'service_category', 'sku_meter', 'description']);
  });

  it('leaves a chart whose dimension has no fallback on its one value', async () => {
    const api = new WorkspaceApi(GCP_ONLY, { region: ['us'], account: ['acme-prod', 'acme-dev'] });
    const { slot } = renderView(api, pieOnly(REGION));
    const pie = within(await slot('pie'));

    expect(await pie.findByRole('button', { name: /^us/ })).toBeDefined();
    expect(groupBys(api.costCalls)).toEqual(['region']);
    expect(api.configReads).toBe(0);
  });

  it('leaves a chart with several values alone', async () => {
    const api = new WorkspaceApi(GCP_ONLY, { service: ['BigQuery', 'Compute Engine'], description: ['Analysis', 'Long Term Storage'] });
    const { slot } = renderView(api, pieOnly(SERVICE));
    const pie = within(await slot('pie'));

    expect(await pie.findByRole('button', { name: /^BigQuery/ })).toBeDefined();
    expect(groupBys(api.costCalls)).toEqual(['service']);
    expect(api.configReads).toBe(0);
    expect(screen.queryByText('Analysis')).toBeNull();
  });
});
