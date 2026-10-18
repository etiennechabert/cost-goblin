import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavingsPreferences, SavingsRecommendation, SavingsResult } from '@costgoblin/core/browser';
import { asDollars } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { Savings } from '../views/savings.js';

const BASE: SavingsRecommendation = {
  accountId: '111111111111',
  accountName: 'Production',
  actionType: 'Rightsize',
  resourceType: 'Ec2Instance',
  summary: 'Downsize to m5.xlarge',
  region: 'eu-central-1',
  monthlySavings: asDollars(900),
  monthlyCost: asDollars(1_500),
  savingsPercentage: 60,
  effort: 'High',
  resourceArn: 'arn:aws:ec2:eu-central-1:111111111111:instance/i-0big',
  currentDetails: '',
  recommendedDetails: '',
  currentSummary: '',
  restartNeeded: true,
  rollbackPossible: false,
  recommendationSource: 'ComputeOptimizer',
};

/** A rightsizing with every shape of resource detail the parser handles:
 *  nested and flat configuration, numeric / string / missing usage fields,
 *  and junk usage entries that must be skipped. */
const RIGHTSIZE_BIG: SavingsRecommendation = {
  ...BASE,
  currentSummary: 'i-0big',
  currentDetails: JSON.stringify({
    ec2Instance: {
      configuration: { instance: { type: 'm5.4xlarge' }, tenancy: 'default' },
      costCalculation: {
        usages: [
          { usageType: 'EUC1-BoxUsage:m5.4xlarge', usageAmount: 720, unit: 'Hrs' },
          { usageType: 'EUC1-EBS:VolumeUsage.gp3', usageAmount: '100', unit: 'GB-Mo' },
          { usageAmount: true },
          'junk',
        ],
      },
    },
  }),
  recommendedDetails: JSON.stringify({ ec2Instance: { configuration: { instance: { type: 'm5.xlarge' } } } }),
};

/** Same action type (so the type counts 2), with unparseable details. */
const RIGHTSIZE_SMALL: SavingsRecommendation = {
  ...BASE,
  summary: 'Downsize to t3.small',
  monthlySavings: asDollars(100),
  effort: 'Medium',
  resourceArn: '',
  currentDetails: '{not json',
  recommendedDetails: '[]',
  restartNeeded: false,
  rollbackPossible: true,
};

const DELETE_VOLUME: SavingsRecommendation = {
  ...BASE,
  accountId: '222222222222',
  accountName: 'Staging',
  actionType: 'Delete',
  resourceType: 'EbsVolume',
  summary: 'Delete idle volume',
  monthlySavings: asDollars(300),
  effort: 'Low',
  resourceArn: 'arn:aws:ec2:us-east-1:222222222222:volume/vol-1',
  currentDetails: '{}',
  recommendedDetails: JSON.stringify({ ebsVolume: 5 }),
};

const SAVINGS_PLAN: SavingsRecommendation = {
  ...BASE,
  actionType: 'PurchaseSavingsPlans',
  resourceType: 'ComputeSavingsPlans',
  summary: 'Buy a 1-year compute plan',
  monthlySavings: asDollars(2_000),
  effort: 'VeryLow',
  resourceArn: '',
  currentDetails: JSON.stringify({ savingsPlans: { configuration: 'n/a', costCalculation: 5 } }),
  recommendedDetails: JSON.stringify({ savingsPlans: { configuration: {}, costCalculation: { usages: 'none' } } }),
  recommendationSource: 'CostExplorer',
};

const RECS: readonly SavingsRecommendation[] = [RIGHTSIZE_BIG, RIGHTSIZE_SMALL, DELETE_VOLUME, SAVINGS_PLAN];

class SavingsApi extends MockCostApi {
  recommendations: readonly SavingsRecommendation[] = RECS;
  hidden: readonly string[] = [];
  readonly saved: SavingsPreferences[] = [];

  override querySavings(): Promise<SavingsResult> {
    const total = this.recommendations.reduce((s, r) => s + r.monthlySavings, 0);
    return Promise.resolve({ recommendations: this.recommendations, totalMonthlySavings: asDollars(total) });
  }

  override getSavingsPreferences(): Promise<{ hiddenActionTypes: readonly string[] }> {
    return Promise.resolve({ hiddenActionTypes: this.hidden });
  }

  override saveSavingsPreferences(prefs?: SavingsPreferences): Promise<void> {
    if (prefs !== undefined) this.saved.push(prefs);
    return Promise.resolve();
  }
}

function renderSavings(api: SavingsApi = new SavingsApi()) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <Savings />
      </CostApiProvider>,
    ),
  };
}

