import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { AliasSuggestion, CostApi, DimensionsConfig, OrgAccount, OrgSyncResult, TagDimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The tag editor's merged value preview and its alias-rule editor. The
 *  preview mirrors what a query would resolve: resource-tag samples and
 *  account fallback values, normalized, alias-resolved and de-duplicated, each
 *  coloured by where it came from. Clicking a value writes it into the alias
 *  rules. */

const RESOURCE_VALUES = ['Payments', 'search', 'platform_eng', 'PlatformEng', 'big data', 'search-'];

function account(id: string, team: string): OrgAccount {
  return { id, name: `acct-${id}`, email: `${id}@example.com`, status: 'ACTIVE', joinedTimestamp: '2024-01-01T00:00:00Z', ouPath: 'Root', tags: { Team: team } };
}

// "Payments" is also a resource value; the empty one contributes nothing.
const ORG: OrgSyncResult = {
  orgId: 'o-example',
  syncedAt: '2026-04-30T00:00:00Z',
  accounts: [account('1', 'Payments'), account('2', 'payments'), account('3', 'billing'), account('4', '')],
};

const TEAM: TagDimension = { tagName: 'team', label: 'Team', accountTagFallback: 'Team' };

function renderView(tag: TagDimension, suggestions: AliasSuggestion[] = []) {
  const api: CostApi = new MockCostApi();
  const config: DimensionsConfig = { builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }], tags: [tag] };
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  vi.spyOn(api, 'getOrgSyncResult').mockResolvedValue(ORG);
  vi.spyOn(api, 'discoverTagKeys').mockResolvedValue({
    tags: [{ key: 'team', sampleValues: RESOURCE_VALUES, rowCount: 600, distinctCount: 6, coveragePct: 60 }],
    samplePeriod: '2026-04',
  });
  vi.spyOn(api, 'getAliasSuggestions').mockImplementation((id) => Promise.resolve(id === 'team' ? suggestions : []));
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { save, user };
}

type User = ReturnType<typeof userEvent.setup>;

/** Opens the tag's editor once the org sync (account values) has loaded, and
 *  waits for the resource-tag samples its opening fetches. */
async function openEditor(user: User): Promise<void> {
  await screen.findByText(/across 4 accounts/);
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button').find(b => b.textContent.includes('tag:team'));
    if (found === undefined) throw new Error('team row not rendered yet');
    return found;
  });
  await user.click(row);
  await screen.findByText('60% coverage · 6 distinct values');
}

function previewHeading(): string {
  return screen.getByText(/^Preview — /).textContent;
}

function previewBox(): HTMLElement {
  const box = screen.getByText(/^Preview — /).parentElement?.lastElementChild;
  if (!(box instanceof HTMLElement)) throw new Error('no preview values');
  return box;
}

function previewValues(): string[] {
  return within(previewBox()).getAllByRole('button').map(b => b.textContent);
}

function badge(value: string): HTMLElement {
  return within(previewBox()).getByRole('button', { name: value });
}

/** Where a preview value came from, read off its colour (the legend's key). */
function sourceOf(value: string): string {
  const cls = badge(value).className;
  if (cls.includes('rose')) return 'aliased';
  if (cls.includes('warning')) return 'formatted';
  if (cls.includes('emerald')) return 'both';
  if (cls.includes('violet')) return 'account';
  if (cls.includes('cyan')) return 'resource';
  return 'unknown';
}

function legend(): string[] {
  const row = screen.getByText(/^Preview — /).nextElementSibling;
  if (!(row instanceof HTMLElement)) throw new Error('no legend');
  return [...row.children].map(c => c.textContent.trim());
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

function rulesEditor(): HTMLElement {
  const editor = screen.getByText('Alias Rules (canonical: alias1, alias2)').nextElementSibling;
  if (!(editor instanceof HTMLElement)) throw new Error('no alias rules editor');
  return editor;
}

const NEW_RULE = 'new-canonical: alias1, alias2';

function ruleInputs(): HTMLInputElement[] {
  return within(rulesEditor()).getAllByRole('textbox')
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.placeholder !== NEW_RULE);
}

function ruleLines(): string[] {
  return ruleInputs().map(i => i.value);
}

