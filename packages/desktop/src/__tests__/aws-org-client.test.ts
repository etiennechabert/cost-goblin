import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeOrganizationCommand,
  ListAccountsCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-organizations';
import { syncOrgAccounts } from '../main/aws-org-client.js';
import type { OrgSyncProgress } from '../main/aws-org-client.js';

/** syncOrgAccounts against a scripted AWS Organizations API: every command the
 *  client sends is answered from the in-memory org below, page by page, so the
 *  pagination, OU-path resolution and tag fallbacks run without AWS. */

const sdk = vi.hoisted(() => {
  const clientConfigs: unknown[] = [];
  return { clientConfigs, send: vi.fn<(command: unknown) => Promise<unknown>>() };
});

vi.mock('@aws-sdk/client-organizations', () => {
  const command = (): new (input: unknown) => { readonly input: unknown } =>
    class {
      readonly input: unknown;
      constructor(input: unknown) { this.input = input; }
    };
  class OrganizationsClient {
    constructor(config: unknown) { sdk.clientConfigs.push(config); }
    send(cmd: unknown): Promise<unknown> { return sdk.send(cmd); }
  }
  return {
    OrganizationsClient,
    DescribeOrganizationCommand: command(),
    ListAccountsCommand: command(),
    ListRootsCommand: command(),
    ListOrganizationalUnitsForParentCommand: command(),
    ListAccountsForParentCommand: command(),
    ListTagsForResourceCommand: command(),
  };
});

interface AccountItem { Id?: string; Name?: string; Email?: string; Status?: string; JoinedTimestamp?: Date }
interface OuItem { Id?: string; Name?: string }
interface TagItem { Key?: string; Value?: string }

/** A paginated listing: each inner array is one page. No pages at all answers
 *  with a response that omits the list field entirely. */
type Pages<T> = readonly (readonly T[])[];

interface FakeOrg {
  readonly orgId?: string;
  readonly rootId?: string;
  readonly accounts: Pages<AccountItem>;
  readonly ousByParent: Readonly<Record<string, Pages<OuItem>>>;
  readonly accountsByParent: Readonly<Record<string, Pages<{ Id?: string }>>>;
  readonly tagsByAccount: Readonly<Record<string, Pages<TagItem> | Error>>;
}

/** The response for one page request: `field` holds the page, `NextToken` the
 *  next page's index while pages remain. */
function page<T>(pages: Pages<T>, token: string | undefined, field: string): Record<string, unknown> {
  const index = token === undefined ? 0 : Number(token);
  const items = pages[index];
  if (items === undefined) return {};
  return { [field]: items, ...(index + 1 < pages.length ? { NextToken: String(index + 1) } : {}) };
}

function serve(org: FakeOrg): void {
  sdk.send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeOrganizationCommand) {
      return Promise.resolve(org.orgId === undefined ? {} : { Organization: { Id: org.orgId } });
    }
    if (cmd instanceof ListRootsCommand) {
      return Promise.resolve(org.rootId === undefined ? {} : { Roots: [{ Id: org.rootId }] });
    }
    if (cmd instanceof ListAccountsCommand) {
      return Promise.resolve(page(org.accounts, cmd.input.NextToken, 'Accounts'));
    }
    if (cmd instanceof ListOrganizationalUnitsForParentCommand) {
      return Promise.resolve(page(org.ousByParent[cmd.input.ParentId ?? ''] ?? [], cmd.input.NextToken, 'OrganizationalUnits'));
    }
    if (cmd instanceof ListAccountsForParentCommand) {
      return Promise.resolve(page(org.accountsByParent[cmd.input.ParentId ?? ''] ?? [], cmd.input.NextToken, 'Accounts'));
    }
    if (cmd instanceof ListTagsForResourceCommand) {
      const tags = org.tagsByAccount[cmd.input.ResourceId ?? ''] ?? [];
      return tags instanceof Error ? Promise.reject(tags) : Promise.resolve(page(tags, cmd.input.NextToken, 'Tags'));
    }
    return Promise.reject(new Error('unexpected command'));
  });
}

/** The inputs of every sent command of one type, in send order. */
function inputsOf<T>(type: abstract new (...args: never[]) => T, read: (cmd: T) => unknown): unknown[] {
  return sdk.send.mock.calls.flatMap(([cmd]) => (cmd instanceof type ? [read(cmd)] : []));
}

const JOINED = new Date('2020-01-02T03:04:05.000Z');

const ACME: FakeOrg = {
  orgId: 'o-acme',
  rootId: 'r-root',
  accounts: [
    [{ Id: '111111111111', Name: 'payments', Email: 'payments@acme.test', Status: 'ACTIVE', JoinedTimestamp: JOINED }],
    [
      { Id: '222222222222', Name: 'ledger', Email: 'ledger@acme.test', Status: 'SUSPENDED', JoinedTimestamp: JOINED },
      { Id: '333333333333' },
    ],
  ],
  ousByParent: {
    'r-root': [[{ Id: 'ou-eng', Name: 'Engineering' }], [{ Id: 'ou-fin', Name: 'Finance' }, { Name: 'no id, never listed' }]],
    'ou-eng': [[{ Id: 'ou-web', Name: 'Web' }]],
    'ou-web': [[{ Id: 'ou-blank' }]],
  },
  accountsByParent: {
    'r-root': [[{ Id: '333333333333' }]],
    'ou-web': [[{ Id: '111111111111' }, {}]],
    'ou-fin': [[], [{ Id: '222222222222' }]],
  },
  tagsByAccount: {
    '111111111111': [[{ Key: 'team', Value: 'payments' }], [{ Key: 'env', Value: 'prod' }, { Key: 'no-value' }, { Value: 'no-key' }]],
    '222222222222': new Error('AccessDeniedException'),
  },
};

