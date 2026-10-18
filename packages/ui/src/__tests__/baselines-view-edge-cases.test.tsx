import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BaselineDetail,
  BaselineRecord,
  BaselinesListParams,
  BaselinesListResult,
  BaselineTriageStatus,
  BaselineUpdatePatch,
} from '@costgoblin/core/browser';
import { asDollars, OPEN_TRIAGE_STATUSES } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { Baselines } from '../views/baselines.js';
import { baselineDetail, baselineRecord, baselineSpec, deferred, rejectWith } from './baseline-fixtures.js';
import { setReducedMotion } from './setup.js';

// Hold the coin-rain loader still: animated, its per-frame state updates keep
// restarting the transition useQuery commits a result in, which on a slow
// runner can push the list past the findBy budget. setup.ts restores it.
beforeEach(() => {
  setReducedMotion(true);
});

function row(id: string, scopeLabel: string, triageStatus: BaselineTriageStatus, potential: number, realized: number): BaselineRecord {
  return baselineRecord({
    spec: baselineSpec({ id }),
    scopeLabel,
    triageStatus,
    savings: {
      potentialDaily: asDollars(potential / 30),
      realizedDaily: asDollars(realized / 30),
      potentialMonthly: asDollars(potential),
      realizedMonthly: asDollars(realized),
    },
  });
}

const RDS = row('rds', 'Amazon RDS', 'new', 900, 0);
const S3 = row('s3', 'Amazon S3', 'tracking', 300, 150);
const CLOUDFRONT = row('cf', 'Amazon CloudFront', 'new', 100, 50);
const EC2 = row('ec2', 'Amazon EC2', 'acting', 0, 600);

const OPEN = new Set<BaselineTriageStatus>(OPEN_TRIAGE_STATUSES);

function listFor(all: readonly BaselineRecord[], params: BaselinesListParams): BaselinesListResult {
  const { triage } = params;
  const items = all.filter((r) => triage === undefined || (triage === 'open' ? OPEN.has(r.triageStatus) : r.triageStatus === triage));
  const count = (status: BaselineTriageStatus): number => all.filter((r) => r.triageStatus === status).length;
  return {
    items,
    totalPotentialMonthly: asDollars(items.reduce((s, r) => s + r.savings.potentialMonthly, 0)),
    totalRealizedMonthly: asDollars(items.reduce((s, r) => s + r.savings.realizedMonthly, 0)),
    total: items.length,
    counts: {
      all: all.length,
      open: all.filter((r) => OPEN.has(r.triageStatus)).length,
      new: count('new'), tracking: count('tracking'), acting: count('acting'),
      resolved: count('resolved'), dismissed: count('dismissed'), ignored: count('ignored'),
    },
  };
}

/** A baselines backend that lists `items` in the order given and persists
 *  status writes. `newList`, when set, answers the triage queue's request. */
class BaselinesApi extends MockCostApi {
  items: readonly BaselineRecord[];
  newList: (() => Promise<BaselinesListResult>) | null = null;
  readonly listCalls: BaselinesListParams[] = [];

  constructor(items: readonly BaselineRecord[]) {
    super();
    this.items = items;
  }

  override listBaselines(params?: BaselinesListParams): Promise<BaselinesListResult> {
    const p = params ?? {};
    this.listCalls.push(p);
    if (p.triage === 'new' && this.newList !== null) return this.newList();
    return Promise.resolve(listFor(this.items, p));
  }

  override getBaseline(id?: string): Promise<BaselineDetail | null> {
    const record = this.items.find((r) => r.spec.id === id);
    return Promise.resolve(record === undefined ? null : baselineDetail(record));
  }

  override updateBaseline(id?: string, patch?: BaselineUpdatePatch): Promise<BaselineRecord | null> {
    const status = patch?.triageStatus;
    if (status !== undefined) {
      this.items = this.items.map((r) => (r.spec.id === id ? { ...r, triageStatus: status } : r));
    }
    return Promise.resolve(this.items.find((r) => r.spec.id === id) ?? null);
  }

  triageCalls(): number {
    return this.listCalls.filter((p) => p.triage === 'new').length;
  }
}

function renderView(api: BaselinesApi) {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <Baselines />
    </CostApiProvider>,
  );
  return { user };
}

/** The scope of each table row, top to bottom. */
function listedScopes(): string[] {
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  return rows.map((tr) => tr.querySelector('td')?.textContent ?? '');
}

function position(dialog: HTMLElement): string | null {
  return within(dialog).getByText(/^\d+ \/ \d+$/).textContent;
}