function settingsButton(): HTMLElement {
  return screen.getByTitle('Configure visible recommendation types');
}

function typeCheckbox(label: string): HTMLElement {
  return screen.getByRole('checkbox', { name: new RegExp(`^${label}`) });
}

function rowFor(summary: string): HTMLElement {
  const row = screen.getByText(summary).closest('tr');
  if (row === null) throw new Error(`no row for ${summary}`);
  return row;
}

/** Recommendations arrive over IPC as untyped JSON, so AWS can report an
 *  effort level this build has never heard of. Narrow such a payload the way
 *  the app receives it, without pretending the value is a known one. */
function isRecommendation(x: unknown): x is SavingsRecommendation {
  return typeof x === 'object' && x !== null && 'actionType' in x && 'effort' in x && typeof x.effort === 'string';
}

function withUnknownEffort(rec: SavingsRecommendation, effort: string): SavingsRecommendation {
  const payload: unknown = JSON.parse(JSON.stringify({ ...rec, effort }));
  if (!isRecommendation(payload)) throw new Error('fixture is not a recommendation');
  return payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Savings — visible recommendation types', () => {
  it('hides and re-shows types from the settings panel, persisting each change', async () => {
    const { api, user } = renderSavings();
    await screen.findByText('4 recommendations · $3.3k/mo potential savings');

    await user.click(settingsButton());
    expect(screen.getByText('Visible recommendation types')).toBeDefined();
    // Every type is listed with its item count and savings, biggest first.
    expect(screen.getByText('(2 items, $1.0k/mo)')).toBeDefined();
    const labels = screen.getAllByRole('checkbox').map(c => c.closest('label')?.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^Purchase Savings Plans\(1 items?, \$2\.0k\/mo\)$/);
    expect(labels[1]).toBe('Rightsize(2 items, $1.0k/mo)');
    expect(labels[2]).toMatch(/^Delete\(1 items?, \$300\.00\/mo\)$/);

    await user.click(typeCheckbox('Rightsize'));
    expect(api.saved.at(-1)).toEqual({ hiddenActionTypes: ['Rightsize'] });
    expect(screen.getByText('1 type hidden. Settings saved automatically.')).toBeDefined();
    expect(screen.getByText('2 recommendations · $2.3k/mo potential savings')).toBeDefined();
    expect(screen.queryByText('Downsize to m5.xlarge')).toBeNull();

    await user.click(typeCheckbox('Delete'));
    expect(api.saved.at(-1)).toEqual({ hiddenActionTypes: ['Rightsize', 'Delete'] });
    expect(screen.getByText('2 types hidden. Settings saved automatically.')).toBeDefined();
    // A single remaining type needs no filter badges.
    expect(screen.queryByRole('button', { name: /^All \(/ })).toBeNull();

    await user.click(typeCheckbox('Rightsize'));
    expect(api.saved.at(-1)).toEqual({ hiddenActionTypes: ['Delete'] });
    expect(screen.getByText('Downsize to m5.xlarge')).toBeDefined();

    await user.click(settingsButton());
    expect(screen.queryByText('Visible recommendation types')).toBeNull();
  });

  it('starts with the persisted hidden types already hidden', async () => {
    const api = new SavingsApi();
    api.hidden = ['Delete'];
    const { user } = renderSavings(api);

    expect(await screen.findByText('3 recommendations · $3.0k/mo potential savings')).toBeDefined();
    expect(screen.getByRole('button', { name: /^All \(3\)/ })).toBeDefined();
    expect(screen.queryByText('Delete idle volume')).toBeNull();

    await user.click(settingsButton());
    expect(typeCheckbox('Delete')).toHaveProperty('checked', false);
    expect(typeCheckbox('Rightsize')).toHaveProperty('checked', true);
  });

  it('drops the active filter when its type gets hidden', async () => {
    const { user } = renderSavings();
    await screen.findByText('4 recommendations · $3.3k/mo potential savings');

    await user.click(screen.getByRole('button', { name: /^Delete \(1\)/ }));
    expect(screen.getByText(/^1 recommendations? · \$300\.00\/mo potential savings$/)).toBeDefined();

    await user.click(settingsButton());
    await user.click(typeCheckbox('Delete'));
    // Back to every visible type rather than an empty, hidden filter.
    expect(screen.getByText('3 recommendations · $3.0k/mo potential savings')).toBeDefined();
    expect(screen.getByRole('button', { name: /^All \(3\)/ }).className).toContain('text-accent');
  });

  it('clears a type filter when its badge is clicked again', async () => {
    const { user } = renderSavings();
    await screen.findByText('4 recommendations · $3.3k/mo potential savings');

    const rightsize = screen.getByRole('button', { name: /^Rightsize \(2\)/ });
    await user.click(rightsize);
    expect(screen.getByText('2 recommendations · $1.0k/mo potential savings')).toBeDefined();
    expect(rightsize.className).toContain('text-accent');

    await user.click(rightsize);
    expect(screen.getByText('4 recommendations · $3.3k/mo potential savings')).toBeDefined();
  });
});

