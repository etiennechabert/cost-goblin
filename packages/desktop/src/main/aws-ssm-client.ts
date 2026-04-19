import { logger } from '@costgoblin/core';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';

/** Per-region metadata AWS publishes under global-infrastructure. We pull
 *  three fields per region — longName for display, country + continent for
 *  higher-level cost groupings (data residency, geo chargeback). */
interface RegionInfo {
  longName: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "DE", "US"). */
  country: string;
  /** AWS geographic region bucket (e.g. "EU", "NA", "AS"). */
  continent: string;
}

interface RegionNameMap {
  /** ISO 8601 timestamp this snapshot was fetched. */
  syncedAt: string;
  regions: Record<string, RegionInfo>;
}

async function getSsmModule(): Promise<typeof import('@aws-sdk/client-ssm')> {
  return import('@aws-sdk/client-ssm');
}

/** Reads the AWS region configured for a profile in ~/.aws/config. Falls back
 *  to the profile's linked sso-session `sso_region` since SSO-only profiles
 *  often omit `region`. We must pass this explicitly to the SDK — env vars
 *  like AWS_REGION would otherwise take precedence over the profile's own
 *  config, which bites users whose SCPs deny specific regions (e.g. us-east-1). */
async function resolveProfileRegion(profile: string): Promise<string> {
  const { configFile } = await loadSharedConfigFiles();
  const section = configFile[profile] ?? {};
  const region = section['region'];
  if (typeof region === 'string' && region.length > 0) return region;
  const ssoSession = section['sso_session'];
  if (typeof ssoSession === 'string' && ssoSession.length > 0) {
    const sessionSection = configFile[`sso-session.${ssoSession}`] ?? {};
    const ssoRegion = sessionSection['sso_region'];
    if (typeof ssoRegion === 'string' && ssoRegion.length > 0) return ssoRegion;
  }
  throw new Error(`Profile "${profile}" has no region configured in ~/.aws/config. Add 'region = <aws-region>' to the profile.`);
}

const FIELDS = ['longName', 'geolocationCountry', 'geolocationRegion'] as const;

/** Pulls AWS-published region metadata from SSM Parameter Store.
 *  Parameters live under /aws/service/global-infrastructure/regions/<code>/<field>
 *  as public params — same source the AWS CLI uses. We list the region codes
 *  first, then batch the per-field lookups (10 names per GetParameters call). */
export async function syncRegionNames(profile: string): Promise<RegionNameMap> {
  const { SSMClient, GetParametersByPathCommand, GetParametersCommand } = await getSsmModule();

  // SSM is regional but the global-infrastructure namespace is mirrored to
  // every region. We pin the region to the one configured in the user's
  // profile — SDK env-var precedence (AWS_REGION > profile config) would
  // otherwise send calls to a region the org's SCP denies (commonly us-east-1).
  const region = await resolveProfileRegion(profile);
  const config = profile === 'default' ? { region } : { region, profile };
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
      const name = p.Name ?? '';
      const last = name.slice(name.lastIndexOf('/') + 1);
      if (last.length > 0) codes.push(last);
    }
    nextToken = resp.NextToken;
  } while (nextToken !== undefined);

  logger.info(`SSM region sync: discovered ${String(codes.length)} regions`);

  // 2. Build the full list of (code, field) lookups and batch 10 at a time.
  //    A batch may span multiple regions — we recover the region+field from
  //    each returned Name rather than tracking it positionally.
  const partial = new Map<string, Partial<RegionInfo>>();
  const allNames: string[] = [];
  for (const c of codes) {
    for (const f of FIELDS) {
      allNames.push(`/aws/service/global-infrastructure/regions/${c}/${f}`);
    }
  }
  for (let i = 0; i < allNames.length; i += 10) {
    const batch = allNames.slice(i, i + 10);
    try {
      const resp = await client.send(new GetParametersCommand({ Names: batch }));
      for (const p of resp.Parameters ?? []) {
        const name = p.Name ?? '';
        const value = p.Value ?? '';
        if (value.length === 0) continue;
        // /aws/service/global-infrastructure/regions/<code>/<field>
        const parts = name.split('/');
        const code = parts[parts.length - 2] ?? '';
        const field = parts[parts.length - 1] ?? '';
        if (code.length === 0) continue;
        const entry = partial.get(code) ?? {};
        if (field === 'longName') entry.longName = value;
        else if (field === 'geolocationCountry') entry.country = value;
        else if (field === 'geolocationRegion') entry.continent = value;
        partial.set(code, entry);
      }
    } catch (err: unknown) {
      logger.info(`SSM region sync: batch ${String(i)} failed: ${String(err)}`);
    }
  }

  // Only emit regions that got at least a longName — country/continent default
  // to empty strings so the consumer can still treat them as present-but-unknown.
  const regions: Record<string, RegionInfo> = {};
  for (const [code, entry] of partial) {
    if (typeof entry.longName !== 'string' || entry.longName.length === 0) continue;
    regions[code] = {
      longName: entry.longName,
      country: entry.country ?? '',
      continent: entry.continent ?? '',
    };
  }

  logger.info(`SSM region sync: resolved ${String(Object.keys(regions).length)} regions with metadata`);

  return {
    syncedAt: new Date().toISOString(),
    regions,
  };
}

export type { RegionNameMap, RegionInfo };
