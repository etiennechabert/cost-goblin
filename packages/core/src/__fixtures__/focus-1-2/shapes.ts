/** What each provider's *native* FOCUS 1.2 export actually delivers.
 *
 *  FOCUS pins a common column set, but a provider's export is not the
 *  specification: every provider omits conditional columns it has no source
 *  for and adds its own `x_` extensions. These lists are the reference for
 *  that difference — they are what the samples in `samples/*.csv` carry, and
 *  what the per-provider tests assert against.
 *
 *  Sources (all re-checked 2026-08-04):
 *    - FOCUS 1.2 requirement levels: the FinOps Foundation validator's
 *      machine-readable rule model `model-1.2.0.1.json` (every rule whose
 *      Requirement.CheckFunction is `ColumnPresent`), not prose.
 *    - AWS: the `FOCUS_1_2_AWS` Data Export table — the full FOCUS 1.2
 *      column set plus exactly three AWS columns (`x_Discounts`,
 *      `x_Operation`, `x_ServiceCode`), per the AWS table dictionary.
 *    - Azure: `FocusCost_1.2-preview.json` from microsoft/finops-toolkit
 *      (`src/open-data/dataset-metadata/`) — 106 columns, of which the `x_`
 *      extensions are trimmed here to the ones that carry signal (see the
 *      README).
 *    - GCP: the published FOCUS BigQuery export schema, cross-checked against
 *      a live export's column list. GCP's is the interesting one: it omits
 *      three *unconditionally* mandatory columns and carries tags as repeated
 *      records, not `Tags`. The samples carry the columns that export
 *      delivers today; its Preview status means the set can still grow. */

export const SAMPLE_PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type SampleProvider = (typeof SAMPLE_PROVIDERS)[number];

/** The 21 columns FOCUS 1.2 requires of every conformant dataset, with no
 *  applicability condition attached. A provider missing one of these is
 *  non-conformant, not merely incomplete. */
export const FOCUS_1_2_MANDATORY_COLUMNS: readonly string[] = [
  'BilledCost',
  'BillingAccountId',
  'BillingAccountName',
  'BillingCurrency',
  'BillingPeriodEnd',
  'BillingPeriodStart',
  'ChargeCategory',
  'ChargeClass',
  'ChargeDescription',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'ContractedCost',
  'EffectiveCost',
  'InvoiceIssuerName',
  'ListCost',
  'PricingQuantity',
  'PricingUnit',
  'ProviderName',
  'PublisherName',
  'ServiceCategory',
  'ServiceName',
] as const;

/** Columns FOCUS 1.2 requires *when the provider supports the concept* —
 *  a provider without commitment discounts legitimately omits the
 *  `CommitmentDiscount*` family, and one that never exposes resources omits
 *  `ResourceId`. Absence here is a capability statement, not a defect. */
export const FOCUS_1_2_CONDITIONAL_COLUMNS: readonly string[] = [
  'BillingAccountType',
  'CapacityReservationId',
  'CapacityReservationStatus',
  'CommitmentDiscountCategory',
  'CommitmentDiscountId',
  'CommitmentDiscountName',
  'CommitmentDiscountQuantity',
  'CommitmentDiscountStatus',
  'CommitmentDiscountType',
  'CommitmentDiscountUnit',
  'ConsumedQuantity',
  'ConsumedUnit',
  'ContractedUnitPrice',
  'ListUnitPrice',
  'PricingCategory',
  'PricingCurrency',
  'PricingCurrencyContractedUnitPrice',
  'PricingCurrencyEffectiveCost',
  'PricingCurrencyListUnitPrice',
  'RegionId',
  'RegionName',
  'ResourceId',
  'ResourceName',
  'ResourceType',
  'SkuId',
  'SkuMeter',
  'SkuPriceDetails',
  'SkuPriceId',
  'SubAccountId',
  'SubAccountName',
  'SubAccountType',
  'Tags',
] as const;

/** Columns FOCUS 1.2 marks RECOMMENDED — optional, but real exports carry
 *  them, so they belong in the known-name set. */
export const FOCUS_1_2_RECOMMENDED_COLUMNS: readonly string[] = [
  'AvailabilityZone',
  'ChargeFrequency',
  'InvoiceId',
  'ServiceSubcategory',
] as const;

