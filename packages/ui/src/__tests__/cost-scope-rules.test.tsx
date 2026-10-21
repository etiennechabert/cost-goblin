import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_EXCLUSION_RULES, DEFAULT_COST_SCOPE, DEFAULT_MARKETPLACE_ATTRIBUTION, asDimensionId, tagDimColumn } from '@costgoblin/core/browser';
import type { CostScopeConfig, CostScopePreviewRange, CostScopePreviewResult, CostScopeSampleRow, Dimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { formatDollars } from '../components/format.js';
import { CostScopeView } from '../views/cost-scope.js';

function sample(over: Partial<CostScopeSampleRow> = {}): CostScopeSampleRow {
  return {
    date: '2026-10-01', accountId: '111111111111', accountName: 'prod-main', region: 'eu-west-1',
    service: 'Amazon EC2', serviceCategory: 'Compute', chargeCategory: 'Usage', operation: 'RunInstances',
    skuMeter: 'EUW1-BoxUsage:m5.large', description: 'm5.large instance hours', resourceId: 'i-0abc',
    usageAmount: 24, cost: 120, listCost: 150, excluded: false, tags: { tag_team: 'platform' },
    ...over,
  };
}

const RESULT: CostScopePreviewResult = {
  windowDays: 3,
  startDate: '2026-09-29',
  endDate: '2026-10-01',
  perRule: [{ ruleId: 'builtin:tax', excludedCost: 45, excludedRows: 3 }],
  combined: { excludedCost: 45, excludedRows: 3 },
  unscopedTotalCost: 1000,
  scopedTotalCost: 955,
  dailyTotals: [
    { date: '2026-09-29', keptCost: 300, excludedCost: 15 },
    { date: '2026-09-30', keptCost: 0, excludedCost: 0 },
    { date: '2026-10-01', keptCost: 340, excludedCost: 30 },
  ],
  sampleRows: [
    sample(),
    sample({ service: 'Refund', chargeCategory: 'Credit', cost: -20, listCost: 0, accountName: '', usageAmount: 0, tags: {}, resourceId: '' }),
    sample({ service: 'Tax', chargeCategory: 'Tax', cost: 30, listCost: 0, excluded: true, resourceId: 'tax-1' }),
  ],
  sampleTotalRowCount: 5000,
  tagColumns: [{ id: 'tag_team', label: 'Team' }],
};

type PreviewAnswer = CostScopePreviewResult | Error | 'base' | 'pending';

class ScopeApi extends MockCostApi {
  scope: CostScopeConfig = DEFAULT_COST_SCOPE;
  previewAnswer: PreviewAnswer = RESULT;
  dimensions: Dimension[] | Error | 'base' = 'base';
  filterValues: readonly string[] | Error = [];

  override getCostScope(): Promise<CostScopeConfig> { return Promise.resolve(this.scope); }

  override previewCostScope(config: CostScopeConfig, range: CostScopePreviewRange): Promise<CostScopePreviewResult> {
    if (this.previewAnswer === 'base') return super.previewCostScope(config, range);
    this.costScopePreviewRanges.push(range);
    if (this.previewAnswer === 'pending') return new Promise<CostScopePreviewResult>(() => undefined);
    return this.previewAnswer instanceof Error ? Promise.reject(this.previewAnswer) : Promise.resolve(this.previewAnswer);
  }

  override getDimensions(): Promise<Dimension[]> {
    if (this.dimensions === 'base') return super.getDimensions();
    return this.dimensions instanceof Error ? Promise.reject(this.dimensions) : Promise.resolve(this.dimensions);
  }

  override getFilterValues(): Promise<{ value: string; label: string; count: number }[]> {
    if (this.filterValues instanceof Error) return Promise.reject(this.filterValues);
    return Promise.resolve(this.filterValues.map(v => ({ value: v, label: v, count: 1 })));
  }
}

function renderView(api: ScopeApi = new ScopeApi()) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <CostScopeView />
    </CostApiProvider>,
  );
  return { api, user, ...view };
}

/** The card of the rule whose name field currently reads `name`. */
async function ruleCard(name: string): Promise<HTMLElement> {
  const input = await waitFor(() => {
    const match = screen.getAllByPlaceholderText('Rule name').find(el => el instanceof HTMLInputElement && el.value === name);
    if (match === undefined) throw new Error(`no rule named ${name}`);
    return match;
  });
  const card = input.closest('div.rounded-xl');
  if (!(card instanceof HTMLElement)) throw new Error(`no card for rule ${name}`);
  return card;
}

