import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, OU_PATH_SOURCE_KEY } from '@costgoblin/core/browser';
import type { BuiltInDimension, ColumnValuesPreview, CostApi, DimensionsConfig, OrgAccount, OrgSyncResult, StripPatternIssues } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The account dimension's editor resolves account ids to names through the
 *  AWS Organization sync: either the account's Name field or one of its
 *  account-level tags (the OU Path counts as one), then strips noise from the
 *  names with regexes. */

const ACCOUNT: BuiltInDimension = {
  name: asDimensionId('account'),
  label: 'Account',
  field: 'account_id',
  displayField: 'account_name',
  useOrgAccounts: true,
};
const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };

function account(id: string, name: string, ouPath: string, tags: Readonly<Record<string, string>>): OrgAccount {
  return { id, name, email: `${name}@example.com`, status: 'ACTIVE', joinedTimestamp: '2024-01-01T00:00:00Z', ouPath, tags };
}

const ORG: OrgSyncResult = {
  orgId: 'o-example',
  syncedAt: '2026-04-30T00:00:00Z',
  accounts: [
    account('111111111111', 'acme-payments', 'Root / Engineering / Payments', { team: 'payments', CostCenter: 'cc-1' }),
    account('222222222222', 'acme-search', 'Root / Engineering / Search', { team: 'search' }),
  ],
};

function previewWith(stripIssues: StripPatternIssues): ColumnValuesPreview {
  return { values: [{ value: 'payments', cost: 100 }], distinctCount: 1, period: '2026-04', stripIssues };
}

function renderView(accountDim: BuiltInDimension, org: OrgSyncResult | null, stripIssues: StripPatternIssues = { invalid: [], slow: [], skipped: [] }) {
  const api: CostApi = new MockCostApi();
  const config: DimensionsConfig = { builtIn: [accountDim, SERVICE], tags: [] };
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  vi.spyOn(api, 'getOrgSyncResult').mockResolvedValue(org);
  const discover = vi.spyOn(api, 'discoverColumnValues').mockResolvedValue(previewWith(stripIssues));
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { discover, save, user };
}

/** Opens the account dim's editor, once the view has the org sync's tag keys
 *  (the Account Tags panel counts them) when there is a sync to wait for. */
async function openAccountEditor(user: ReturnType<typeof userEvent.setup>, org: OrgSyncResult | null = ORG): Promise<void> {
  if (org !== null) await screen.findByText(new RegExp(`across ${String(org.accounts.length)} accounts`));
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button', { name: /account_id/ })[0];
    if (found === undefined) throw new Error('account row not rendered yet');
    return found;
  });
  await user.click(row);
  await screen.findByLabelText('Display Label');
}

function nameSource(): HTMLElement {
  return screen.getByLabelText('Name source (from org-sync)');
}

function tagKey(): HTMLElement {
  return screen.getByLabelText('Tag key');
}

function optionLabels(select: HTMLElement): string[] {
  return within(select).getAllByRole('option').map(o => o.textContent);
}

