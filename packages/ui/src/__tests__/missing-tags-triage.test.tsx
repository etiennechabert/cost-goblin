import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dimension, MissingTagsParams, MissingTagsResult } from '@costgoblin/core/browser';
import { asDimensionId, asDollars, asEntityRef } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { MissingTags } from '../views/missing-tags.js';
import { daysAgo } from '../lib/dates.js';

/** Three actionable rows (two owned by `platform`, one with no fallback
 *  owner), two likely-untaggable ones, and non-resource spend. The counts are
 *  scoped below their unfiltered totals, as when a min-cost filter applies. */
const RESULT: MissingTagsResult = {
  rows: [
    { accountId: '111111111111', accountName: 'prod-main', resourceId: 'i-0aaa', service: 'Amazon EC2', serviceCategory: 'Compute', cost: asDollars(1_200), closestOwner: asEntityRef('platform'), bucket: 'actionable', categoryTaggedRatio: 0.82 },
    { accountId: '111111111111', accountName: 'prod-main', resourceId: 'i-0bbb', service: 'Amazon EC2', serviceCategory: 'Compute', cost: asDollars(300), closestOwner: asEntityRef('platform'), bucket: 'actionable', categoryTaggedRatio: 0.82 },
    { accountId: '222222222222', accountName: 'prod-data', resourceId: 'db-analytics', service: 'Amazon RDS', serviceCategory: 'Databases', cost: asDollars(870), closestOwner: null, bucket: 'actionable', categoryTaggedRatio: 0.65 },
    { accountId: '333333333333', accountName: 'staging', resourceId: 'bucket-a', service: 'Amazon S3', serviceCategory: 'Storage', cost: asDollars(340), closestOwner: asEntityRef('platform'), bucket: 'likely-untaggable', categoryTaggedRatio: 0 },
    { accountId: '333333333333', accountName: 'staging', resourceId: 'bucket-b', service: 'Amazon S3', serviceCategory: 'Storage', cost: asDollars(60), closestOwner: null, bucket: 'likely-untaggable', categoryTaggedRatio: 0 },
  ],
  totalRows: 5,
  totalActionableCost: asDollars(2_370),
  totalLikelyUntaggableCost: asDollars(400),
  totalNonResourceCost: asDollars(150),
  actionableCount: 3,
  likelyUntaggableCount: 2,
  unfilteredActionableCount: 7,
  unfilteredActionableCost: asDollars(5_000),
  unfilteredLikelyUntaggableCount: 4,
  unfilteredLikelyUntaggableCost: asDollars(900),
  nonResourceRows: [
    { service: 'Tax', serviceCategory: '', chargeCategory: 'Tax', cost: asDollars(95) },
    { service: 'AWS Support', serviceCategory: 'Support', chargeCategory: 'Purchase', cost: asDollars(55) },
  ],
};

const EMPTY: MissingTagsResult = {
  ...RESULT,
  rows: [],
  totalRows: 0,
  actionableCount: 0,
  likelyUntaggableCount: 0,
  nonResourceRows: [],
};

class TriageApi extends MockCostApi {
  readonly missingCalls: MissingTagsParams[] = [];
  result: MissingTagsResult = RESULT;

  override queryMissingTags(params?: MissingTagsParams): Promise<MissingTagsResult> {
    if (params !== undefined) this.missingCalls.push(params);
    return Promise.resolve(this.result);
  }
}

function renderView(api: TriageApi = new TriageApi(), onEntityClick?: (entity: string, dimension: string) => void) {
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <MissingTags onEntityClick={onEntityClick} />
      </CostApiProvider>,
    ),
  };
}

/** The bucket's toggle button, found by its title text. */
function bucketToggle(title: string): HTMLElement {
  const heading = screen.getByText(title, { exact: false, selector: 'p' });
  const button = heading.closest('button');
  if (button === null) throw new Error(`no toggle for ${title}`);
  return button;
}

/** The fallback-owner picker trigger ("Fallback <tag>" + the current pick),
 *  not the table's "Fallback <tag>" column header. */