/** The dimension pickers of a rule's conditions (its value fields are
 *  comboboxes too, through their datalist). */
function dimensionSelects(card: HTMLElement): HTMLSelectElement[] {
  return [...card.querySelectorAll('select')];
}

function ruleName(card: HTMLElement): HTMLElement {
  return within(card).getByPlaceholderText('Rule name');
}

function previewCard(): HTMLElement {
  return screen.getByTestId('cost-scope-preview');
}

function tile(label: string): HTMLElement {
  const tileLabel = within(previewCard()).getByText(label);
  const box = tileLabel.parentElement;
  if (box === null) throw new Error(`no ${label} tile`);
  return box;
}

async function save(user: ReturnType<typeof userEvent.setup>, api: ScopeApi): Promise<CostScopeConfig> {
  const before = api.savedCostScopes.length;
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => { expect(api.savedCostScopes.length).toBeGreaterThan(before); });
  const saved = api.savedCostScopes.at(-1);
  if (saved === undefined) throw new Error('nothing saved');
  return saved;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('CostScopeView — preview', () => {
  it('summarizes the window with no rule enabled, and the bite once one is', async () => {
    const { user } = renderView();
    await waitFor(() => { expect(within(tile('Unscoped total')).getByText(formatDollars(1000))).toBeDefined(); });
    expect(within(tile('After scope')).getByText(formatDollars(955))).toBeDefined();
    expect(within(tile('After scope')).getByText('No rules enabled')).toBeDefined();
    expect(within(tile('Excluded')).getByText('—')).toBeDefined();
    expect(within(tile('Excluded')).getByText('Toggle a rule')).toBeDefined();

    const tax = await ruleCard('Tax');
    // Each rule shows its own share; one the preview did not report shows a dash.
    expect(within(tax).getByText(`${formatDollars(45)} excluded · 3 rows`)).toBeDefined();
    expect(within(await ruleCard('AWS Premium Support')).getByText('—')).toBeDefined();

    await user.click(within(tax).getByRole('switch'));
    await waitFor(() => { expect(within(tile('After scope')).getByText('4.5% excluded')).toBeDefined(); });
    expect(within(tile('Excluded')).getByText(`${formatDollars(45)} excluded · 3 rows`)).toBeDefined();
    expect(within(tile('Excluded')).getByText('Union of enabled rules')).toBeDefined();
    expect(within(previewCard()).getByText('excluded')).toBeDefined();
  });

  it('draws a bar per day, an empty one for a day with no cost, and the window s dates', async () => {
    renderView();
    const bars = await waitFor(() => {
      const found = previewCard().querySelectorAll('[title^="2026-"]');
      expect(found).toHaveLength(3);
      return found;
    });
    const empty = bars[1];
    if (!(empty instanceof HTMLElement)) throw new Error('bar missing');
    expect(empty.getAttribute('title')).toBe(`2026-09-30\nkept: ${formatDollars(0)}\nexcluded: ${formatDollars(0)}`);
    const kept = empty.querySelector('.bg-accent');
    if (!(kept instanceof HTMLElement)) throw new Error('kept segment missing');
    expect(kept.style.height).toBe('0%');
    // Few days: the bars keep their 1px gutter.
    expect(bars[0]?.parentElement?.className).toContain('gap-px');
    expect(within(previewCard()).getByText('2026-09-29')).toBeDefined();
    expect(within(previewCard()).getByText('2026-10-01')).toBeDefined();
  });

  it('drops the gutters once there are more bars than fit a quarter', async () => {
    const api = new ScopeApi();
    const days = Array.from({ length: 120 }, (_, i) => ({ date: `2026-day-${String(i).padStart(3, '0')}`, keptCost: 10 + i, excludedCost: 1 }));
    api.previewAnswer = { ...RESULT, dailyTotals: days };
    renderView(api);
    await waitFor(() => { expect(previewCard().querySelectorAll('[title^="2026-day-"]')).toHaveLength(120); });
    const first = previewCard().querySelector('[title^="2026-day-000"]');
    expect(first?.parentElement?.className).not.toContain('gap-px');
  });

  it('says it is loading until the first preview arrives', async () => {
    const api = new ScopeApi();
    api.previewAnswer = 'pending';
    renderView(api);
    expect(await screen.findByTestId('preview-histogram-loading')).toBeDefined();
    expect(screen.getByTestId('preview-table-loading')).toBeDefined();
    expect(screen.getByTestId('preview-loading')).toBeDefined();
    expect(within(tile('Unscoped total')).getByText('…')).toBeDefined();
  });

  it('shows no data, not zeros, when the preview fails', async () => {
    const api = new ScopeApi();
    api.previewAnswer = new Error('DuckDB: out of memory');
    renderView(api);
    await waitFor(() => { expect(api.costScopePreviewRanges.length).toBeGreaterThan(0); });
    await waitFor(() => { expect(screen.queryByTestId('preview-loading')).toBeNull(); });
    expect(screen.getByTestId('preview-histogram-empty')).toBeDefined();
    expect(screen.getByTestId('preview-table-empty')).toBeDefined();
    expect(within(tile('Unscoped total')).getByText('—')).toBeDefined();
  });
});

