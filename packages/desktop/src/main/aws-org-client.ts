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

export async function syncOrgAccounts(
  profile: string,
  onProgress?: (progress: OrgSyncProgress) => void,
): Promise<OrgSyncResult> {
  const {
    OrganizationsClient,
    ListAccountsCommand,
    ListRootsCommand,
    ListOrganizationalUnitsForParentCommand,
    ListAccountsForParentCommand,
    ListTagsForResourceCommand,
    DescribeOrganizationCommand,
  } = await getOrganizationsModule();

  const config = profile === 'default' ? {} : { profile };
  const client = new OrganizationsClient(config);

  // Get org ID
  const orgResp = await client.send(new DescribeOrganizationCommand({}));
  const orgId = orgResp.Organization?.Id ?? 'unknown';

  // 1. List all accounts
  onProgress?.({ phase: 'accounts', done: 0, total: 0 });
  const allAccounts: { id: string; name: string; email: string; status: string; joinedTimestamp: string }[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
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

  logger.info(`Discovered ${String(allAccounts.length)} accounts`);

  // 2. Build OU tree to resolve paths
  onProgress?.({ phase: 'ous', done: 0, total: 0 });
  const roots = await client.send(new ListRootsCommand({}));
  const rootId = roots.Roots?.[0]?.Id ?? '';

  const ouNodes: OUNode[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    let ouToken: string | undefined;
    do {
      const resp = await client.send(new ListOrganizationalUnitsForParentCommand({
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

  // Build a map of account → parent OU
  const accountParentMap = new Map<string, string>();
  const parentsToScan = [rootId, ...ouNodes.map(ou => ou.id)];
  for (const parentId of parentsToScan) {
    let acctToken: string | undefined;
    do {
      const resp = await client.send(new ListAccountsForParentCommand({
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

  // Resolve OU path for each account
  const ouMap = new Map(ouNodes.map(ou => [ou.id, ou]));
  function resolveOuPath(accountId: string): string {
    const parts: string[] = [];
    let current = accountParentMap.get(accountId);
    while (current !== undefined && current !== rootId) {
      const ou = ouMap.get(current);
      if (ou === undefined) break;
      parts.unshift(ou.name);
      current = ou.parentId;
    }
    return parts.join(' / ');
  }

  // 3. Fetch tags for each account
  const results: OrgAccount[] = [];
  for (let i = 0; i < allAccounts.length; i++) {
    const acct = allAccounts[i];
    if (acct === undefined) continue;
    onProgress?.({ phase: 'tags', done: i, total: allAccounts.length });

    const tags: Record<string, string> = {};
    try {
      let tagToken: string | undefined;
      do {
        const resp = await client.send(new ListTagsForResourceCommand({
          ResourceId: acct.id,
          NextToken: tagToken,
        }));
        for (const tag of resp.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) {
            tags[tag.Key] = tag.Value;
          }
        }
        tagToken = resp.NextToken;
      } while (tagToken !== undefined);
    } catch {
      logger.info(`Failed to fetch tags for ${acct.id}, skipping`);
    }

    results.push({
      ...acct,
      ouPath: resolveOuPath(acct.id),
      tags,
    });
  }
  onProgress?.({ phase: 'tags', done: allAccounts.length, total: allAccounts.length });

  logger.info(`Org sync complete: ${String(results.length)} accounts with tags`);

  return {
    accounts: results,
    orgId,
    syncedAt: new Date().toISOString(),
  };
}

export type { OrgAccount, OrgSyncProgress, OrgSyncResult };
