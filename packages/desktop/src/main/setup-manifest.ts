import { isStringRecord, parseJsonObject } from '@costgoblin/core';

// The FOCUS 1.2 columns the query layer reads (see buildSource). A candidate
// export missing any of these can't back the app. Verified against a live
// AWS FOCUS 1.2 Data Export's Manifest.json column list.
export const REQUIRED_FOCUS_COLUMNS = [
  'ChargePeriodStart', 'SubAccountId', 'SubAccountName',
  'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost',
  'ServiceName', 'x_ServiceCode', 'ServiceCategory', 'RegionId',
  'ResourceId', 'ChargeCategory', 'PricingCategory',
  'CommitmentDiscountStatus', 'ChargeDescription', 'ConsumedQuantity',
  'SkuMeter', 'Tags', 'x_Operation',
];

export type DetectedReportType = 'daily' | 'hourly' | 'cost-optimization' | 'cur-legacy' | 'unknown';

export function classifyManifestColumns(columnNames: string[]): { detectedType: DetectedReportType; missingColumns: string[] } {
  if (columnNames.includes('recommendation_id') || columnNames.includes('estimated_monthly_savings')) {
    return { detectedType: 'cost-optimization', missingColumns: [] };
  }
  if (columnNames.includes('ChargePeriodStart')) {
    return { detectedType: 'daily', missingColumns: REQUIRED_FOCUS_COLUMNS.filter(c => !columnNames.includes(c)) };
  }
  // CUR 2.0 Data Exports deliver the same data/ + metadata/ folder pair as
  // FOCUS but their manifest lists line_item_*/bill_* columns. Surface that
  // explicitly so the wizard can say "wrong table" instead of a dead-end
  // "unknown" (sync would find nothing — CUR keys are invisible to it).
  if (columnNames.some(c => c.startsWith('line_item_') || c.startsWith('bill_'))) {
    return { detectedType: 'cur-legacy', missingColumns: [] };
  }
  return { detectedType: 'unknown', missingColumns: [] };
}

export function parseManifestColumnNames(body: string): string[] {
  const columns = parseJsonObject(body)?.['columns'];
  if (!Array.isArray(columns)) return [];
  return columns
    .filter(isStringRecord)
    .map(c => typeof c['name'] === 'string' ? c['name'] : '')
    .filter(n => n.length > 0);
}

/** Pick the columns manifest from a metadata/ listing. FOCUS exports ALSO
 *  deliver a *-Manifest-FOCUS.json sidecar with a different shape
 *  (Schema.ColumnDefinition), and it sorts FIRST ('-' < '.') — so
 *  "first .json" would parse zero columns and misclassify a valid FOCUS
 *  export as unknown. */
export function selectManifestKey(jsonKeys: readonly string[]): string | undefined {
  return jsonKeys.find(k => !k.endsWith('Manifest-FOCUS.json')) ?? jsonKeys[0];
}
