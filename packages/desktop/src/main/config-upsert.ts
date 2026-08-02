import { isStringRecord, parseProviderName } from '@costgoblin/core';

/** Pure YAML-object transforms behind the two config-writing IPC handlers
 *  (`setup:write-config`, `config:update-aws-profile`). They operate on the
 *  parsed YAML value and return a new value to stringify — no I/O — so the
 *  upsert/targeting rules are unit-testable without touching the filesystem. */

/** The subset of the setup wizard's payload that shapes the provider entry
 *  written to `costgoblin.yaml`. */
export interface WizardProviderConfig {
  readonly providerName: string;
  readonly profile: string;
  readonly dailyBucket: string;
  readonly retentionDays?: number | undefined;
  readonly hourlyBucket?: string | undefined;
  readonly costOptBucket?: string | undefined;
}

function providerEntryName(entry: unknown): string | undefined {
  if (!isStringRecord(entry)) return undefined;
  const name = entry['name'];
  return typeof name === 'string' ? name : undefined;
}

/** Upsert the wizard's provider into the parsed config by exact name match:
 *  replace the matching entry in place (position preserved), append when no
 *  entry matches. Every other provider entry is preserved verbatim, as are
 *  unknown top-level YAML keys. The targeted provider's existing sync
 *  sub-fields (e.g. an `hourly` block the wizard run didn't mention) are
 *  merged into the rewritten entry; the entry itself is rebuilt in the
 *  flattened `credentialsProfile` shape, which also drops a legacy nested
 *  `credentials` key. Throws `ProviderNameError` (UI-friendly message) on an
 *  invalid provider name. */
export function upsertWizardProvider(
  existing: Readonly<Record<string, unknown>>,
  wizard: WizardProviderConfig,
): Record<string, unknown> {
  parseProviderName(wizard.providerName);

  const providersValue: unknown = existing['providers'];
  const providersRaw: readonly unknown[] = Array.isArray(providersValue) ? providersValue : [];
  const targetIndex = providersRaw.findIndex(p => providerEntryName(p) === wizard.providerName);
  const target: unknown = targetIndex === -1 ? undefined : providersRaw[targetIndex];
  const rawSync: unknown = isStringRecord(target) ? target['sync'] : undefined;
  const existingSync: Readonly<Record<string, unknown>> = isStringRecord(rawSync) ? rawSync : {};

  const sync: Record<string, unknown> = { ...existingSync, intervalMinutes: 60 };

  if (wizard.dailyBucket.length > 0) {
    sync['daily'] = { bucket: wizard.dailyBucket, retentionDays: wizard.retentionDays ?? 365 };
  }
  if (wizard.hourlyBucket !== undefined && wizard.hourlyBucket.length > 0) {
    sync['hourly'] = { bucket: wizard.hourlyBucket, retentionDays: 30 };
  }
  if (wizard.costOptBucket !== undefined && wizard.costOptBucket.length > 0) {
    sync['costOptimization'] = { bucket: wizard.costOptBucket, retentionDays: 30 };
  }

  const entry: Record<string, unknown> = {
    name: wizard.providerName,
    type: 'aws',
    credentialsProfile: wizard.profile,
    sync,
  };

  const providers: readonly unknown[] = targetIndex === -1
    ? [...providersRaw, entry]
    : providersRaw.map((p, i) => (i === targetIndex ? entry : p));

  return {
    ...existing,
    providers,
    defaults: typeof existing['defaults'] === 'object' && existing['defaults'] !== null
      ? existing['defaults']
      : { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
  };
}

/** Rewrite ONLY the targeted provider's `credentialsProfile` (default: the
 *  first provider; otherwise exact-name lookup), leaving every other YAML
 *  field and provider entry untouched. Drops the legacy nested `credentials`
 *  key on the targeted entry only, so the file converges on the flattened
 *  shape. Throws on a missing providers list, an unknown provider name, or a
 *  non-object targeted entry. */
export function swapProviderCredentialsProfile(
  parsed: Readonly<Record<string, unknown>>,
  profile: string,
  providerName?: string,
): Record<string, unknown> {
  const providersRaw: unknown = parsed['providers'];
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) throw new Error('No providers configured');
  const providers: readonly unknown[] = providersRaw;
  const targetIndex = providerName === undefined
    ? 0
    : providers.findIndex(p => providerEntryName(p) === providerName);
  if (targetIndex === -1) throw new Error(`Unknown provider "${providerName ?? ''}"`);
  const target: unknown = providers[targetIndex];
  if (!isStringRecord(target)) throw new Error('Provider entry is not an object');
  const rest = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'credentials'));
  const entry: Record<string, unknown> = { ...rest, credentialsProfile: profile };
  return { ...parsed, providers: providers.map((p, i) => (i === targetIndex ? entry : p)) };
}
