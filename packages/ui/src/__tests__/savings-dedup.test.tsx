import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PreferredCommitment, SavingsPreferences, SavingsRecommendation, SavingsResult } from '@costgoblin/core/browser';
import { asDollars } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { commitmentPurchase, resourceAction } from '../__fixtures__/savings-recommendations.js';
import { Savings } from '../views/savings.js';

// The Savings view counts one option per resource and per commitment pool:
// a row per group, its alternatives in the expanded detail, and a commitment
// shrunk by the spend the counted resource actions remove.

// Only Fargate stands in for compute usage here, so the instance actions below
// don't shrink the plan; the scaling tests use the Fargate service.
const COMPUTE_SCOPE = { resourceTypes: ['EcsService'] };

function computePlan(id: string, term: 'OneYear' | 'ThreeYears', paymentOption: 'NoUpfront' | 'AllUpfront', savings: number): SavingsRecommendation {
  return commitmentPurchase(
    { recommendationId: id, accountName: 'Payer', summary: `Compute plan ${id}`, region: 'Global', monthlySavings: asDollars(savings), monthlyCost: asDollars(500), savingsPercentage: savings / 5 },
    { pool: 'compute', poolLabel: 'Compute Savings Plans', term, paymentOption, scope: COMPUTE_SCOPE },
  );
}

const PLAN_3Y_ALL = computePlan('csp-3y-all', 'ThreeYears', 'AllUpfront', 240);
const PLAN_3Y_NONE = computePlan('csp-3y-none', 'ThreeYears', 'NoUpfront', 200);
const PLAN_1Y_NONE = computePlan('csp-1y-none', 'OneYear', 'NoUpfront', 80);

const T2_RI = commitmentPurchase(
  { recommendationId: 'ri-t2', actionType: 'PurchaseReservedInstances', resourceType: 'Ec2ReservedInstances', summary: '32 t2.nano in eu-west-1', region: 'eu-west-1', monthlySavings: asDollars(83.03), monthlyCost: asDollars(154.41) },
  {
    pool: 'ri-t2', poolLabel: 'EC2 Reserved Instances · t2 · eu-west-1 · Linux/UNIX', term: 'ThreeYears', paymentOption: 'AllUpfront',
    offeringClass: 'Standard', coveredBy: ['compute'], scope: { resourceTypes: ['Ec2Instance'], region: 'eu-west-1', family: 't2' },
  },
);

const INSTANCE = 'arn:aws:ec2:eu-west-1:111111111111:instance/i-0d90c6fc9f3e0068c';
const GRAVITON = resourceAction({
  recommendationId: 'graviton', actionType: 'MigrateToGraviton', summary: 't4g.large', region: 'eu-west-1', resourceArn: INSTANCE,
  monthlySavings: asDollars(19.86), monthlyCost: asDollars(73.58), usage: { family: 't2', targetFamily: 't4g', deployment: null },
});
const UPGRADE = resourceAction({
  recommendationId: 'upgrade', actionType: 'Upgrade', summary: 't3.large', region: 'eu-west-1', resourceArn: INSTANCE,
  monthlySavings: asDollars(7.01), monthlyCost: asDollars(73.58), usage: { family: 't2', targetFamily: 't3', deployment: null },
});
// Removes $300 of the $500 the compute plan was sized on.
const FARGATE = resourceAction({
  recommendationId: 'fargate', actionType: 'Rightsize', resourceType: 'EcsService', summary: '256 vCPU / 512 MB', region: 'eu-west-1',
  resourceArn: 'arn:aws:ecs:eu-west-1:111111111111:service/tasks/web', monthlySavings: asDollars(300), monthlyCost: asDollars(340),
});

const ALL = [PLAN_3Y_NONE, T2_RI, PLAN_1Y_NONE, UPGRADE, PLAN_3Y_ALL, GRAVITON];

class SavingsApi extends MockCostApi {
  constructor(
    private readonly recommendations: readonly SavingsRecommendation[],
    private readonly prefs: Partial<SavingsPreferences> = {},
  ) {
    super();
  }

  override querySavings(): Promise<SavingsResult> {
    return Promise.resolve({
      recommendations: this.recommendations,
      totalMonthlySavings: asDollars(0),
      snapshots: [{ providerName: 'aws-main', date: '2026-10-13' }],
    });
  }

  override getSavingsPreferences(): Promise<SavingsPreferences> {
    return Promise.resolve({
      hiddenActionTypes: this.prefs.hiddenActionTypes ?? [],
      preferredCommitment: this.prefs.preferredCommitment ?? { term: null, paymentOption: null },
    });
  }
}

function renderSavings(api: SavingsApi) {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <Savings />
    </CostApiProvider>,
  );
  return { api, user };
}