async function applyDraft(user: ReturnType<typeof userEvent.setup>, save: ReturnType<typeof renderView>['save']): Promise<DimensionsConfig> {
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

describe('BuiltInEditor — account name source', () => {
  it('switches between the Name field, an account tag and the OU Path, previewing each', async () => {
    const { discover, save, user } = renderView(ACCOUNT, ORG);
    await openAccountEditor(user);
    expect(nameSource()).toHaveProperty('value', 'name');
    expect(screen.queryByLabelText('Tag key')).toBeNull();

    // Picking "Account Tag" starts on the first synced tag key.
    await user.selectOptions(nameSource(), 'tag');
    expect(tagKey()).toHaveProperty('value', 'CostCenter');
    expect(optionLabels(tagKey())).toEqual(['OU Path', 'CostCenter', 'team']);
    await waitFor(() => {
      expect(discover).toHaveBeenLastCalledWith('account_id', { useOrgAccounts: true, nameStripPatterns: [], accountNameFromTag: 'CostCenter' });
    });

    await user.selectOptions(tagKey(), OU_PATH_SOURCE_KEY);
    await waitFor(() => { expect(discover).toHaveBeenLastCalledWith('account_id', expect.objectContaining({ accountNameFromTag: OU_PATH_SOURCE_KEY })); });

    // Back to the Name field: no tag is sent.
    await user.selectOptions(nameSource(), 'name');
    expect(screen.queryByLabelText('Tag key')).toBeNull();
    await waitFor(() => { expect(discover).toHaveBeenLastCalledWith('account_id', { useOrgAccounts: true, nameStripPatterns: [] }); });

    await user.selectOptions(nameSource(), 'tag');
    await user.selectOptions(tagKey(), 'team');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = await applyDraft(user, save);
    expect(saved.builtIn[0]).toEqual({ ...ACCOUNT, accountNameFromTag: 'team' });
  });

  it('keeps a saved tag key the sync no longer reports', async () => {
    const { user } = renderView({ ...ACCOUNT, accountNameFromTag: 'LegacyName' }, ORG);
    await openAccountEditor(user);
    expect(nameSource()).toHaveProperty('value', 'tag');
    expect(tagKey()).toHaveProperty('value', 'LegacyName');
    expect(optionLabels(tagKey())).toEqual(['OU Path', 'LegacyName', 'CostCenter', 'team']);
  });

  it('lists the OU Path once when it is the saved source', async () => {
    const { user } = renderView({ ...ACCOUNT, accountNameFromTag: OU_PATH_SOURCE_KEY }, ORG);
    await openAccountEditor(user);
    expect(tagKey()).toHaveProperty('value', OU_PATH_SOURCE_KEY);
    expect(optionLabels(tagKey())).toEqual(['OU Path', 'CostCenter', 'team']);
  });

  it('warns when the org sync has not run, and falls back to the OU Path', async () => {
    const { user } = renderView(ACCOUNT, null);
    await openAccountEditor(user, null);
    expect(await screen.findByText('Org-data not synced')).toBeDefined();

    await user.selectOptions(nameSource(), 'tag');
    expect(tagKey()).toHaveProperty('value', OU_PATH_SOURCE_KEY);
    expect(optionLabels(tagKey())).toEqual(['OU Path']);
  });

  it('does not warn once org data is synced', async () => {
    const { user } = renderView(ACCOUNT, ORG);
    await openAccountEditor(user);
    await screen.findByText(/Preview — 1 distinct values/);
    expect(screen.queryByText('Org-data not synced')).toBeNull();
  });

  it('saves a legacy account dimension as org-sourced, with its strip patterns trimmed', async () => {
    const legacy: BuiltInDimension = { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' };
    const { save, user } = renderView(legacy, ORG);
    await openAccountEditor(user);
    await user.type(screen.getByLabelText(/Name strip patterns/), '  ^acme-  {Enter}{Enter} -prod$');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = await applyDraft(user, save);
    expect(saved.builtIn[0]).toEqual({ ...legacy, useOrgAccounts: true, nameStripPatterns: ['^acme-', '-prod$'] });
  });
});

describe('BuiltInEditor — strip pattern issues', () => {
  it('words several skipped patterns in the plural, and a single unevaluated one in the singular', async () => {
    const { user } = renderView({ ...ACCOUNT, nameStripPatterns: ['a', 'b', 'c', 'd', 'e'] }, ORG, { slow: [0, 1], invalid: [2, 3], skipped: [4] });
    await openAccountEditor(user);

    expect(await screen.findByText(/^Patterns 1, 2 took too long and were skipped — simplify them/)).toBeDefined();
    expect(screen.getByText('Patterns 3, 4 are not a valid regular expression and were skipped.')).toBeDefined();
    expect(screen.getByText('Pattern 5 was not evaluated — the preview ran out of time.')).toBeDefined();
  });
});