beforeEach(() => {
  sdk.clientConfigs.length = 0;
  sdk.send.mockReset();
});

describe('syncOrgAccounts', () => {
  it('uses the named profile and maps every account, its OU path and its tags', async () => {
    serve(ACME);

    const result = await syncOrgAccounts('billing');

    expect(sdk.clientConfigs).toEqual([{ profile: 'billing' }]);
    expect(result.orgId).toBe('o-acme');
    expect(Number.isNaN(Date.parse(result.syncedAt))).toBe(false);
    expect(result.accounts).toEqual([
      {
        id: '111111111111', name: 'payments', email: 'payments@acme.test', status: 'ACTIVE',
        joinedTimestamp: '2020-01-02T03:04:05.000Z', ouPath: 'Engineering / Web', tags: { team: 'payments', env: 'prod' },
      },
      {
        id: '222222222222', name: 'ledger', email: 'ledger@acme.test', status: 'SUSPENDED',
        joinedTimestamp: '2020-01-02T03:04:05.000Z', ouPath: 'Finance', tags: {},
      },
      { id: '333333333333', name: '', email: '', status: 'UNKNOWN', joinedTimestamp: '', ouPath: '', tags: {} },
    ]);
  });

  it('follows NextToken through every paginated listing', async () => {
    serve(ACME);

    await syncOrgAccounts('billing');

    expect(inputsOf(ListAccountsCommand, c => c.input.NextToken)).toEqual([undefined, '1']);
    // Breadth-first over the OU tree; the id-less OU is neither recorded nor walked.
    expect(inputsOf(ListOrganizationalUnitsForParentCommand, c => [c.input.ParentId, c.input.NextToken])).toEqual([
      ['r-root', undefined], ['r-root', '1'], ['ou-eng', undefined], ['ou-fin', undefined], ['ou-web', undefined], ['ou-blank', undefined],
    ]);
    expect(inputsOf(ListAccountsForParentCommand, c => [c.input.ParentId, c.input.NextToken])).toEqual([
      ['r-root', undefined], ['ou-eng', undefined], ['ou-fin', undefined], ['ou-fin', '1'], ['ou-web', undefined], ['ou-blank', undefined],
    ]);
    expect(inputsOf(ListTagsForResourceCommand, c => [c.input.ResourceId, c.input.NextToken])).toEqual([
      ['111111111111', undefined], ['111111111111', '1'], ['222222222222', undefined], ['333333333333', undefined],
    ]);
  });

  it('reports progress through the accounts, OU and tag phases', async () => {
    serve(ACME);
    const progress: OrgSyncProgress[] = [];

    await syncOrgAccounts('billing', p => { progress.push(p); });

    expect(progress).toEqual([
      { phase: 'accounts', done: 0, total: 0 },
      { phase: 'accounts', done: 1, total: 1 },
      { phase: 'accounts', done: 3, total: 3 },
      { phase: 'ous', done: 0, total: 0 },
      { phase: 'ous', done: 2, total: 2 },
      { phase: 'ous', done: 3, total: 3 },
      { phase: 'ous', done: 3, total: 3 },
      { phase: 'ous', done: 4, total: 4 },
      { phase: 'ous', done: 4, total: 4 },
      { phase: 'tags', done: 0, total: 3 },
      { phase: 'tags', done: 1, total: 3 },
      { phase: 'tags', done: 2, total: 3 },
      { phase: 'tags', done: 3, total: 3 },
    ]);
  });

  it('runs on the default credential chain and degrades when the org has no id or root', async () => {
    serve({
      accounts: [[{ Id: '444444444444', Name: 'sandbox' }]],
      ousByParent: {},
      accountsByParent: {},
      tagsByAccount: {},
    });

    const result = await syncOrgAccounts('default');

    expect(sdk.clientConfigs).toEqual([{}]);
    expect(result.orgId).toBe('unknown');
    // No root came back, so the OU walk starts from (and finds nothing under) ''.
    expect(inputsOf(ListOrganizationalUnitsForParentCommand, c => c.input.ParentId)).toEqual(['']);
    expect(result.accounts).toEqual([
      { id: '444444444444', name: 'sandbox', email: '', status: 'UNKNOWN', joinedTimestamp: '', ouPath: '', tags: {} },
    ]);
  });

  it('keeps an account the listing returns without an id, under a blank id', async () => {
    serve({ orgId: 'o-1', rootId: 'r-1', accounts: [[{ Name: 'half-created', Status: 'PENDING_CLOSURE' }]], ousByParent: {}, accountsByParent: {}, tagsByAccount: {} });

    const result = await syncOrgAccounts('default');

    expect(result.accounts).toEqual([
      { id: '', name: 'half-created', email: '', status: 'PENDING_CLOSURE', joinedTimestamp: '', ouPath: '', tags: {} },
    ]);
  });

  it('returns no accounts for an organization that lists none', async () => {
    serve({ orgId: 'o-empty', rootId: 'r-1', accounts: [], ousByParent: {}, accountsByParent: {}, tagsByAccount: {} });

    const result = await syncOrgAccounts('default');

    expect(result.orgId).toBe('o-empty');
    expect(result.accounts).toEqual([]);
    expect(inputsOf(ListTagsForResourceCommand, c => c.input.ResourceId)).toEqual([]);
  });

  it('fails the sync when the organization itself cannot be described', async () => {
    sdk.send.mockRejectedValue(new Error('AWSOrganizationsNotInUseException'));

    await expect(syncOrgAccounts('billing')).rejects.toThrow('AWSOrganizationsNotInUseException');
  });
});