describe('CostScopeView — line items', () => {
  function tableRows(): HTMLElement[] {
    return within(within(screen.getByTestId('cost-scope-line-items')).getByRole('table')).getAllByRole('row').slice(1);
  }

  it('hides the excluded rows by default, and renders credits, blanks and tags plainly', async () => {
    renderView();
    await waitFor(() => { expect(tableRows()).toHaveLength(2); });
    const items = screen.getByTestId('cost-scope-line-items');
    expect(within(items).getByText('Team')).toBeDefined();
    expect(within(items).getByText(/excluded hidden/)).toBeDefined();
    expect(within(items).getByText(/in window/)).toBeDefined();

    const credit = tableRows()[1];
    if (credit === undefined) throw new Error('credit row missing');
    const cells = within(credit).getAllByRole('cell');
    // Date, cost, list, service, account…
    expect(cells[1]?.textContent).toBe(`-${formatDollars(20)}`);
    expect(cells[1]?.className).toContain('text-warning');
    // No account name: the ID stands in.
    expect(cells[4]?.textContent).toBe('111111111111');
    // No usage and no team tag: blank cells, not zeros.
    expect(cells[10]?.textContent).toBe('');
    expect(cells[11]?.textContent).toBe('');
  });

  it('shows the excluded rows on request once a rule is enabled, with a legend', async () => {
    const { user } = renderView();
    await user.click(within(await ruleCard('Tax')).getByRole('switch'));
    const hide = await screen.findByRole('checkbox', { name: 'Hide excluded' });
    expect(hide).toHaveProperty('checked', true);
    await user.click(hide);

    await waitFor(() => { expect(tableRows()).toHaveLength(3); });
    const items = screen.getByTestId('cost-scope-line-items');
    expect(within(items).getByText(/kept \+/)).toBeDefined();
    expect(within(items).getAllByText(/excluded/).length).toBeGreaterThan(1);
    const taxRow = tableRows().find(r => r.textContent.includes('tax-1'));
    expect(taxRow?.className).toContain('bg-negative/5');
  });

  it('falls back to the excluded rows, with a note, when every sampled row is excluded', async () => {
    const api = new ScopeApi();
    api.previewAnswer = { ...RESULT, sampleRows: [sample({ excluded: true }), sample({ excluded: true, resourceId: 'i-0def' })], sampleTotalRowCount: 2 };
    renderView(api);
    expect(await screen.findByText(/Every row in the top-2 sample is excluded/)).toBeDefined();
    expect(tableRows()).toHaveLength(2);
  });
});