/** A rule's row — what carries its highlight. */
function ruleRow(line: string): HTMLElement {
  const input = ruleInputs().find(i => i.value === line);
  const rowEl = input?.parentElement;
  if (rowEl === null || rowEl === undefined) throw new Error(`no rule "${line}"`);
  return rowEl;
}

const isActive = (line: string): boolean => ruleRow(line).className.includes('border-l-accent');
const isUnsaved = (line: string): boolean => ruleRow(line).className.includes('border-l-warning');

async function addRule(user: User, rule: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(NEW_RULE), `${rule}{Enter}`);
}

function warnings(): string[] {
  return screen.queryAllByText(/is a canonical key but also an alias of/).map(w => w.textContent);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('TagValuePreview — normalization', () => {
  it('merges resource and account values, marking where each came from', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    expect(previewHeading()).toBe('Preview — 8 raw → 8 resolved');
    expect(sorted(previewValues())).toEqual(sorted([...RESOURCE_VALUES, 'payments', 'billing']));
    // The exact same value on a resource and an account is from both.
    expect(sourceOf('Payments')).toBe('both');
    expect(sourceOf('search')).toBe('resource');
    expect(sourceOf('payments')).toBe('account');
    expect(legend()).toEqual(['resource', 'account', 'both']);
  });

  it.each([
    ['lowercase', ['payments', 'search', 'platform_eng', 'platformeng', 'big data', 'search-', 'billing']],
    ['uppercase', ['PAYMENTS', 'SEARCH', 'PLATFORM_ENG', 'PLATFORMENG', 'BIG DATA', 'SEARCH-', 'BILLING']],
    ['lowercase-kebab', ['payments', 'search', 'platform-eng', 'big-data', 'search-', 'billing']],
    ['lowercase-underscore', ['payments', 'search', 'platform_eng', 'big_data', 'search_', 'billing']],
    ['camelCase', ['payments', 'search', 'platformEng', 'bigData', 'search-', 'billing']],
  ])('previews %s, folding values that normalize alike', async (rule, expected) => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    await user.selectOptions(screen.getByLabelText('Normalization'), rule);

    expect(previewHeading()).toBe(`Preview — 8 raw → ${String(expected.length)} resolved (${rule})`);
    expect(sorted(previewValues())).toEqual(sorted(expected));
    // Payments (resource and account) and payments (account) fold into one.
    const payments = expected[0];
    if (payments === undefined) throw new Error('no expectation');
    expect(sourceOf(payments)).toBe('both');
    const billing = expected.at(-1);
    if (billing === undefined) throw new Error('no expectation');
    expect(sourceOf(billing)).toBe('account');
  });

  it('resolves aliases after normalizing, and counts the values they caught', async () => {
    const { user } = renderView({ ...TEAM, normalize: 'lowercase', aliases: { platform: ['Platform_Eng', 'platformeng'] } });
    await openEditor(user);
    expect(previewHeading()).toBe('Preview — 8 raw → 6 resolved (lowercase) · 2 aliased');
    expect(sorted(previewValues())).toEqual(sorted(['payments', 'search', 'platform', 'big data', 'search-', 'billing']));
    expect(sourceOf('platform')).toBe('aliased');
    expect(legend()).toEqual(['resource', 'account', 'both', 'aliased']);
  });
});

describe('TagValuePreview — fallback format', () => {
  async function setFormat(value: string): Promise<void> {
    fireEvent.change(screen.getByLabelText(/^Fallback format/), { target: { value } });
    await waitFor(() => { expect(screen.getByLabelText(/^Fallback format/)).toHaveProperty('value', value); });
  }

  it('formats each account value through the template', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    await setFormat('acct-{fallback}');
    expect(sorted(previewValues())).toEqual(sorted([...RESOURCE_VALUES, 'acct-Payments', 'acct-payments', 'acct-billing']));
    expect(sourceOf('acct-billing')).toBe('formatted');
    // Formatted values are no longer account values: Payments is resource-only.
    expect(sourceOf('Payments')).toBe('resource');
    expect(legend()).toEqual(['resource', 'account', 'both', 'formatted']);
  });

  it('uses a template without the placeholder as one fixed value', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    await setFormat('unassigned');
    expect(sorted(previewValues())).toEqual(sorted([...RESOURCE_VALUES, 'unassigned']));
    expect(sourceOf('unassigned')).toBe('formatted');
  });

  it('treats the bare placeholder as no template', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    await setFormat('{fallback}');
    expect(previewHeading()).toBe('Preview — 8 raw → 8 resolved');
    expect(sourceOf('billing')).toBe('account');
    expect(legend()).not.toContain('formatted');
  });

  it('formats nothing when there is no account source', async () => {
    const { user } = renderView({ tagName: 'team', label: 'Team' });
    await openEditor(user);
    await setFormat('unassigned');
    expect(sorted(previewValues())).toEqual(sorted(RESOURCE_VALUES));
  });
});