function ownerTrigger(tagLabel = 'Team'): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^Fallback ${tagLabel}\\s*(All|platform|\\(none\\))$`) });
}

function tables(): HTMLElement[] {
  return screen.queryAllByRole('table');
}

/** The first table cell button carrying `name` (cells of dimension columns
 *  render as buttons). */
function cellButton(name: string): HTMLElement {
  const [first] = screen.getAllByRole('button', { name });
  if (first === undefined) throw new Error(`no cell button named ${name}`);
  return first;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MissingTags — buckets', () => {
  it('summarises each bucket against its unfiltered total', async () => {
    renderView();
    expect(await screen.findByText('3 out of 7 untagged resources in taggable categories')).toBeDefined();
    expect(bucketToggle('Actionable').textContent).toContain('$2.4k out of $5.0k');
    expect(screen.getByText('2 out of 4 resources in categories where nothing is tagged')).toBeDefined();
    expect(bucketToggle('Likely not taggable').textContent).toContain('$400.00 out of $900.00');
    expect(bucketToggle('Non-resource cost').textContent).toContain('$150.00');
    expect(screen.getByText('2 categories — tax, support, credits, and usage without a resource')).toBeDefined();
    // Only the actionable bucket starts expanded, with its tagged-ratio column.
    expect(tables()).toHaveLength(1);
    expect(screen.getByText('Tagged in category')).toBeDefined();
    expect(screen.getAllByText('82%')).toHaveLength(2);
  });

  it('expands and collapses each bucket', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    await user.click(bucketToggle('Actionable'));
    expect(tables()).toHaveLength(0);
    expect(bucketToggle('Actionable').textContent).toContain('▸');

    await user.click(bucketToggle('Likely not taggable'));
    expect(tables()).toHaveLength(1);
    const untaggable = within(screen.getByRole('table'));
    expect(untaggable.getByText('bucket-a')).toBeDefined();
    // No ratio column for the bucket where nothing is tagged.
    expect(untaggable.queryByText('Tagged in category')).toBeNull();
    expect(untaggable.getByText('Fallback Team')).toBeDefined();

    await user.click(bucketToggle('Likely not taggable'));
    await user.click(bucketToggle('Non-resource cost'));
    const nonResource = within(screen.getByRole('table'));
    expect(nonResource.getByText('Charge Category')).toBeDefined();
    expect(nonResource.getByText('AWS Support')).toBeDefined();
    expect(nonResource.getByText('Purchase')).toBeDefined();
    expect(nonResource.getByText('$95.00')).toBeDefined();

    await user.click(bucketToggle('Non-resource cost'));
    expect(tables()).toHaveLength(0);
  });

  it('expands a resource row into its details', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    await user.click(screen.getByText('$870.00'));
    const detail = screen.getByText('Account ID').closest('td');
    if (detail === null) throw new Error('detail row not rendered');
    const value = (label: string): string | null | undefined =>
      within(detail).getByText(label).nextElementSibling?.textContent;
    expect(value('Account ID')).toBe('222222222222');
    expect(value('Fallback Owner')).toBe('—');
    expect(value('Bucket')).toBe('actionable');
    expect(value('Category tagged ratio')).toBe('65%');
  });

  it('says when nothing is untagged above the minimum cost', async () => {
    const api = new TriageApi();
    api.result = EMPTY;
    renderView(api);
    expect(await screen.findByText('No untagged resources above $1')).toBeDefined();
    expect(screen.queryByText(/Actionable/)).toBeNull();
    expect(screen.queryByText(/Non-resource cost/)).toBeNull();
  });

  it('shows the query error', async () => {
    const api = new TriageApi();
    vi.spyOn(api, 'queryMissingTags').mockRejectedValue(new Error('Binder Error: column tag_team not found'));
    renderView(api);
    expect(await screen.findByText('Binder Error: column tag_team not found')).toBeDefined();
  });

  it('explains how to start when no tag dimensions exist, and never queries', async () => {
    const api = new TriageApi();
    const dims: Dimension[] = [{ name: asDimensionId('service'), label: 'Service', field: 'service' }];
    vi.spyOn(api, 'getDimensions').mockResolvedValue(dims);
    renderView(api);
    expect(await screen.findByText('No tag dimensions configured')).toBeDefined();
    expect(api.missingCalls).toHaveLength(0);
  });
});

describe('MissingTags — narrowing', () => {
  it('filters every bucket to one fallback owner, including "(none)"', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    await user.click(ownerTrigger());
    // Owners are ranked by their actionable spend.
    const options = await screen.findAllByRole('button', { name: /^(All|platform|\(none\))/ });
    expect(options.map(o => o.textContent)).toEqual(['All', 'platform$1.5k', '(none)$870.00']);

    await user.click(screen.getByRole('button', { name: /^platform/ }));
    expect(ownerTrigger().textContent).toContain('platform');
    expect(screen.getByText('2 untagged resources in taggable categories')).toBeDefined();
    expect(bucketToggle('Actionable').textContent).toContain('$1.5k');
    expect(bucketToggle('Actionable').textContent).not.toContain('out of');
    expect(screen.getByText(/^1 resources? in categories where nothing is tagged$/)).toBeDefined();
    expect(bucketToggle('Likely not taggable').textContent).toContain('$340.00');
    expect(screen.queryByText('db-analytics')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^\(none\)/ }));
    expect(ownerTrigger().textContent).toContain('(none)');
    expect(screen.getByText(/^1 untagged resources? in taggable categories$/)).toBeDefined();
    expect(bucketToggle('Actionable').textContent).toContain('$870.00');
    expect(bucketToggle('Likely not taggable').textContent).toContain('$60.00');
    expect(screen.getByText('db-analytics')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('3 out of 7 untagged resources in taggable categories')).toBeDefined();
  });

  it('re-queries for another tag and drops the owner filter', async () => {
    const { api, user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');
    expect(api.missingCalls[0]?.tagDimension).toBe('tag_team');

    await user.click(ownerTrigger());
    await user.click(await screen.findByRole('button', { name: /^platform/ }));
    await user.click(screen.getByRole('button', { name: 'Environment' }));

    await waitFor(() => { expect(api.missingCalls.at(-1)?.tagDimension).toBe('tag_env'); });
    expect(api.missingCalls.at(-1)?.origin).toBe('findings:missing-tags:tag_env');
    await waitFor(() => { expect(ownerTrigger('Environment').textContent).toContain('All'); });
  });

  it('re-queries with the new minimum cost', async () => {
    const { api } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    await waitFor(() => { expect(api.missingCalls.at(-1)?.minCost).toBe(50); });
  });

  it('re-queries a new period and cancels the queries still running for the old one', async () => {
    const api = new TriageApi();
    const cancel = vi.spyOn(api, 'cancelPendingQueries');
    const { user } = renderView(api);
    await screen.findByText('3 out of 7 untagged resources in taggable categories');
    expect(cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 90 days' }));

    await waitFor(() => {
      expect(api.missingCalls.at(-1)?.dateRange).toEqual({ start: daysAgo(92), end: daysAgo(2) });
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('drills through from a dimension cell without expanding the row', async () => {
    const onEntityClick = vi.fn<(entity: string, dimension: string) => void>();
    const { user } = renderView(new TriageApi(), onEntityClick);
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    await user.click(cellButton('prod-data'));
    expect(onEntityClick).toHaveBeenLastCalledWith('prod-data', 'account');
    await user.click(cellButton('Databases'));
    expect(onEntityClick).toHaveBeenLastCalledWith('Databases', 'service_category');
    // A cell click never expands the row.
    expect(screen.queryByText('Account ID')).toBeNull();
  });

  it('ignores dimension cell clicks when no drill-through handler is wired', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');
    await user.click(cellButton('prod-data'));
    expect(screen.getByText('3 out of 7 untagged resources in taggable categories')).toBeDefined();
    expect(screen.queryByText('Account ID')).toBeNull();
  });
});

describe('MissingTags — copy message', () => {
  async function openCopyMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: /Copy message/ }));
  }

  it('copies a Slack summary, then a Jira one, flagging each as copied', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');

    await openCopyMenu(user);
    await user.click(await screen.findByRole('button', { name: 'Slack' }));
    expect(await navigator.clipboard.readText()).toBe([
      '*3 resources* are missing the `Team` tag, representing *$2.4k/month* in unattributed spend.',
      '',
      'Full list in the attached CSV — please tag these resources or confirm they should be excluded.',
    ].join('\n'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Jira' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('h3. Missing {{Team}} tag');
    });
    const jira = await navigator.clipboard.readText();
    expect(jira).toContain('*3 resources* representing *$2.4k/month* in unattributed spend.');
    // Only the format copied last is flagged.
    expect(screen.getByRole('button', { name: 'Slack' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Copied!' })).toHaveLength(1);
  });

  it('scopes both messages to the selected fallback owner', async () => {
    const { user } = renderView();
    await screen.findByText('3 out of 7 untagged resources in taggable categories');
    await user.click(ownerTrigger());
    await user.click(await screen.findByRole('button', { name: /^platform/ }));
    await user.keyboard('{Escape}');

    await openCopyMenu(user);
    await user.click(await screen.findByRole('button', { name: 'Slack' }));
    expect(await navigator.clipboard.readText()).toContain(
      '*2 resources* are missing the `Team` tag (filtered to *platform*), representing *$1.5k/month*',
    );
    await user.click(screen.getByRole('button', { name: 'Jira' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('*2 resources* (filtered to *platform*) representing *$1.5k/month*');
    });
  });
});