describe('Baselines — stepping through the table', () => {
  it('follows the table’s sort, not the order the API lists the rows in', async () => {
    const api = new BaselinesApi([EC2, CLOUDFRONT, S3, RDS]);
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Amazon RDS' });
    // Shown by potential saving, the table's default sort.
    expect(listedScopes()).toEqual(['Amazon RDS', 'Amazon S3', 'Amazon CloudFront', 'Amazon EC2']);

    await user.click(screen.getByRole('button', { name: 'Amazon RDS' }));
    const first = await screen.findByRole('dialog', { name: 'Amazon RDS' });
    expect(position(first)).toBe('1 / 4');
    expect(within(first).getByRole('button', { name: 'Previous baseline (←)' })).toHaveProperty('disabled', true);

    await user.click(within(first).getByRole('button', { name: 'Next baseline (→)' }));
    const second = await screen.findByRole('dialog', { name: 'Amazon S3' });
    expect(position(second)).toBe('2 / 4');
  });

  it('follows a re-sort of the table', async () => {
    const api = new BaselinesApi([RDS, S3, CLOUDFRONT, EC2]);
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Amazon RDS' });

    await user.click(screen.getByRole('button', { name: /^Realized\/mo/ }));
    expect(listedScopes()).toEqual(['Amazon EC2', 'Amazon S3', 'Amazon CloudFront', 'Amazon RDS']);

    await user.click(screen.getByRole('button', { name: 'Amazon RDS' }));
    const last = await screen.findByRole('dialog', { name: 'Amazon RDS' });
    expect(position(last)).toBe('4 / 4');
    expect(within(last).getByRole('button', { name: 'Next baseline (→)' })).toHaveProperty('disabled', true);

    await user.click(within(last).getByRole('button', { name: 'Previous baseline (←)' }));
    const third = await screen.findByRole('dialog', { name: 'Amazon CloudFront' });
    expect(position(third)).toBe('3 / 4');
    await user.keyboard('{ArrowLeft}');
    const second = await screen.findByRole('dialog', { name: 'Amazon S3' });
    expect(position(second)).toBe('2 / 4');
  });

  it('drops the position once the list empties under the open baseline', async () => {
    const api = new BaselinesApi([CLOUDFRONT]);
    const { user } = renderView(api);
    await user.click(await screen.findByRole('button', { name: 'Amazon CloudFront' }));
    const dialog = await screen.findByRole('dialog', { name: 'Amazon CloudFront' });
    expect(position(dialog)).toBe('1 / 1');

    // Dismissed, it leaves the Open list, which is then empty. Wait for both
    // reloads to land: the arrows are also gone while the detail reloads.
    await user.click(within(dialog).getByRole('button', { name: /^\d\s*Dismissed$/ }));
    expect(await screen.findByText(/^No baselines yet/)).toBeDefined();
    expect(await within(dialog).findByText('Dismissed', { selector: 'span' })).toBeDefined();
    expect(within(dialog).queryByText(/^\d+ \/ \d+$/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Next baseline (→)' })).toBeNull();
  });
});

describe('Baselines — starting triage', () => {
  it('shows why triage could not start, and clears it once triage starts', async () => {
    const api = new BaselinesApi([RDS, S3, CLOUDFRONT, EC2]);
    const failures: unknown[] = [new Error('Database is locked'), 'IPC channel closed'];
    api.newList = () => {
      const reason = failures.shift();
      return reason === undefined ? Promise.resolve(listFor(api.items, { triage: 'new' })) : rejectWith(reason);
    };
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Amazon RDS' });

    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    expect(await screen.findByText("Couldn't start triage: Database is locked")).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();

    // A rejection that is not an Error is shown as-is.
    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    expect(await screen.findByText("Couldn't start triage: IPC channel closed")).toBeDefined();
    expect(screen.queryByText(/Database is locked/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    expect(await screen.findByRole('dialog', { name: 'Amazon RDS' })).toBeDefined();
    expect(screen.queryByText(/^Couldn't start triage/)).toBeNull();
    expect(api.triageCalls()).toBe(3);
  });

  it('locks Triage new while the new baselines load', async () => {
    const api = new BaselinesApi([RDS, S3, CLOUDFRONT, EC2]);
    const pending = deferred<BaselinesListResult>();
    api.newList = () => pending.promise;
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Amazon RDS' });

    const triage = screen.getByRole('button', { name: 'Triage new' });
    await user.click(triage);
    expect(triage).toHaveProperty('disabled', true);
    await user.click(triage);
    expect(api.triageCalls()).toBe(1);

    // Nothing new after all: the button frees up and nothing opens.
    pending.resolve(listFor([S3, EC2], { triage: 'new' }));
    await waitFor(() => { expect(triage).toHaveProperty('disabled', false); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/^Couldn't start triage/)).toBeNull();
  });
});