describe('AliasRulesEditor', () => {
  it('adds a rule from the new-rule field, flagged until it is saved', async () => {
    const { user } = renderView({ ...TEAM, aliases: { payments: ['pay'] } });
    await openEditor(user);
    expect(ruleLines()).toEqual(['payments: pay']);
    expect(isUnsaved('payments: pay')).toBe(false);

    await addRule(user, 'search: search-');
    expect(ruleLines()).toEqual(['payments: pay', 'search: search-']);
    expect(isUnsaved('search: search-')).toBe(true);
    expect(screen.getByPlaceholderText(NEW_RULE)).toHaveProperty('value', '');
    expect(sourceOf('search')).toBe('aliased');

    // Enter on an empty field adds nothing.
    await user.type(screen.getByPlaceholderText(NEW_RULE), '{Enter}');
    expect(ruleLines()).toEqual(['payments: pay', 'search: search-']);
  });

  it('starts the rules from the new-rule field when there are none', async () => {
    const { save, user } = renderView(TEAM);
    await openEditor(user);
    expect(ruleLines()).toEqual([]);
    await addRule(user, 'billing: payments');
    expect(ruleLines()).toEqual(['billing: payments']);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    expect(save.mock.calls[0]?.[0].tags[0]?.aliases).toEqual({ billing: ['payments'] });
  });

  it('edits a rule in place, highlights the focused rule, and Enter moves on to a new rule', async () => {
    const { user } = renderView({ ...TEAM, aliases: { payments: ['pay'], search: ['search-'] } });
    await openEditor(user);
    const [first] = ruleInputs();
    if (first === undefined) throw new Error('no rule');

    // Pasted in one go. Typed key by key, the ", " separator is lost: each
    // keystroke re-renders the field from the normalized rule, which drops a
    // trailing separator (a known defect, deliberately not asserted here).
    await user.click(first);
    await user.paste(', PAY');
    expect(ruleLines()).toEqual(['payments: pay, PAY', 'search: search-']);
    expect(isActive('payments: pay, PAY')).toBe(true);
    expect(isActive('search: search-')).toBe(false);
    // Typing into an alias edits it like any text field.
    await user.keyboard('S');
    expect(ruleLines()).toEqual(['payments: pay, PAYS', 'search: search-']);

    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByPlaceholderText(NEW_RULE));
    expect(isActive('payments: pay, PAYS')).toBe(false);
  });

  it('ignores a rule without a canonical value', async () => {
    const { save, user } = renderView({ ...TEAM, aliases: { payments: ['pay'] } });
    await openEditor(user);
    await addRule(user, ': orphan');
    expect(ruleLines()).toEqual(['payments: pay']);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    expect(save.mock.calls[0]?.[0].tags[0]?.aliases).toEqual({ payments: ['pay'] });
  });

  it('removes a rule', async () => {
    const { user } = renderView({ ...TEAM, aliases: { payments: ['pay'], search: ['search-'] } });
    await openEditor(user);
    const removeButtons = within(rulesEditor()).getAllByRole('button', { name: 'Remove rule' });
    const removeSearch = removeButtons[1];
    if (removeSearch === undefined) throw new Error('no remove button');
    await user.click(removeSearch);
    expect(ruleLines()).toEqual(['payments: pay']);
    expect(sourceOf('search-')).toBe('resource');
  });

  it('warns about a value that is both a canonical key and an alias', async () => {
    const { user } = renderView({ ...TEAM, aliases: { payments: ['pay'] } });
    await openEditor(user);
    expect(warnings()).toEqual([]);
    await addRule(user, 'pay: payments');
    expect(warnings()).toEqual([
      '"payments" is a canonical key but also an alias of "pay"',
      '"pay" is a canonical key but also an alias of "payments"',
    ]);
  });

  it('shows text with no rule in it as typed, until a rule is added', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    await addRule(user, 'just a note');
    expect(ruleLines()).toEqual(['just a note']);

    // A value clicked while that line is focused can't join it (no colon):
    // it starts a rule of its own, and the rules then show alone.
    const [note] = ruleInputs();
    if (note === undefined) throw new Error('no line');
    await user.click(note);
    await user.click(badge('billing'));
    expect(ruleLines()).toEqual(['billing:']);
  });

  it('merges an accepted alias suggestion into the rules', async () => {
    const { user } = renderView({ ...TEAM, aliases: { platform: ['platform_eng'] } }, [
      { canonical: 'platform', aliases: ['PlatformEng', 'platform_eng'] },
      { canonical: 'billing', aliases: ['payments'] },
    ]);
    await openEditor(user);
    await user.click(await screen.findByRole('button', { name: 'Suggested Aliases (2)' }));

    await user.click(screen.getByRole('button', { name: 'Accept alias suggestion for platform' }));
    await waitFor(() => { expect(ruleLines()).toEqual(['platform: platform_eng, PlatformEng']); });

    // Into empty rules, it starts a new one.
    const removeButtons = within(rulesEditor()).getAllByRole('button', { name: 'Remove rule' });
    const removePlatform = removeButtons[0];
    if (removePlatform === undefined) throw new Error('no remove button');
    await user.click(removePlatform);
    await user.click(screen.getByRole('button', { name: 'Accept alias suggestion for billing' }));
    await waitFor(() => { expect(ruleLines()).toEqual(['billing: payments']); });
  });
});

