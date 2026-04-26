import { logger } from '@costgoblin/core';

interface OrgAccount {
  id: string;
  name: string;
  email: string;
  status: string;
  joinedTimestamp: string;
  ouPath: string;
  tags: Record<string, string>;
}

interface OrgSyncProgress {
  phase: 'accounts' | 'ous' | 'tags';
  done: number;
  total: number;
}

interface OrgSyncResult {
  accounts: OrgAccount[];
  orgId: string;
  syncedAt: string;
}

interface OUNode {
  id: string;
  name: string;
  parentId: string;
}

async function getOrganizationsModule(): Promise<typeof import('@aws-sdk/client-organizations')> {
  return import('@aws-sdk/client-organizations');
}

type OrgClient = InstanceType<Awaited<ReturnType<typeof getOrganizationsModule>>['OrganizationsClient']>;
type OrgModule = Awaited<ReturnType<typeof getOrganizationsModule>>;

async function listAllAccounts(
  client: OrgClient,
  module: OrgModule,
  onProgress?: (progress: OrgSyncProgress) => void,
): Promise<{ id: string; name: string; email: string; status: string; joinedTimestamp: string }[]> {
  onProgress?.({ phase: 'accounts', done: 0, total: 0 });
  const allAccounts: { id: string; name: string; email: string; status: string; joinedTimestamp: string }[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new module.ListAccountsCommand({ NextToken: nextToken }));
    for (const acct of resp.Accounts ?? []) {
      allAccounts.push({
        id: acct.Id ?? '',
        name: acct.Name ?? '',
        email: acct.Email ?? '',
        status: acct.Status ?? 'UNKNOWN',
        joinedTimestamp: acct.JoinedTimestamp?.toISOString() ?? '',
      });
    }
    nextToken = resp.NextToken;
    onProgress?.({ phase: 'accounts', done: allAccounts.length, total: allAccounts.length });
  } while (nextToken !== undefined);
  return allAccounts;
}

async function buildOuTree(
  client: OrgClient,
  module: OrgModule,
  rootId: string,
  onProgress?: (progress: OrgSyncProgress) => void,
): Promise<OUNode[]> {
  onProgress?.({ phase: 'ous', done: 0, total: 0 });
  const ouNodes: OUNode[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    let ouToken: string | undefined;
    do {
      const resp = await client.send(new module.ListOrganizationalUnitsForParentCommand({
        ParentId: parentId,
        NextToken: ouToken,
      }));
      for (const ou of resp.OrganizationalUnits ?? []) {
        if (ou.Id !== undefined) {
          ouNodes.push({ id: ou.Id, name: ou.Name ?? '', parentId });
          queue.push(ou.Id);
        }
      }
      ouToken = resp.NextToken;
    } while (ouToken !== undefined);
    onProgress?.({ phase: 'ous', done: ouNodes.length, total: ouNodes.length });
  }
  return ouNodes;
}

async function buildAccountParentMap(
  client: OrgClient,
  module: OrgModule,
  parentIds: string[],
): Promise<Map<string, string>> {
  const accountParentMap = new Map<string, string>();
  for (const parentId of parentIds) {
    let acctToken: string | undefined;
    do {
      const resp = await client.send(new module.ListAccountsForParentCommand({
        ParentId: parentId,
        NextToken: acctToken,
      }));
      for (const acct of resp.Accounts ?? []) {
        if (acct.Id !== undefined) {
          accountParentMap.set(acct.Id, parentId);
        }
      }
      acctToken = resp.NextToken;
    } while (acctToken !== undefined);
  }
  return accountParentMap;
}

function makeOuPathResolver(
  ouNodes: OUNode[],
  accountParentMap: Map<string, string>,
  rootId: string,
): (accountId: string) => string {
  const ouMap = new Map(ouNodes.map(ou => [ou.id, ou]));
  return (accountId: string): string => {
    const parts: string[] = [];
    let current = accountParentMap.get(accountId);
    while (current !== undefined && current !== rootId) {
      const ou = ouMap.get(current);
      if (ou === undefined) break;
      parts.unshift(ou.name);
      current = ou.parentId;
    }
    return parts.join(' / ');
  };
}

async function fetchAccountTags(
  client: OrgClient,
  module: OrgModule,
  accountId: string,
): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  let tagToken: string | undefined;
  do {
    const resp = await client.send(new module.ListTagsForResourceCommand({
      ResourceId: accountId,
      NextToken: tagToken,
    }));
    for (const tag of resp.Tags ?? []) {
      if (tag.Key !== undefined && tag.Value !== undefined) {
        tags[tag.Key] = tag.Value;
      }
    }
    tagToken = resp.NextToken;
  } while (tagToken !== undefined);
  return tags;
}

export async function syncOrgAccounts(
  profile: string,
  onProgress?: (progress: OrgSyncProgress) => void,
): Promise<OrgSyncResult> {
  const module = await getOrganizationsModule();
  const config = profile === 'default' ? {} : { profile };
  const client = new module.OrganizationsClient(config);

  const orgResp = await client.send(new module.DescribeOrganizationCommand({}));
  const orgId = orgResp.Organization?.Id ?? 'unknown';

  const allAccounts = await listAllAccounts(client, module, onProgress);
  logger.info(`Discovered ${String(allAccounts.length)} accounts`);

  const roots = await client.send(new module.ListRootsCommand({}));
  const rootId = roots.Roots?.[0]?.Id ?? '';

  const ouNodes = await buildOuTree(client, module, rootId, onProgress);
  const parentIds = [rootId, ...ouNodes.map(ou => ou.id)];
  const accountParentMap = await buildAccountParentMap(client, module, parentIds);
  const resolveOuPath = makeOuPathResolver(ouNodes, accountParentMap, rootId);

  const results: OrgAccount[] = [];
  for (let i = 0; i < allAccounts.length; i++) {
    const acct = allAccounts[i];
    if (acct === undefined) continue;
    onProgress?.({ phase: 'tags', done: i, total: allAccounts.length });

    let tags: Record<string, string> = {};
    try {
      tags = await fetchAccountTags(client, module, acct.id);
    } catch {
      logger.info(`Failed to fetch tags for ${acct.id}, skipping`);
    }

    results.push({ ...acct, ouPath: resolveOuPath(acct.id), tags });
  }
  onProgress?.({ phase: 'tags', done: allAccounts.length, total: allAccounts.length });

  logger.info(`Org sync complete: ${String(results.length)} accounts with tags`);
  return { accounts: results, orgId, syncedAt: new Date().toISOString() };
}

export type { OrgAccount, OrgSyncProgress, OrgSyncResult };