/** Every raw column `buildSource` reads off a Parquet file. This is the
 *  contract an ingested export must satisfy — DuckDB's `union_by_name` fills
 *  a column missing from *some* file in a glob, but a column missing from
 *  *every* file is still a binder error, so each one has to be physically
 *  present in what we write to disk.
 *
 *  Two of them (`x_ServiceCode`, `x_Operation`) are AWS extension columns
 *  that no other provider emits — which is precisely why a non-AWS provider
 *  needs a canonicalization step before its export can be queried. */
export const QUERY_CONTRACT_COLUMNS: readonly string[] = [
  'ChargePeriodStart',
  'SubAccountId',
  'SubAccountName',
  'RegionId',
  'ServiceName',
  'ServiceCategory',
  'ChargeDescription',
  'ChargeCategory',
  'PricingCategory',
  'CommitmentDiscountStatus',
  'ConsumedQuantity',
  'ResourceId',
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'SkuMeter',
  'Tags',
  'x_ServiceCode',
  'x_Operation',
] as const;

/** The FOCUS 1.2 standard columns AWS's `FOCUS_1_2_AWS` export delivers.
 *  AWS ships the specification's column set in full. */
const AWS_FOCUS_COLUMNS: readonly string[] = [
  'BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingAccountType',
  'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart', 'ChargeCategory',
  'ChargeClass', 'ChargeDescription', 'ChargeFrequency', 'ChargePeriodEnd',
  'ChargePeriodStart', 'CommitmentDiscountCategory', 'CommitmentDiscountId',
  'CommitmentDiscountName', 'CommitmentDiscountQuantity', 'CommitmentDiscountStatus',
  'CommitmentDiscountType', 'CommitmentDiscountUnit', 'ConsumedQuantity',
  'ConsumedUnit', 'ContractedCost', 'ContractedUnitPrice', 'EffectiveCost',
  'InvoiceId', 'InvoiceIssuerName', 'ListCost', 'ListUnitPrice', 'PricingCategory',
  'PricingQuantity', 'PricingUnit', 'ProviderName', 'PublisherName', 'RegionId',
  'RegionName', 'ResourceId', 'ResourceName', 'ResourceType', 'ServiceCategory',
  'ServiceName', 'ServiceSubcategory', 'SkuId', 'SkuMeter', 'SkuPriceId',
  'SubAccountId', 'SubAccountName', 'SubAccountType', 'Tags',
] as const;

/** The FOCUS 1.2 standard columns Microsoft Cost Management delivers. Azure
 *  omits the capacity-reservation family and the pricing-currency triplet
 *  that GCP carries; everything else in the spec is present. */
const AZURE_FOCUS_COLUMNS: readonly string[] = [
  'BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingAccountType',
  'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart', 'CapacityReservationId',
  'CapacityReservationStatus', 'ChargeCategory', 'ChargeClass', 'ChargeDescription',
  'ChargeFrequency', 'ChargePeriodEnd', 'ChargePeriodStart', 'CommitmentDiscountCategory',
  'CommitmentDiscountId', 'CommitmentDiscountName', 'CommitmentDiscountQuantity',
  'CommitmentDiscountStatus', 'CommitmentDiscountType', 'CommitmentDiscountUnit',
  'ConsumedQuantity', 'ConsumedUnit', 'ContractedCost', 'ContractedUnitPrice',
  'EffectiveCost', 'InvoiceId', 'InvoiceIssuerName', 'ListCost', 'ListUnitPrice',
  'PricingCategory', 'PricingCurrency', 'PricingQuantity', 'PricingUnit',
  'ProviderName', 'PublisherName', 'RegionId', 'RegionName', 'ResourceId',
  'ResourceName', 'ResourceType', 'ServiceCategory', 'ServiceName',
  'ServiceSubcategory', 'SkuId', 'SkuMeter', 'SkuPriceDetails', 'SkuPriceId',
  'SubAccountId', 'SubAccountName', 'SubAccountType', 'Tags',
] as const;

/** The FOCUS 1.2 standard columns the GCP BigQuery export delivers.
 *
 *  Note what is NOT here: `BillingAccountName`, `InvoiceIssuerName` and
 *  `ServiceCategory` are unconditionally mandatory in FOCUS 1.2 and GCP
 *  still omits all three; `Tags`, `ResourceType`, `SkuMeter`, `SubAccountType`
 *  and the whole `CommitmentDiscount*` family are absent too — CUDs surface
 *  through `x_Credits` instead. */