function rowWith(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no row with ${text}`);
  return row;
}

function detailCell(): HTMLElement {
  const cell = screen.getByText('Recommended').closest('td');
  if (cell === null) throw new Error('detail row not rendered');
  return cell;
}

describe('Savings — one option per resource and per commitment pool', () => {
  it('shows a row per resource and per pool, counting one option of each', async () => {
    renderSavings(new SavingsApi(ALL));
    // The compute pool (hosting the t2 RIs) and the instance: $240 + $19.86.
    expect(await screen.findByText('2 actions · $259.86/mo potential savings')).toBeDefined();
    expect(screen.getByText(/One option counted per resource and per commitment pool, commitments at the highest-savings option · 4 alternatives not counted · COH export of 2026-10-13/)).toBeDefined();
    expect(screen.getAllByRole('row').filter(r => r.closest('tbody') !== null)).toHaveLength(2);
    expect(within(rowWith('Compute Savings Plans')).getByText('+ 3 alternatives not counted')).toBeDefined();
    expect(within(rowWith('Compute Savings Plans')).getByText('$240.00')).toBeDefined();
    expect(within(rowWith('instance/i-0d90c6fc9f3e0068c')).getByText('Migrate To Graviton')).toBeDefined();
    expect(within(rowWith('instance/i-0d90c6fc9f3e0068c')).getByText('+ 1 alternative not counted')).toBeDefined();
    // The badges count rows, not COH's list.
    expect(screen.getByRole('button', { name: /^All \(2\)/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Purchase Reserved Instances/ })).toBeNull();
  });

  it('lists the other terms of the pool and the pools it covers in the expanded row', async () => {
    const { user } = renderSavings(new SavingsApi(ALL));
    await screen.findByText('Compute Savings Plans');
    await user.click(rowWith('Compute Savings Plans'));
    const panel = within(detailCell());
    expect(panel.getByText('Not counted · instead of the option above')).toBeDefined();
    const items = panel.getAllByRole('listitem').map(li => li.textContent);
    expect(items).toEqual([
      '3-year, no upfront$200.00/mo',
      '1-year, no upfront$80.00/mo',
      'EC2 Reserved Instances · t2 · eu-west-1 · Linux/UNIX (1 option)up to $83.03/mo',
    ]);
  });

  it('lists the other actions on a resource in its expanded row', async () => {
    const { user } = renderSavings(new SavingsApi(ALL));
    await screen.findByText('instance/i-0d90c6fc9f3e0068c');
    await user.click(rowWith('instance/i-0d90c6fc9f3e0068c'));
    expect(within(detailCell()).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Upgrade · t3.large$7.01/mo']);
  });

  it('counts the term and payment option picked in the settings, and saves the pick', async () => {
    const api = new SavingsApi(ALL);
    const { user } = renderSavings(api);
    await screen.findByText('2 actions · $259.86/mo potential savings');

    await user.click(screen.getByRole('button', { name: 'Savings settings' }));
    await user.selectOptions(screen.getByRole('combobox', { name: /^Term/ }), '1-year');
    expect(api.savedSavingsPreferences.at(-1)).toEqual({ preferredCommitment: { term: 'OneYear', paymentOption: null } });
    expect(screen.getByText('2 actions · $99.86/mo potential savings')).toBeDefined();
    expect(screen.getByText(/commitments at 1-year, highest-savings payment/)).toBeDefined();

    await user.selectOptions(screen.getByRole('combobox', { name: /^Term/ }), 'Highest savings');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Payment/ }), 'no upfront');
    expect(api.savedSavingsPreferences.at(-1)).toEqual({ preferredCommitment: { term: null, paymentOption: 'NoUpfront' } });
    // The 3-year no-upfront plan; the t2 RI pool has no such option and
    // stays folded under the plan either way.
    expect(screen.getByText('2 actions · $219.86/mo potential savings')).toBeDefined();
    // Hiding the type saves only that field.
    await user.click(screen.getByRole('checkbox', { name: /^Upgrade/ }));
    expect(api.savedSavingsPreferences.at(-1)).toEqual({ hiddenActionTypes: ['Upgrade'] });
  });

  it('starts from the saved commitment pick', async () => {
    const preferredCommitment: PreferredCommitment = { term: 'OneYear', paymentOption: 'NoUpfront' };
    const { user } = renderSavings(new SavingsApi(ALL, { preferredCommitment }));
    expect(await screen.findByText('2 actions · $99.86/mo potential savings')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Savings settings' }));
    expect(screen.getByRole('combobox', { name: /^Term/ })).toHaveProperty('value', 'OneYear');
    expect(screen.getByRole('combobox', { name: /^Payment/ })).toHaveProperty('value', 'NoUpfront');
  });

  it('counts the reservations a hidden Savings Plan covered', async () => {
    renderSavings(new SavingsApi(ALL, { hiddenActionTypes: ['PurchaseSavingsPlans'] }));
    // The t2 RI now counts, less the instance the Graviton migration moves
    // off t2: ($154.41 - $73.58) / $154.41 of $83.03 = $43.46.
    expect(await screen.findByText('2 actions · $63.32/mo potential savings')).toBeDefined();
    const ri = rowWith('EC2 Reserved Instances · t2 · eu-west-1 · Linux/UNIX');
    expect(within(ri).getByText('$43.46')).toBeDefined();
    expect(within(ri).getByText('COH $83.03')).toBeDefined();
  });
});

describe('Savings — settings and filters across recounts', () => {
  it('shows every row again when a recount leaves the filtered type without one', async () => {
    const { user } = renderSavings(new SavingsApi(ALL, { hiddenActionTypes: ['PurchaseSavingsPlans'] }));
    await screen.findByText('2 actions · $63.32/mo potential savings');
    await user.click(screen.getByRole('button', { name: /^Purchase Reserved Instances \(1\)/ }));
    expect(screen.getByText('1 action · $43.46/mo potential savings')).toBeDefined();

    // Showing Savings Plans folds the t2 RIs under the Compute SP.
    await user.click(screen.getByRole('button', { name: 'Savings settings' }));
    await user.click(screen.getByRole('checkbox', { name: /^Purchase Savings Plans/ }));
    expect(screen.getByText('2 actions · $259.86/mo potential savings')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Purchase Reserved Instances/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^All \(2\)/ }).className).toContain('text-accent');
  });

  it('opens the settings only once the saved preferences are in, so a change never overwrites them', async () => {
    let resolvePrefs: (prefs: SavingsPreferences) => void = () => undefined;
    const api = new SavingsApi(ALL);
    api.getSavingsPreferences = () => new Promise<SavingsPreferences>(resolve => { resolvePrefs = resolve; });
    const { user } = renderSavings(api);
    await screen.findByText('2 actions · $259.86/mo potential savings');

    await user.click(screen.getByRole('button', { name: 'Savings settings' }));
    expect(screen.queryByText('Visible recommendation types')).toBeNull();

    resolvePrefs({ hiddenActionTypes: ['Upgrade'], preferredCommitment: { term: null, paymentOption: null } });
    expect(await screen.findByText('Visible recommendation types')).toBeDefined();
    expect(screen.getByRole('checkbox', { name: /^Upgrade/ })).toHaveProperty('checked', false);
    expect(api.savedSavingsPreferences).toEqual([]);
  });
});

describe('Savings — settings that could not be read', () => {
  it('applies changes to the visit but saves nothing, and says so', async () => {
    const api = new SavingsApi(ALL);
    api.getSavingsPreferences = () => Promise.reject(new Error('EACCES: permission denied'));
    const { user } = renderSavings(api);
    await screen.findByText('2 actions · $259.86/mo potential savings');

    await user.click(screen.getByRole('button', { name: 'Savings settings' }));
    expect(screen.getByRole('status').textContent).toBe('Your saved Savings settings could not be read, so changes here are not saved and last until you leave this view.');
    await user.click(screen.getByRole('checkbox', { name: /^Upgrade/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: /^Term/ }), '1-year');
    // The view recounts ($80 plan + $19.86), and the unreadable file is left alone.
    expect(screen.getByText('2 actions · $99.86/mo potential savings')).toBeDefined();
    expect(screen.getByText('1 type hidden.')).toBeDefined();
    expect(api.savedSavingsPreferences).toEqual([]);
  });
});

describe('Savings — commitments after resource actions', () => {
  it('shrinks a commitment by the eligible spend the counted actions remove, and says why', async () => {
    const { user } = renderSavings(new SavingsApi([PLAN_3Y_ALL, FARGATE]));
    // $240 on $500 of eligible spend, $300 of which the rightsizing removes.
    expect(await screen.findByText('2 actions · $396.00/mo potential savings')).toBeDefined();
    const plan = rowWith('Compute Savings Plans');
    expect(within(plan).getByText('$96.00')).toBeDefined();
    expect(within(plan).getByText('COH $240.00')).toBeDefined();
    expect(within(plan).getByText('$200.00')).toBeDefined();

    await user.click(plan);
    expect(within(detailCell()).getByText(/sized this on \$500\.00\/mo of eligible spend\. 1 counted resource action on that usage removes \$300\.00\/mo of it, so it counts \$96\.00\/mo of its \$240\.00\/mo\./)).toBeDefined();
  });

  it('counts none of a commitment whose spend the actions remove entirely', async () => {
    const bigger = resourceAction({ ...FARGATE, monthlySavings: asDollars(520), monthlyCost: asDollars(560) });
    const { user } = renderSavings(new SavingsApi([PLAN_3Y_ALL, bigger]));
    expect(await screen.findByText('2 actions · $520.00/mo potential savings')).toBeDefined();
    await user.click(rowWith('Compute Savings Plans'));
    expect(within(detailCell()).getByText(/so none of its \$240\.00\/mo counts: size commitments after acting on those resources\./)).toBeDefined();
  });

  it('leaves the commitment whole when the overlapping action is hidden', async () => {
    renderSavings(new SavingsApi([PLAN_3Y_ALL, FARGATE], { hiddenActionTypes: ['Rightsize'] }));
    expect(await screen.findByText('1 action · $240.00/mo potential savings')).toBeDefined();
    expect(screen.queryByText('COH $240.00')).toBeNull();
  });
});
