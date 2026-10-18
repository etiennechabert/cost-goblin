import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, OU_PATH_SOURCE_KEY } from '@costgoblin/core/browser';
import type { BuiltInDimension, CostApi, DimensionsConfig, OrgAccount, OrgSyncResult, TagDimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The tag dimension editor: a resource tag and/or an account-level source
 *  (an account tag or the OU Path, optionally cut to one path segment), its
 *  concept, label, normalization and fallback format, and the add / save /
 *  remove / discard flow back into the Dimensions draft. */

const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };
const TEAM: TagDimension = { tagName: 'team', label: 'Team', concept: 'owner' };

function account(id: string, ouPath: string, tags: Readonly<Record<string, string>>): OrgAccount {
  return { id, name: `acct-${id}`, email: `${id}@example.com`, status: 'ACTIVE', joinedTimestamp: '2024-01-01T00:00:00Z', ouPath, tags };
}

const ORG: OrgSyncResult = {
  orgId: 'o-example',
  syncedAt: '2026-04-30T00:00:00Z',
  accounts: [
    account('111111111111', 'Root / Engineering / Payments', { CostCenter: 'cc-1' }),
    account('222222222222', 'Root / Engineering / Search', { CostCenter: 'cc-2' }),
    account('333333333333', 'Root / Finance', { CostCenter: 'cc-1' }),
    // No OU and an empty tag value: both contribute nothing.
    account('444444444444', '', { CostCenter: '' }),
  ],
};

const DISCOVERED = [
  { key: 'team', sampleValues: ['payments', 'search'], rowCount: 500, distinctCount: 2, coveragePct: 45 },
  { key: 'cost-center', sampleValues: ['cc-1'], rowCount: 100, distinctCount: 1, coveragePct: 30 },
  { key: 'app_name', sampleValues: ['checkout'], rowCount: 50, distinctCount: 1, coveragePct: 12 },
];

function renderView(tags: readonly TagDimension[]) {
  const api: CostApi = new MockCostApi();
  const config: DimensionsConfig = { builtIn: [SERVICE], tags: [...tags] };
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  vi.spyOn(api, 'getOrgSyncResult').mockResolvedValue(ORG);
  vi.spyOn(api, 'discoverTagKeys').mockResolvedValue({ tags: DISCOVERED, samplePeriod: '2026-04' });
  // No suggestions: this suite is about the form, not the suggestion list.
  vi.spyOn(api, 'getAliasSuggestions').mockResolvedValue([]);
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

/** A row in the enabled-dimensions list, found by a piece of its text. */
async function row(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.getAllByRole('button').find(b => b.textContent.includes(text));
    if (found === undefined) throw new Error(`no row with "${text}"`);
    return found;
  });
}

/** The editor works off two loads: the org sync (account values) and the
 *  resource-tag scan its opening starts. The debug panels' subtitles count
 *  both, so wait for those before acting on either. */
async function waitForSources(): Promise<void> {
  await screen.findByText(/across 4 accounts/);
  await screen.findByText(/3 keys · sampled from 2026-04/);
}

async function openTagEditor(user: User, text: string): Promise<void> {
  await screen.findByText(/across 4 accounts/);
  await user.click(await row(text));
  await screen.findByLabelText('Concept');
  await waitForSources();
}

async function openAddEditor(user: User): Promise<void> {
  await screen.findByText(/across 4 accounts/);
  await user.click(await screen.findByRole('button', { name: '+ Add' }));
  await screen.findByLabelText('Concept');
  await waitForSources();
}

const resourceTag = (): HTMLElement => screen.getByLabelText(/^Resource Tag/);
const accountSource = (): HTMLElement => screen.getByLabelText(/^(Account source|Fallback \(account\))/);
const fallbackFormat = (): HTMLElement => screen.getByLabelText(/^Fallback format/);
const segment = (): HTMLElement => screen.getByLabelText(/^OU Path segment/);
const label = (): HTMLElement => screen.getByLabelText('Display Label');

