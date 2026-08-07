/** The FOCUS 1.2 columns the query layer reads (see `buildSource`). A
 *  candidate export missing any of these can't back the app.
 *
 *  Verified against a live AWS FOCUS 1.2 Data Export's `Manifest.json` column
 *  list. Two entries are AWS extension columns rather than FOCUS ones —
 *  `x_ServiceCode` and `x_Operation` — which is why a GCP export can never
 *  satisfy this list as delivered and has to be canonicalized locally
 *  (`gcp-canonicalize.ts`).
 *
 *  Lives in core because both sides of the contract need it: the desktop
 *  setup wizard validates a candidate AWS export's manifest against it, and
 *  the GCP canonicalizer enforces it on its own output. */
export const REQUIRED_FOCUS_COLUMNS = [
  'ChargePeriodStart', 'SubAccountId', 'SubAccountName',
  'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost',
  'ServiceName', 'x_ServiceCode', 'ServiceCategory', 'RegionId',
  'ResourceId', 'ChargeCategory', 'PricingCategory',
  'CommitmentDiscountStatus', 'ChargeDescription', 'ConsumedQuantity',
  'SkuMeter', 'Tags', 'x_Operation',
];