describe('CostScopeView — editing rules', () => {
  it('offers Reset on an edited built-in, restoring it while keeping it enabled', async () => {
    const { user } = renderView();
    const tax = await ruleCard('Tax');
    expect(within(tax).queryByRole('button', { name: 'Reset' })).toBeNull();
    await user.click(within(tax).getByRole('switch'));
    await user.type(ruleName(tax), ' (VAT)');
    const edited = await ruleCard('Tax (VAT)');
    await user.click(within(edited).getByRole('button', { name: 'Reset' }));

    const restored = await ruleCard('Tax');
    expect(within(restored).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(restored).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('counts a changed description or condition as drift from the shipped rule', async () => {
    const { user } = renderView();
    const tax = await ruleCard('Tax');
    const description = within(tax).getByPlaceholderText('Optional description — what this rule excludes and why.');
    await user.type(description, ' Edited.');
    expect(within(tax).getByRole('button', { name: 'Reset' })).toBeDefined();
    await user.click(within(tax).getByRole('button', { name: 'Reset' }));
    expect(within(await ruleCard('Tax')).queryByRole('button', { name: 'Reset' })).toBeNull();

    await user.click(within(await ruleCard('Tax')).getByRole('button', { name: '+ Add condition' }));
    expect(within(await ruleCard('Tax')).getByRole('button', { name: 'Reset' })).toBeDefined();
  });

  it('counts a cleared description as drift too', async () => {
    const { user } = renderView();
    const tax = await ruleCard('Tax');
    await user.clear(within(tax).getByPlaceholderText('Optional description — what this rule excludes and why.'));
    expect(within(tax).getByRole('button', { name: 'Reset' })).toBeDefined();
  });

  it('edits one condition of several without touching the others', async () => {
    const { api, user } = renderView();
    const tax = await ruleCard('Tax');
    await user.click(within(tax).getByRole('button', { name: '+ Add condition' }));
    const values = within(tax).getAllByPlaceholderText('Values (comma-separated)');
    await user.type(values[1] ?? document.body, 'AWS, Marketplace');
    await user.tab();
    const saved = await save(user, api);
    const conditions = saved.rules.find(r => r.id === 'builtin:tax')?.conditions;
    expect(conditions).toEqual([
      { dimensionId: 'charge_category', values: ['Tax'] },
      { dimensionId: 'provider', values: ['AWS', 'Marketplace'] },
    ]);
  });

  it('adds a condition on the first enabled dimension, and removes it again', async () => {
    const { api, user } = renderView();
    const tax = await ruleCard('Tax');
    expect(within(tax).queryByTitle('Remove condition')).toBeNull();
    await user.click(within(tax).getByRole('button', { name: '+ Add condition' }));
    const selects = dimensionSelects(tax);
    expect(selects).toHaveLength(2);
    expect(selects[1]).toHaveProperty('value', 'provider');

    const removes = within(tax).getAllByTitle('Remove condition');
    expect(removes).toHaveLength(2);
    await user.click(removes[1] ?? document.body);
    expect(dimensionSelects(tax)).toHaveLength(1);
    expect(within(tax).queryByTitle('Remove condition')).toBeNull();
    expect(api.savedCostScopes).toHaveLength(0);
  });

  it('moves a condition to another dimension, and saves it', async () => {
    const { api, user } = renderView();
    const tax = await ruleCard('Tax');
    const [select] = dimensionSelects(tax);
    if (select === undefined) throw new Error('condition picker missing');
    await user.selectOptions(select, 'service');
    const saved = await save(user, api);
    expect(saved.rules.find(r => r.id === 'builtin:tax')?.conditions[0]?.dimensionId).toBe('service');
  });

  it('labels hidden dimensions, and offers a placeholder for a condition with none picked', async () => {
    const api = new ScopeApi();
    api.dimensions = [
      { name: asDimensionId('service'), label: 'Service', field: 'service' },
      { name: asDimensionId('charge_category'), label: 'Charge category', field: 'charge_category', enabled: false },
    ];
    api.scope = {
      ...DEFAULT_COST_SCOPE,
      rules: [{ id: 'user:blank', name: 'Unfinished', enabled: false, builtIn: false, conditions: [{ dimensionId: asDimensionId(''), values: [] }] }],
    };
    const { user } = renderView(api);
    const card = await ruleCard('Unfinished');
    const [select] = dimensionSelects(card);
    if (select === undefined) throw new Error('condition picker missing');
    expect(within(select).getByRole('option', { name: '— pick dimension —' })).toBeDefined();
    expect(within(select).getByRole('option', { name: 'Charge category (hidden)' })).toBeDefined();

    // Re-picking the placeholder changes nothing; a real dimension takes.
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await user.selectOptions(select, 'charge_category');
    const saved = await save(user, api);
    expect(saved.rules[0]?.conditions[0]?.dimensionId).toBe('charge_category');
  });

  it('suggests values seen for a condition s dimension, and copes without any', async () => {
    const chargeCategory: Dimension = { name: asDimensionId('charge_category'), label: 'Charge category', field: 'charge_category' };
    const api = new ScopeApi();
    api.dimensions = [chargeCategory];
    api.filterValues = ['Tax', 'Usage', 'Credit'];
    const getValues = vi.spyOn(api, 'getFilterValues');
    renderView(api);
    const tax = await ruleCard('Tax');
    await waitFor(() => { expect(tax.querySelectorAll('datalist option')).toHaveLength(3); });
    expect(getValues).toHaveBeenCalledTimes(1);
    cleanup();

    const failing = new ScopeApi();
    failing.dimensions = [chargeCategory];
    failing.filterValues = new Error('no data on disk');
    const failingValues = vi.spyOn(failing, 'getFilterValues');
    renderView(failing);
    const card = await ruleCard('Tax');
    await waitFor(() => { expect(failingValues).toHaveBeenCalledTimes(1); });
    expect(card.querySelector('datalist')).toBeNull();
  });

  it('starts a new rule disabled on "service" when no dimension is known, and deletes it', async () => {
    const api = new ScopeApi();
    api.dimensions = new Error('dimensions.yaml missing');
    const { user } = renderView(api);
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const card = await ruleCard('New rule');
    expect(within(card).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    await user.click(within(card).getByRole('button', { name: '+ Add condition' }));

    const saved = await save(user, api);
    const added = saved.rules.find(r => r.name === 'New rule');
    expect(added?.conditions.map(c => String(c.dimensionId))).toEqual(['service', 'service']);

    await user.click(within(await ruleCard('New rule')).getByRole('button', { name: 'Delete' }));
    expect(screen.queryByDisplayValue('New rule')).toBeNull();
  });

  it('drops an emptied description instead of saving an empty one', async () => {
    const { api, user } = renderView();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const card = await ruleCard('New rule');
    const description = within(card).getByPlaceholderText('Optional description — what this rule excludes and why.');
    await user.type(description, 'temporary');
    await user.clear(description);
    const saved = await save(user, api);
    const added = saved.rules.find(r => r.name === 'New rule');
    expect(added).toBeDefined();
    expect(added?.description).toBeUndefined();
  });

  it('explains what "Missing values" matches for a tag, the account and any other field', async () => {
    const api = new ScopeApi();
    api.scope = {
      ...DEFAULT_COST_SCOPE,
      rules: [{
        id: 'user:missing',
        name: 'Untagged and orphaned',
        enabled: false,
        builtIn: false,
        conditions: [
          { dimensionId: asDimensionId(tagDimColumn({ tagName: 'team' })), values: [] },
          { dimensionId: asDimensionId('account'), values: [] },
          { dimensionId: asDimensionId('region'), values: [] },
          { dimensionId: asDimensionId('gone'), values: [] },
        ],
      }],
    };
    renderView(api);
    const card = await ruleCard('Untagged and orphaned');
    await waitFor(() => { expect(dimensionSelects(card)[0]?.options.length).toBeGreaterThan(1); });
    const titles = within(card).getAllByText('Missing values').map(label => label.closest('label')?.getAttribute('title'));
    expect(titles).toEqual([
      'Also match rows without this tag (untagged). The values can then stay empty.',
      'Also match charges with no account, listed as "(no account)". The values can then stay empty.',
      'Also match rows where this field is empty. The values can then stay empty.',
      'Also match rows with no value. The values can then stay empty.',
    ]);
  });

  it('refuses an enabled rule with no conditions', async () => {
    const api = new ScopeApi();
    api.scope = { ...DEFAULT_COST_SCOPE, rules: [{ id: 'user:empty', name: 'Empty', enabled: true, builtIn: false, conditions: [] }] };
    renderView(api);
    expect(await screen.findByText("Rule 'Empty' has no conditions.")).toBeDefined();
  });

  it('says when no rule is defined', async () => {
    const api = new ScopeApi();
    api.scope = { ...DEFAULT_COST_SCOPE, rules: [] };
    renderView(api);
    expect(await screen.findByText('No rules defined.')).toBeDefined();
  });

  it('offers no Reset on a built-in the app no longer ships', async () => {
    const api = new ScopeApi();
    api.scope = { ...DEFAULT_COST_SCOPE, rules: [{ id: 'builtin:retired', name: 'Retired', enabled: false, builtIn: true, conditions: [{ dimensionId: asDimensionId('service'), values: ['X'] }] }] };
    const { user } = renderView(api);
    const card = await ruleCard('Retired');
    await user.type(ruleName(card), '!');
    const edited = await ruleCard('Retired!');
    expect(within(edited).getByText('built-in')).toBeDefined();
    expect(within(edited).queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(within(edited).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('CostScopeView — metric, freshness, marketplace and saving', () => {
  it('saves a changed cost metric', async () => {
    const { api, user } = renderView();
    await user.click(await screen.findByRole('radio', { name: /^Billed/ }));
    expect(screen.getByRole('radio', { name: /^Billed/ })).toHaveProperty('checked', true);
    const saved = await save(user, api);
    expect(saved.costMetric).toBe('billed');
  });

  it('writes a non-default lag, drops the default one, and keeps a config without marketplace settings that way', async () => {
    const api = new ScopeApi();
    api.scope = { costMetric: 'effective', rules: BUILTIN_EXCLUSION_RULES };
    const { user } = renderView(api);
    const lag = await screen.findByRole('spinbutton');
    fireEvent.change(lag, { target: { value: '5' } });
    let saved = await save(user, api);
    expect(saved.lagDays).toBe(5);
    expect('marketplaceAttribution' in saved).toBe(false);

    fireEvent.change(lag, { target: { value: '2' } });
    saved = await save(user, api);
    expect('lagDays' in saved).toBe(false);
  });

  it('steps the lag up past a week', async () => {
    const api = new ScopeApi();
    api.scope = { costMetric: 'effective', lagDays: 7, rules: BUILTIN_EXCLUSION_RULES };
    const { user } = renderView(api);
    const lag = await screen.findByRole('spinbutton');
    if (!(lag instanceof HTMLInputElement)) throw new Error('lag field missing');
    // What the field's up arrow does: step the value, then fire input.
    lag.stepUp();
    fireEvent.input(lag);
    expect(lag.value).toBe('8');
    expect((await save(user, api)).lagDays).toBe(8);
  });

  it.each([
    { name: 'absent', marketplace: undefined },
    { name: 'without rules', marketplace: { enabled: false, rules: [] } },
  ])('turns marketplace attribution on with the shipped rules when they are $name', async ({ marketplace }) => {
    const api = new ScopeApi();
    api.scope = { costMetric: 'effective', rules: BUILTIN_EXCLUSION_RULES, ...(marketplace === undefined ? {} : { marketplaceAttribution: marketplace }) };
    const { user } = renderView(api);
    const off = await screen.findByText(/^Off$/);
    expect(screen.queryByText('Amazon Bedrock')).toBeNull();
    const checkbox = off.parentElement?.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('marketplace toggle missing');
    await user.click(checkbox);
    expect(screen.getByText(/^On$/)).toBeDefined();
    expect(screen.getByText('Amazon Bedrock')).toBeDefined();
    const saved = await save(user, api);
    expect(saved.marketplaceAttribution).toEqual({ enabled: true, rules: DEFAULT_MARKETPLACE_ATTRIBUTION.rules });
  });

  it('lists no rules for an enabled attribution that has none', async () => {
    const api = new ScopeApi();
    api.scope = { ...DEFAULT_COST_SCOPE, marketplaceAttribution: { enabled: true, rules: [] } };
    renderView(api);
    expect(await screen.findByText(/^On$/)).toBeDefined();
    expect(screen.queryByText('Amazon Bedrock')).toBeNull();
  });

  it.each([
    { reason: new Error('cost-scope.yaml: permission denied'), text: 'cost-scope.yaml: permission denied' },
    { reason: 'EIO', text: 'Failed to save.' },
  ])('shows why saving failed ($text)', async ({ reason, text }) => {
    const api = new ScopeApi();
    vi.spyOn(api, 'saveCostScope').mockRejectedValue(reason);
    const { user } = renderView(api);
    await user.click(await screen.findByRole('radio', { name: /^Billed/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(text)).toBeDefined();
    // Still unsaved: Save stays offered.
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('Cancel throws the unsaved edits away', async () => {
    const { api, user } = renderView();
    await user.click(await screen.findByRole('radio', { name: /^Billed/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.getByRole('radio', { name: /^Effective/ })).toHaveProperty('checked', true);
    expect(api.savedCostScopes).toHaveLength(0);
  });

  // The shipped defaults are not shown as the user's scope (see
  // cost-scope-load.test.tsx); the way to the file stays open.
  it('reveals the YAML folder when the saved scope cannot be read', async () => {
    const api = new ScopeApi();
    vi.spyOn(api, 'getCostScope').mockRejectedValue(new Error('parse error'));
    const reveal = vi.spyOn(api, 'revealCostScopeFolder').mockRejectedValue(new Error('no file manager'));
    const { user } = renderView(api);
    expect(await screen.findByText('parse error')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reveal YAML' }));
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