/** The resolved values the merged preview lists, in order. */
function previewValues(): string[] {
  const heading = screen.queryByText(/^Preview — /);
  const box = heading?.parentElement?.lastElementChild;
  if (!(box instanceof HTMLElement)) return [];
  return within(box).queryAllByRole('button').map(b => b.textContent);
}

/** Set as a whole value: typing "-1" key by key passes through "-", which a
 *  number input rejects. */
function setSegment(value: string): void {
  fireEvent.change(segment(), { target: { value } });
}

/** The labels of the enabled-dimensions list, top to bottom. */
function enabledRowLabels(): string[] {
  const section = screen.getByRole('heading', { name: /^Enabled dimensions/ }).parentElement;
  if (section === null) throw new Error('no enabled-dimensions list');
  return [...section.children].slice(1).map(r => r.querySelector('span')?.textContent ?? '');
}

async function applyDraft(user: User, save: ReturnType<typeof renderView>['save']): Promise<DimensionsConfig> {
  await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
  await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
  const saved = save.mock.calls[0]?.[0];
  if (saved === undefined) throw new Error('nothing saved');
  return saved;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('TagEditor — editing a tag dimension', () => {
  it('saves concept, normalization, account fallback and fallback format into the draft', async () => {
    const { save, user } = renderView([TEAM]);
    await openTagEditor(user, 'tag:team');
    expect(screen.getByLabelText('Concept')).toHaveProperty('value', 'owner');
    expect(screen.getByText('45% coverage · 2 distinct values')).toBeDefined();

    // A customised label is kept when the concept changes.
    await user.selectOptions(screen.getByLabelText('Concept'), 'product');
    expect(label()).toHaveProperty('value', 'Team');
    await user.selectOptions(screen.getByLabelText('Normalization'), 'lowercase-kebab');
    await user.selectOptions(accountSource(), 'CostCenter');
    expect(screen.getByText('2 distinct values')).toBeDefined();
    await user.click(fallbackFormat());
    await user.paste('acct-{fallback}');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByLabelText('Concept')).toBeNull();
    const saved = await row('tag:team');
    expect(within(saved).getByText('product')).toBeDefined();
    expect(within(saved).getByText('lowercase-kebab')).toBeDefined();
    expect(within(saved).getByText(/fallback:\s*CostCenter/)).toBeDefined();
    expect(within(saved).getByText('missing: acct-{fallback}')).toBeDefined();

    const config = await applyDraft(user, save);
    expect(config.tags[0]).toEqual({
      tagName: 'team',
      label: 'Team',
      concept: 'product',
      normalize: 'lowercase-kebab',
      accountTagFallback: 'CostCenter',
      missingValueTemplate: 'acct-{fallback}',
    });
  });

  it('clears the fallback and concept back to none', async () => {
    const { save, user } = renderView([{ ...TEAM, accountTagFallback: 'CostCenter', normalize: 'lowercase' }]);
    await openTagEditor(user, 'tag:team');
    expect(accountSource()).toHaveProperty('value', 'CostCenter');

    await user.selectOptions(accountSource(), '');
    await user.selectOptions(screen.getByLabelText('Concept'), '');
    await user.selectOptions(screen.getByLabelText('Normalization'), '');
    // With no concept to fill it from, the label stays as typed.
    expect(label()).toHaveProperty('value', 'Team');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const config = await applyDraft(user, save);
    expect(config.tags[0]).toEqual({ tagName: 'team', label: 'Team' });
  });

  it('removes the dimension from the draft', async () => {
    const env: TagDimension = { tagName: 'env', label: 'Environment' };
    const { save, user } = renderView([TEAM, env]);
    await openTagEditor(user, 'tag:team');
    await user.click(screen.getByRole('button', { name: 'Remove Dimension' }));

    expect(screen.queryByLabelText('Concept')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Team' })).toBeNull();
    const config = await applyDraft(user, save);
    expect(config.tags).toEqual([env]);
    expect(config.order).toEqual(['builtin:service', 'tag:env']);
  });

  it('closes at once on Cancel when nothing was edited', async () => {
    const { user } = renderView([TEAM]);
    await openTagEditor(user, 'tag:team');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Concept')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before discarding edits: Keep editing keeps them, Discard drops them', async () => {
    const { user } = renderView([TEAM]);
    await openTagEditor(user, 'tag:team');
    await user.type(label(), ' squad');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(label()).toHaveProperty('value', 'Team squad');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => { expect(screen.queryByLabelText('Concept')).toBeNull(); });
    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Team' })).toBeDefined();
  });
});

describe('TagEditor — tags sharing a dimension id', () => {
  it('keeps the open editor on its tag when the clash banner removes a later tag', async () => {
    const costCenter: TagDimension = { tagName: 'cost-center', label: 'Cost Center' };
    const duplicate: TagDimension = { tagName: 'cost_center', label: 'Cost center (new)', enabled: false };
    const { user } = renderView([costCenter, duplicate]);
    const banner = await screen.findByRole('alert');
    await openTagEditor(user, 'tag:cost-center');
    await user.type(label(), ' (edited)');

    await user.click(within(banner).getByRole('button', { name: 'Remove "Cost center (new)"' }));
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
    expect(screen.getByDisplayValue('Cost Center (edited)')).toBeDefined();
    expect(screen.getByLabelText(/^Resource Tag/, { selector: 'select' })).toHaveProperty('value', 'cost-center');
  });
});

describe('TagEditor — adding a tag dimension', () => {
  it('fills the label from the concept until the user types one', async () => {
    const { user } = renderView([TEAM]);
    await openAddEditor(user);
    const concept = screen.getByLabelText('Concept');

    await user.selectOptions(concept, 'environment');
    expect(label()).toHaveProperty('value', 'Environment');
    // Still the concept's own label: it follows the next concept.
    await user.selectOptions(concept, 'product');
    expect(label()).toHaveProperty('value', 'System');

    // Back to no concept: there is no label to follow, so it stays.
    await user.selectOptions(concept, '');
    expect(label()).toHaveProperty('value', 'System');

    await user.clear(label());
    await user.type(label(), 'Squad');
    await user.selectOptions(concept, 'unit');
    expect(label()).toHaveProperty('value', 'Squad');
  });

  it('names the dimension after the resource tag picked, and lists only unmapped tags', async () => {
    const { save, user } = renderView([TEAM]);
    await openAddEditor(user);
    expect(screen.getByText('Account-level only (no resource tag)')).toBeDefined();
    expect(screen.getByText('Pick a resource tag or an account source.')).toBeDefined();
    // team is already a dimension; hidden and mapped keys aren't offered.
    await waitFor(() => { expect(within(resourceTag()).getAllByRole('option').map(o => o.textContent)).toEqual(['No resource tag', 'cost-center', 'app_name']); });

    await user.selectOptions(resourceTag(), 'cost-center');
    expect(label()).toHaveProperty('value', 'Cost Center');
    expect(screen.getByText('30% coverage · 1 distinct values')).toBeDefined();
    expect(screen.queryByText('Pick a resource tag or an account source.')).toBeNull();
    // With a resource tag, the account source becomes its fallback.
    expect(within(accountSource()).getAllByRole('option')[0]?.textContent).toBe('No fallback');

    // A label already set is kept when the tag changes.
    await user.selectOptions(resourceTag(), 'app_name');
    expect(label()).toHaveProperty('value', 'Cost Center');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByLabelText('Concept')).toBeNull();
    const config = await applyDraft(user, save);
    expect(config.tags).toEqual([TEAM, { tagName: 'app_name', label: 'Cost Center' }]);
    expect(config.order).toEqual(['builtin:service', 'tag:team', 'tag:app_name']);
  });

  it('names a snake_case or kebab-case tag in title case', async () => {
    const { user } = renderView([]);
    await openAddEditor(user);
    await waitFor(() => { expect(within(resourceTag()).getByRole('option', { name: 'app_name' })).toBeDefined(); });
    await user.selectOptions(resourceTag(), 'app_name');
    expect(label()).toHaveProperty('value', 'App Name');
  });

  it('closes the new-dimension form on Cancel without adding anything', async () => {
    const { user } = renderView([TEAM]);
    await openAddEditor(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Concept')).toBeNull();
    expect(screen.getByText('Saved')).toBeDefined();
  });

  it('builds an account-only dimension from one segment of the OU Path', async () => {
    const { save, user } = renderView([TEAM]);
    await openAddEditor(user);
    expect(screen.queryByLabelText(/^OU Path segment/)).toBeNull();

    await user.selectOptions(accountSource(), OU_PATH_SOURCE_KEY);
    expect(screen.queryByText('Pick a resource tag or an account source.')).toBeNull();
    // The full path: one value per distinct OU, the account with none skipped.
    expect(screen.getByText('3 distinct values')).toBeDefined();
    expect(previewValues()).toEqual(['Root / Engineering / Payments', 'Root / Engineering / Search', 'Root / Finance']);

    setSegment('2');
    expect(screen.getByText('2 distinct values')).toBeDefined();
    expect(previewValues()).toEqual(['Engineering', 'Finance']);

    // Negative indices count from the end.
    setSegment('-1');
    expect(previewValues()).toEqual(['Finance', 'Payments', 'Search']);

    // A path too short for the segment contributes nothing.
    setSegment('3');
    expect(previewValues()).toEqual(['Payments', 'Search']);
    setSegment('9');
    expect(screen.queryByText(/distinct values/)).toBeNull();
    expect(screen.queryByText(/^Preview — /)).toBeNull();

    // 0 and blank both keep the full path.
    setSegment('0');
    expect(screen.getByText('3 distinct values')).toBeDefined();
    setSegment('');
    expect(screen.getByText('3 distinct values')).toBeDefined();

    setSegment('-1');
    await user.type(label(), 'Business Unit');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = await row('source:');
    expect(within(saved).getByText('Business Unit')).toBeDefined();
    expect(within(saved).getByText(/source:\s*OU Path/)).toBeDefined();
    expect(within(saved).getByText('segment -1')).toBeDefined();
    expect(within(saved).queryByText(/^tag:/)).toBeNull();

    const config = await applyDraft(user, save);
    expect(config.tags[1]).toEqual({
      label: 'Business Unit',
      accountTagFallback: OU_PATH_SOURCE_KEY,
      pathSegment: { separator: ' / ', index: -1 },
    });
  });

  it('counts an account tag\'s values as the fallback source', async () => {
    const { user } = renderView([]);
    await openAddEditor(user);
    await user.selectOptions(accountSource(), 'CostCenter');
    // cc-1 is on two accounts, cc-2 on one; the empty value is skipped.
    expect(screen.getByText('2 distinct values')).toBeDefined();
    expect(previewValues()).toEqual(['cc-1', 'cc-2']);
    // Only the OU Path is segmented.
    expect(screen.queryByLabelText(/^OU Path segment/)).toBeNull();
  });
});

describe('TagEditor — saved account-only dimensions', () => {
  it('opens on the saved OU Path segment and shows it on the row', async () => {
    const unit: TagDimension = { label: 'Business Unit', accountTagFallback: OU_PATH_SOURCE_KEY, pathSegment: { separator: ' / ', index: 2 } };
    const { user } = renderView([unit]);
    const saved = await row('segment 2');
    expect(within(saved).getByText(/source:\s*OU Path/)).toBeDefined();

    await openTagEditor(user, 'segment 2');
    expect(resourceTag()).toHaveProperty('value', '');
    expect(accountSource()).toHaveProperty('value', OU_PATH_SOURCE_KEY);
    expect(segment()).toHaveProperty('value', '2');
    expect(previewValues()).toEqual(['Engineering', 'Finance']);
  });

  it('treats an empty tag key as account-only on the row', async () => {
    const { user } = renderView([{ tagName: '', label: 'Cost Center', accountTagFallback: 'CostCenter' }]);
    const saved = await row('source:');
    expect(within(saved).getByText(/source:\s*CostCenter/)).toBeDefined();
    expect(within(saved).queryByText(/^tag:/)).toBeNull();
    await openTagEditor(user, 'source:');
    expect(screen.getByLabelText(/^Account source/)).toHaveProperty('value', 'CostCenter');
  });

  it('lists every setting of a configured tag on its row', async () => {
    renderView([{
      tagName: 'env',
      label: 'Environment',
      concept: 'environment',
      normalize: 'lowercase',
      aliases: { prod: ['production', 'prd'], dev: ['development'] },
      accountTagFallback: 'Env',
      missingValueTemplate: 'acct-{fallback}',
      description: 'Deployment stage of the workload',
    }]);
    const saved = await row('tag:env');
    expect(within(saved).getByText('environment')).toBeDefined();
    expect(within(saved).getByText('lowercase')).toBeDefined();
    expect(within(saved).getByText('2 alias rules')).toBeDefined();
    expect(within(saved).getByText(/fallback:\s*Env/)).toBeDefined();
    expect(within(saved).getByText('missing: acct-{fallback}')).toBeDefined();
    expect(within(saved).getByText('Deployment stage of the workload')).toBeDefined();
  });
});

describe('TagEditor — default filter', () => {
  it('offers the resolved values of the tag and its fallback, and saves the pick', async () => {
    const { save, user } = renderView([{ ...TEAM, accountTagFallback: 'CostCenter', normalize: 'uppercase' }]);
    await openTagEditor(user, 'tag:team');
    await user.click(screen.getByRole('button', { name: /No defaults/ }));
    // Normalized like the query resolves them, and sorted.
    expect(screen.getAllByRole('checkbox').map(c => c.parentElement?.textContent)).toEqual(['CC-1', 'CC-2', 'PAYMENTS', 'SEARCH']);

    await user.click(screen.getByRole('checkbox', { name: 'PAYMENTS' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const config = await applyDraft(user, save);
    expect(config.tags[0]?.defaultFilterValues).toEqual(['PAYMENTS']);
  });

  it('has nothing to offer before a source is picked', async () => {
    const { user } = renderView([]);
    await openAddEditor(user);
    await user.click(screen.getByRole('button', { name: /No defaults/ }));
    expect(screen.getByText('No discovered values yet.')).toBeDefined();
  });
});

describe('Tag dimension pills', () => {
  it('toggling a tag pill hides the dimension from the enabled list, and back', async () => {
    const env: TagDimension = { tagName: 'env', label: 'Environment' };
    const { save, user } = renderView([TEAM, env]);
    const pill = await screen.findByRole('button', { name: 'Team' });
    expect(pill.getAttribute('title')).toBe('Click to disable');

    await user.click(pill);
    expect(screen.getByRole('button', { name: 'Team' }).getAttribute('title')).toBe('Click to enable');
    expect(screen.queryByRole('button', { name: /tag:team/ })).toBeNull();

    expect(enabledRowLabels()).toEqual(['Service', 'Environment']);

    await user.click(screen.getByRole('button', { name: 'Team' }));
    // A re-enabled dimension rejoins the list at the end.
    expect(enabledRowLabels()).toEqual(['Service', 'Environment', 'Team']);

    await user.click(screen.getByRole('button', { name: 'Environment' }));
    const config = await applyDraft(user, save);
    expect(config.tags).toEqual([TEAM, { ...env, enabled: false }]);
    expect(config.order).toEqual(['builtin:service', 'tag:team']);
  });
});
