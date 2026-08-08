import { isStringRecord, parseProviderName } from '@costgoblin/core';

/** Pure YAML-object transforms behind the two config-writing IPC handlers
 *  (`setup:write-config`, `config:update-aws-profile`). They operate on the
 *  parsed YAML value and return a new value to stringify — no I/O — so the
 *  upsert/targeting rules are unit-testable without touching the filesystem. */

/** The subset of the setup wizard's payload that shapes the provider entry
 *  written to `costgoblin.yaml`. `type` defaults to `'aws'` so every
 *  pre-#517 call site keeps its meaning; `profile` (AWS) and `keyFile`
 *  (GCP) are each read only by their own arm. */
export interface WizardProviderConfig {
  readonly providerName: string;
  readonly type?: 'aws' | 'gcp' | undefined;
  readonly profile: string;
  readonly keyFile?: string | undefined;
  readonly dailyBucket: string;
  /** Retention for the DAILY tier (the wizard's picker in daily mode). */
  readonly retentionDays?: number | undefined;
  /** Retention for the HOURLY tier (the wizard's picker in hourly-only mode).
   *  Previously the hourly tier was hardcoded to 30 days regardless of what the
   *  picker showed, so a user's choice was silently discarded and any
   *  hand-configured hourly retention was reset on every re-run. */
  readonly hourlyRetentionDays?: number | undefined;
  readonly hourlyBucket?: string | undefined;
  readonly costOptBucket?: string | undefined;
}

function providerEntryName(entry: unknown): string | undefined {
  if (!isStringRecord(entry)) return undefined;
  const name = entry['name'];
  return typeof name === 'string' ? name : undefined;
}

/** The retentionDays already configured for a tier on the entry being
 *  replaced, if any — so a wizard re-run that doesn't re-pick a tier's
 *  retention preserves it instead of resetting it to the default. */
