import { logger } from '@costgoblin/core';

interface RegionNameMap {
  /** ISO 8601 timestamp this snapshot was fetched. */
  syncedAt: string;
  /** AWS region code → AWS-published long name (e.g. "Europe (Frankfurt)"). */
  regions: Record<string, string>;
}

async function getSsmModule(): Promise<typeof import('@aws-sdk/client-ssm')> {
  return import('@aws-sdk/client-ssm');
}

/** Pulls the AWS-published friendly region names from SSM Parameter Store.
 *  These live under /aws/service/global-infrastructure/regions/<code>/longName
 *  as public parameters — same source the AWS CLI itself uses. We list the
 *  region codes first, then batch the longName lookups (10 per call, the SSM
 *  GetParameters limit). Missing or failed regions fall through to no entry,
 *  which the consumer translates back to the raw code. */
export async function syncRegionNames(profile: string): Promise<RegionNameMap> {
  const { SSMClient, GetParametersByPathCommand, GetParametersCommand } = await getSsmModule();

  // SSM is regional but the global-infrastructure namespace is mirrored to
  // every region. We deliberately don't hardcode a region here — many SCPs
  // explicitly deny SSM in regions the org doesn't use (commonly us-east-1
  // for non-US-based shops), and the AWS SDK's default region resolution
  // (env vars → profile config → IMDS) lands on a region the user already
  // proved they have access to.
  const config = profile === 'default' ? {} : { profile };
  const client = new SSMClient(config);

  // 1. List all region codes.
  const codes: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new GetParametersByPathCommand({
      Path: '/aws/service/global-infrastructure/regions',
      NextToken: nextToken,
    }));
    for (const p of resp.Parameters ?? []) {
      // Parameter names look like /aws/service/global-infrastructure/regions/eu-central-1
      const name = p.Name ?? '';
      const last = name.slice(name.lastIndexOf('/') + 1);
      if (last.length > 0) codes.push(last);
    }
    nextToken = resp.NextToken;
  } while (nextToken !== undefined);

  logger.info(`SSM region sync: discovered ${String(codes.length)} regions`);

  // 2. Batch the longName lookups (GetParameters caps at 10 names per call).
  const regions: Record<string, string> = {};
  for (let i = 0; i < codes.length; i += 10) {
    const batch = codes.slice(i, i + 10);
    const names = batch.map(c => `/aws/service/global-infrastructure/regions/${c}/longName`);
    try {
      const resp = await client.send(new GetParametersCommand({ Names: names }));
      for (const p of resp.Parameters ?? []) {
        const name = p.Name ?? '';
        const value = p.Value ?? '';
        // Recover the code from the parameter name's path.
        const parts = name.split('/');
        const code = parts[parts.length - 2] ?? '';
        if (code.length > 0 && value.length > 0) regions[code] = value;
      }
    } catch (err: unknown) {
      logger.info(`SSM region sync: longName batch ${String(i)} failed: ${String(err)}`);
    }
  }

  logger.info(`SSM region sync: resolved ${String(Object.keys(regions).length)} long names`);

  return {
    syncedAt: new Date().toISOString(),
    regions,
  };
}

export type { RegionNameMap };