describe('TagValuePreview — clicking a value', () => {
  it('focuses a value\'s rule, adds values to the focused rule, and starts a rule for a value', async () => {
    const { save, user } = renderView({ ...TEAM, aliases: { platform: ['platform_eng'] } });
    await openEditor(user);
    expect(sourceOf('platform')).toBe('aliased');

    // A value that is already a canonical key just focuses its rule.
    await user.click(badge('platform'));
    expect(ruleLines()).toEqual(['platform: platform_eng']);
    expect(isActive('platform: platform_eng')).toBe(true);

    // Another value joins the focused rule.
    await user.click(badge('PlatformEng'));
    expect(ruleLines()).toEqual(['platform: platform_eng, PlatformEng']);
    expect(within(previewBox()).queryByRole('button', { name: 'PlatformEng' })).toBeNull();

    // With no rule focused, a value starts a new, focused rule of its own...
    await user.click(screen.getByPlaceholderText(NEW_RULE));
    await user.click(badge('billing'));
    expect(ruleLines()).toEqual(['billing:', 'platform: platform_eng, PlatformEng']);
    expect(isActive('billing:')).toBe(true);

    // ...which the next values join.
    await user.click(badge('payments'));
    expect(ruleLines()).toEqual(['billing: payments', 'platform: platform_eng, PlatformEng']);
    await user.click(badge('search'));
    expect(ruleLines()).toEqual(['billing: payments, search', 'platform: platform_eng, PlatformEng']);
    expect(sourceOf('billing')).toBe('aliased');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    expect(save.mock.calls[0]?.[0].tags[0]?.aliases).toEqual({
      billing: ['payments', 'search'],
      platform: ['platform_eng', 'PlatformEng'],
    });
  });

  it('starts the first rule from a clicked value', async () => {
    const { user } = renderView(TEAM);
    await openEditor(user);
    expect(ruleLines()).toEqual([]);
    await user.click(badge('billing'));
    expect(ruleLines()).toEqual(['billing:']);
    expect(isActive('billing:')).toBe(true);
  });

  it('starts a new rule when the focused rule was removed', async () => {
    const { user } = renderView({ ...TEAM, aliases: { payments: ['pay'], search: ['search-'] } });
    await openEditor(user);
    const second = ruleInputs()[1];
    if (second === undefined) throw new Error('no rule');
    await user.click(second);
    const removeSecond = within(rulesEditor()).getAllByRole('button', { name: 'Remove rule' })[1];
    if (removeSecond === undefined) throw new Error('no remove button');
    await user.click(removeSecond);

    await user.click(badge('billing'));
    expect(ruleLines()).toEqual(['billing:', 'payments: pay']);
  });
});