describe('Savings — recommendation details', () => {
  it('shows the parsed current and recommended configuration, usage and flags', async () => {
    const { user } = renderSavings();
    await screen.findByText('Downsize to m5.xlarge');

    await user.click(rowFor('Downsize to m5.xlarge'));
    const detail = screen.getByText('Current').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    const panel = within(detail);

    expect(panel.getByText('i-0big')).toBeDefined();
    const [currentType, recommendedType] = panel.getAllByText('instance.type');
    expect(currentType?.nextElementSibling?.textContent).toBe('m5.4xlarge');
    expect(panel.getByText('tenancy').nextElementSibling?.textContent).toBe('default');
    expect(panel.getByText('Usage')).toBeDefined();
    const usages = panel.getByText('Usage').parentElement?.querySelectorAll('p:not(:first-child)') ?? [];
    expect([...usages].map(p => p.textContent)).toEqual([
      '720 Hrs (BoxUsage:m5.4xlarge)',
      '100 GB-Mo (EBS:VolumeUsage.gp3)',
      '  ()',
    ]);
    // The recommended side shows the target configuration.
    expect(recommendedType?.nextElementSibling?.textContent).toBe('m5.xlarge');
    expect(panel.getByText(BASE.resourceArn)).toBeDefined();
    expect(panel.getByText('Yes').className).toContain('text-warning');
    expect(panel.getByText('No').className).toContain('text-text-secondary');
  });

  it('shows only the summary and flags when the details cannot be parsed', async () => {
    const { user } = renderSavings();
    await screen.findByText('Downsize to t3.small');

    await user.click(rowFor('Downsize to t3.small'));
    const detail = screen.getByText('Current').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    const panel = within(detail);
    expect(panel.queryByText('Usage')).toBeNull();
    expect(panel.queryByText(/arn:aws/)).toBeNull();
    expect(panel.getByText('Yes').className).toContain('text-accent');
    expect(panel.getByText('No').className).toContain('text-text-secondary');
  });

  it.each([
    { summary: 'Delete idle volume', why: 'an empty object and a non-object resource entry' },
    { summary: 'Buy a 1-year compute plan', why: 'a flat configuration and malformed cost calculations' },
  ])('renders no configuration for $why', async ({ summary }) => {
    const { user } = renderSavings();
    await screen.findByText(summary);

    await user.click(rowFor(summary));
    const detail = screen.getByText('Current').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    // Only the header labels and the footer: no key/value grid, no usage.
    expect(within(detail).queryByText('Usage')).toBeNull();
    expect(detail.querySelectorAll('.grid-cols-\\[auto_1fr\\]')).toHaveLength(0);
    expect(within(detail).getAllByText(summary)).toHaveLength(1);
  });
});

describe('Savings — states', () => {
  it('labels each effort level, falling back to a neutral badge for an unknown one', async () => {
    const api = new SavingsApi();
    api.recommendations = [...RECS, withUnknownEffort({ ...BASE, summary: 'Migrate to Graviton' }, 'Undefined')];
    renderSavings(api);
    await screen.findByText('Migrate to Graviton');

    expect(screen.getByText('High').className).toContain('text-negative');
    expect(screen.getByText('Medium').className).toContain('text-warning');
    expect(screen.getByText('Very Low').className).toContain('text-accent');
    expect(screen.getByText('Undefined').className).toContain('text-text-muted');
  });

  it('shows the query error', async () => {
    const api = new SavingsApi();
    vi.spyOn(api, 'querySavings').mockRejectedValue(new Error('No cost optimization data synced'));
    renderSavings(api);
    expect(await screen.findByText('No cost optimization data synced')).toBeDefined();
  });

  it('explains how to get data when there are no recommendations', async () => {
    const api = new SavingsApi();
    api.recommendations = [];
    const { user } = renderSavings(api);

    expect(await screen.findByText(/No cost optimization data available/)).toBeDefined();
    expect(screen.getByText('0 recommendations · $0.00/mo potential savings')).toBeDefined();
    // Nothing to configure: the settings toggle opens no panel.
    await user.click(settingsButton());
    await waitFor(() => { expect(settingsButton().className.split(' ')).toContain('bg-bg-tertiary'); });
    expect(screen.queryByText('Visible recommendation types')).toBeNull();
  });
});