const GCP_FOCUS_COLUMNS: readonly string[] = [
  'AvailabilityZone', 'BilledCost', 'BillingAccountId', 'BillingAccountType',
  'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart', 'ChargeCategory',
  'ChargeClass', 'ChargeDescription', 'ChargePeriodEnd', 'ChargePeriodStart',
  'ConsumedQuantity', 'ConsumedUnit', 'ContractedCost', 'ContractedUnitPrice',
  'EffectiveCost', 'ListCost', 'ListUnitPrice', 'PricingCategory',
  'PricingCurrency', 'PricingCurrencyContractedUnitPrice',
  'PricingCurrencyEffectiveCost', 'PricingCurrencyListUnitPrice',
  'PricingQuantity', 'PricingUnit', 'ProviderName', 'PublisherName', 'RegionId',
  'RegionName', 'ResourceId', 'ResourceName', 'ServiceName', 'SkuId',
  'SkuPriceId', 'SubAccountId', 'SubAccountName',
] as const;

/** Provider extension columns each sample carries.
 *
 *  AWS's three are the complete set. GCP's are complete too. Azure's real
 *  export has ~50 `x_` columns; the sample keeps the ones a cost tool would
 *  actually read (resource group, cost centre, meter breakdown, USD
 *  normalization) — see the README for the trim. */
const EXTENSION_COLUMNS: Record<SampleProvider, readonly string[]> = {
  aws: ['x_Discounts', 'x_Operation', 'x_ServiceCode'],
  azure: [
    'x_AccountName', 'x_BilledCostInUsd', 'x_BillingProfileName', 'x_CostCenter',
    'x_EffectiveCostInUsd', 'x_InvoiceSectionName', 'x_PublisherCategory',
    'x_ResourceGroupName', 'x_SkuMeterCategory', 'x_SkuMeterName',
    'x_SkuServiceFamily',
  ],
  gcp: [
    'x_ConsumptionModelId', 'x_CostType', 'x_Credits', 'x_CurrencyConversionRate',
    'x_ExportTime', 'x_Labels', 'x_Location', 'x_Project', 'x_ProjectLabels',
    'x_ServiceId', 'x_SubscriptionInstanceId', 'x_SystemLabels', 'x_Tags',
  ],
};

/** Every column a provider's sample CSV carries, in file order: the
 *  provider's FOCUS 1.2 columns followed by its `x_` extensions. */
export const NATIVE_COLUMNS: Record<SampleProvider, readonly string[]> = {
  aws: [...AWS_FOCUS_COLUMNS, ...EXTENSION_COLUMNS.aws],
  azure: [...AZURE_FOCUS_COLUMNS, ...EXTENSION_COLUMNS.azure],
  gcp: [...GCP_FOCUS_COLUMNS, ...EXTENSION_COLUMNS.gcp],
};

/** Columns of `QUERY_CONTRACT_COLUMNS` a provider's native export does not
 *  carry — everything a provider adapter has to synthesize, map or default
 *  before the query layer can read the data. Empty for AWS. */
export function contractGap(provider: SampleProvider): readonly string[] {
  const native = new Set(NATIVE_COLUMNS[provider]);
  return QUERY_CONTRACT_COLUMNS.filter(col => !native.has(col));
}

/** Columns a provider declares that are neither a FOCUS 1.2 column nor an
 *  `x_` extension — i.e. a typo or an invented name. FOCUS reserves the `x_`
 *  prefix for provider extensions, so anything else has to appear in one of
 *  the specification's own lists. */
export function unknownColumns(provider: SampleProvider): readonly string[] {
  const known = new Set([
    ...FOCUS_1_2_MANDATORY_COLUMNS,
    ...FOCUS_1_2_CONDITIONAL_COLUMNS,
    ...FOCUS_1_2_RECOMMENDED_COLUMNS,
  ]);
  return NATIVE_COLUMNS[provider].filter(col => !col.startsWith('x_') && !known.has(col));
}

/** Unconditionally-mandatory FOCUS 1.2 columns a provider's export omits.
 *  Non-empty here means the provider is not FOCUS 1.2 conformant. */
export function mandatoryGap(provider: SampleProvider): readonly string[] {
  const native = new Set(NATIVE_COLUMNS[provider]);
  return FOCUS_1_2_MANDATORY_COLUMNS.filter(col => !native.has(col));
}