function existingTierRetention(existingSync: Readonly<Record<string, unknown>>, tier: string): number | undefined {
  const t: unknown = existingSync[tier];
  if (isStringRecord(t) && typeof t['retentionDays'] === 'number') return t['retentionDays'];
  return undefined;
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
  const type = wizard.type ?? 'aws';

  // Defence in depth behind the UI gate. `type` defaults to 'aws' because the
  // wizard's payload has never carried one, so an upsert that lands on an
  // existing gcp entry would silently rewrite it as an AWS provider — losing
  // the GCP source rather than failing. `swapProviderCredentialsProfile`
  // already refuses the same way. Guards BOTH directions. Guarding only aws-onto-gcp left the mirror image open:
  // a `type: 'gcp'` payload landing on an existing AWS entry replaced it
  // wholesale, dropping `credentialsProfile` and the inherited sync tiers, and
  // the AWS billing source vanished with no error.
  const rawTargetType: unknown = isStringRecord(target) ? target['type'] : undefined;
  const targetType = typeof rawTargetType === 'string' ? rawTargetType : undefined;
  if (targetType !== undefined && targetType !== type) {
    throw new Error(
      `Provider "${wizard.providerName}" is a ${targetType.toUpperCase()} provider — refusing to rewrite it as ${type.toUpperCase()}. Edit costgoblin.yaml to change a provider's type.`,
    );
  }

  // `validateGcpSync` rejects `costOptimization` outright. Inheriting the
  // previous entry's sync block — which is right for AWS, where a wizard run
  // that didn't mention `hourly` must not drop it — would carry a stale
  // `costOptimization:` onto a gcp entry and make the whole config fail to
  // load on the next launch. So gcp starts from an empty sync.
  const sync: Record<string, unknown> = type === 'gcp'
    ? { intervalMinutes: 60 }
    : { ...existingSync, intervalMinutes: 60 };

  if (wizard.dailyBucket.length > 0) {
    const retentionDays = wizard.retentionDays ?? existingTierRetention(existingSync, 'daily') ?? 365;
    sync['daily'] = { bucket: wizard.dailyBucket, retentionDays };
  }
  // Both arms carry an hourly tier: GCP's FOCUS export is delivered hourly and
  // the exporter publishes that grain to its own folder. Honour the wizard's
  // picked hourly retention (hourly-only mode); otherwise preserve whatever the
  // entry already had rather than resetting it to the default.
  if (wizard.hourlyBucket !== undefined && wizard.hourlyBucket.length > 0) {
    const retentionDays = wizard.hourlyRetentionDays ?? existingTierRetention(existingSync, 'hourly') ?? 30;
    sync['hourly'] = { bucket: wizard.hourlyBucket, retentionDays };
  }
  if (type === 'aws' && wizard.costOptBucket !== undefined && wizard.costOptBucket.length > 0) {
    const retentionDays = existingTierRetention(existingSync, 'costOptimization') ?? 30;
    sync['costOptimization'] = { bucket: wizard.costOptBucket, retentionDays };
  }

  const entry: Record<string, unknown> = type === 'gcp'
    ? {
        name: wizard.providerName,
        type: 'gcp',
        // Omitted rather than null when blank: absent means Application
        // Default Credentials, which is the documented default.
        // Carried from the entry being replaced when the payload has none,
        // exactly like `impersonateServiceAccount` below. The wizard never
        // sends a keyFile, so without this a re-run silently deleted a
        // hand-written one and the sync fell back to ADC — 403ing on a bucket
        // granted only to the service account.
        ...(wizard.keyFile !== undefined && wizard.keyFile.length > 0
          ? { keyFile: wizard.keyFile }
          : isStringRecord(target) && typeof target['keyFile'] === 'string'
            ? { keyFile: target['keyFile'] }
            : {}),
        // Carried from the entry being replaced. `WizardProviderConfig` has no
        // field for it, so building the entry from the payload alone silently
        // deleted it — after which the download half ran as the signed-in user
        // and 403'd on a bucket granted only to the service account.
        ...(isStringRecord(target) && typeof target['impersonateServiceAccount'] === 'string'
          ? { impersonateServiceAccount: target['impersonateServiceAccount'] }
          : {}),
        sync,
      }
    : {
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
      : { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  };
}

/** Rewrite ONLY the targeted provider's `credentialsProfile` (default: the
 *  first provider; otherwise exact-name lookup), leaving every other YAML
 *  field and provider entry untouched. Drops the legacy nested `credentials`
 *  key on the targeted entry only, so the file converges on the flattened
 *  shape. Throws on a missing providers list, an unknown provider name, a
 *  non-object targeted entry, or a non-AWS target — `credentialsProfile` is
 *  an AWS-arm field, and writing one onto a `gcp` entry would produce a
 *  config the validator accepts but the sync layer ignores. */
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
  if (target['type'] === 'gcp') {
    throw new Error(`Provider "${providerEntryName(target) ?? ''}" is a GCP provider — it authenticates with Application Default Credentials or a service-account key, not an AWS profile`);
  }
  const rest = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'credentials'));
  const entry: Record<string, unknown> = { ...rest, credentialsProfile: profile };
  return { ...parsed, providers: providers.map((p, i) => (i === targetIndex ? entry : p)) };
}

/** Remove the provider entry with the given exact name. Throws when the
 *  name doesn't match any entry (the UI should never offer a stale name)
 *  or when it matches the LAST remaining provider — an empty providers list
 *  is legal YAML but almost certainly a mistake from the removal flow; the
 *  user can hand-edit the file for that. Everything else is preserved
 *  verbatim. The provider's on-disk data tree is deliberately NOT touched
 *  here — the caller decides whether to orphan or delete it. */
export function removeProviderEntry(
  existing: Readonly<Record<string, unknown>>,
  providerName: string,
): Record<string, unknown> {
  const providersValue: unknown = existing['providers'];
  const providers: readonly unknown[] = Array.isArray(providersValue) ? providersValue : [];
  const index = providers.findIndex(entry => providerEntryName(entry) === providerName);
  if (index === -1) {
    throw new Error(`Unknown provider "${providerName}"`);
  }
  if (providers.length === 1) {
    throw new Error('Cannot remove the last provider — the app needs at least one billing source.');
  }
  return { ...existing, providers: providers.filter((_, i) => i !== index) };
}
