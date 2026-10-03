import { isStringRecord } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { PROVIDER_ABSENT_DIMENSIONS } from './config-templates.js';
import type { TemplateProviderType } from './config-templates.js';
import { parseDimensionsSavePayload } from './handlers/dimensions-payload.js';

/** The dimensions.yaml the setup wizard writes, kept out of
 *  `handlers/setup.ts` so it is unit-testable without the main process — the
 *  same split `setup-gcp.ts` and `setup-manifest.ts` make. */

/** A tag the wizard collected. It arrives over IPC, so this shape is only
 *  what a well-behaved renderer sends: `buildWizardDimensions` validates it. */
export interface WizardTagChoice {
  readonly tagName: string;
  readonly label: string;
  readonly concept?: string | undefined;
}

const WIZARD_BUILT_IN_DIMENSIONS = [
  {
    name: 'account',
    label: 'Account',
    field: 'account_id',
    displayField: 'account_name',
    description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.',
    useOrgAccounts: true,
  },
  {
    name: 'region',
    label: 'Region',
    field: 'region',
    description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.',
  },
  {
    name: 'service',
    label: 'Service',
    field: 'service',
    description: 'Service the cost came from (FOCUS ServiceName, e.g. "Amazon Simple Storage Service") — the broadest "what cost me this?" view.',
  },
  {
    name: 'service_category',
    label: 'Service Category',
    field: 'service_category',
    description: 'Standardized FOCUS category (Compute, Storage, Databases). Good for exec summaries.',
  },
  {
    name: 'charge_category',
    label: 'Charge Category',
    field: 'charge_category',
    description: 'Usage vs Purchase vs Tax vs Credit vs Adjustment. Filter this to isolate real usage from billing events.',
  },
  {
    name: 'sku_meter',
    label: 'SKU Meter',
    field: 'sku_meter',
    description: 'Fine-grained usage meter like EUC1-Requests-Tier2. Use for instance/storage-tier breakdowns.',
  },
  {
    name: 'operation',
    label: 'Operation',
    field: 'operation',
    description: 'API operation billed for (RunInstances, GetObject). Useful for API-level cost attribution.',
    enabled: false,
  },
] as const;

/** The default built-in dimensions for `type` plus the wizard's tag choices,
 *  validated like every other renderer-supplied dimensions config that is
 *  about to be persisted: an entry the next load would reject (a quote in a
 *  tagName, a missing label, a non-array `tags`) must never replace a working
 *  dimensions.yaml.
 *
 *  GCP's FOCUS export has no ServiceCategory, and the canonicalizer only
 *  NULL-fills x_Operation and SkuMeter — so scaffolding them for a gcp
 *  provider produces dimensions that render one blank value for every row.
 *  `buildDimensionsTemplate('gcp')` already drops them, and the default-
 *  dimension merge (context.ts) skips re-adding them; all three read the same
 *  PROVIDER_ABSENT_DIMENSIONS map so the routes cannot disagree.
 *  @throws {ConfigValidationError} when the tags are not a valid config */
export function buildWizardDimensions(type: TemplateProviderType | undefined, tags: unknown): DimensionsConfig {
  const absentDims = type === 'gcp' ? PROVIDER_ABSENT_DIMENSIONS.gcp : PROVIDER_ABSENT_DIMENSIONS.aws;
  return parseDimensionsSavePayload({
    builtIn: WIZARD_BUILT_IN_DIMENSIONS.filter(d => !absentDims.has(d.name)),
    tags: wizardTagsPayload(tags),
  });
}

/** The wizard's tag choices reduced to the fields it collects, for the
 *  validator. Anything that is not an array of objects is passed through
 *  untouched so the validator rejects it with its own message. */
function wizardTagsPayload(tags: unknown): unknown {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) return tags;
  return Array.from(tags, (t: unknown) => {
    if (!isStringRecord(t)) return t;
    const concept = t['concept'];
    return { tagName: t['tagName'], label: t['label'], ...(concept === undefined ? {} : { concept }) };
  });
}
