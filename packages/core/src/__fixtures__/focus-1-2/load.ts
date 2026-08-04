/** Turns a committed sample CSV into Parquet with the provider's *real*
 *  physical types, then (optionally) into the contract shape the query layer
 *  reads.
 *
 *  The physical types are the point. A CSV cannot express that AWS delivers
 *  `Tags` as a Parquet MAP, Azure as a JSON document, and GCP not at all —
 *  it delivers `ARRAY<STRUCT<Key, Value>>` under `x_Labels`. Tag extraction
 *  in `buildSource` is `element_at(Tags, 'key')[1]`, which only compiles
 *  against a MAP, so a loader that flattened everything to VARCHAR would
 *  make the samples pass tests that real data fails. */

import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVE_COLUMNS } from './shapes.js';
import type { SampleProvider } from './shapes.js';
import { SAMPLE_MONTH } from './samples.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'samples');

/** Minimal surface of a DuckDB connection this module needs. */
interface Runner {
  run(sql: string): Promise<unknown>;
}

const GCP_KEY_VALUE = 'STRUCT(Key VARCHAR, Value VARCHAR)[]';

/** GCP's tag sources concatenated strongest-first: tag bindings, then
 *  resource labels, then project labels. Each is a differently-shaped
 *  repeated record, so they are normalized to (Key, Value) before merging. */
const GCP_TAG_SOURCES = `list_concat(list_concat(
  list_transform(x_Tags,          t -> struct_pack("Key" := t."Key", "Value" := t."Value")),
  list_transform(x_Labels,        t -> struct_pack("Key" := t."Key", "Value" := t."Value"))),
  list_transform(x_ProjectLabels, t -> struct_pack("Key" := t."Key", "Value" := t."Value")))`;

/** Columns whose physical type is not VARCHAR, per provider. Anything absent
 *  from these maps stays VARCHAR — which is what the providers do too. */
const PHYSICAL_TYPES: Record<SampleProvider, Readonly<Record<string, string>>> = {
  aws: {
    BilledCost: 'DOUBLE', ContractedCost: 'DOUBLE', EffectiveCost: 'DOUBLE', ListCost: 'DOUBLE',
    ContractedUnitPrice: 'DOUBLE', ListUnitPrice: 'DOUBLE',
    ConsumedQuantity: 'DOUBLE', PricingQuantity: 'DOUBLE', CommitmentDiscountQuantity: 'DOUBLE',
    BillingPeriodStart: 'TIMESTAMP', BillingPeriodEnd: 'TIMESTAMP',
    ChargePeriodStart: 'TIMESTAMP', ChargePeriodEnd: 'TIMESTAMP',
    Tags: 'MAP(VARCHAR, VARCHAR)',
    x_Discounts: 'MAP(VARCHAR, DOUBLE)',
  },
  azure: {
    // Microsoft's dataset metadata types the cost columns as Decimal.
    BilledCost: 'DECIMAL(29,10)', ContractedCost: 'DECIMAL(29,10)',
    EffectiveCost: 'DECIMAL(29,10)', ListCost: 'DECIMAL(29,10)',
    ContractedUnitPrice: 'DECIMAL(29,10)', ListUnitPrice: 'DECIMAL(29,10)',
    ConsumedQuantity: 'DECIMAL(29,10)', PricingQuantity: 'DECIMAL(29,10)',
    CommitmentDiscountQuantity: 'DECIMAL(29,10)',
    x_BilledCostInUsd: 'DECIMAL(29,10)', x_EffectiveCostInUsd: 'DECIMAL(29,10)',
    BillingPeriodStart: 'TIMESTAMP', BillingPeriodEnd: 'TIMESTAMP',
    ChargePeriodStart: 'TIMESTAMP', ChargePeriodEnd: 'TIMESTAMP',
    // Azure delivers Tags as a JSON document, not a key/value map.
    Tags: 'JSON',
  },
  gcp: {
    // BigQuery NUMERIC is DECIMAL(38,9); it reaches Parquet as DECIMAL.
    BilledCost: 'DECIMAL(38,9)', ContractedCost: 'DECIMAL(38,9)',
    EffectiveCost: 'DECIMAL(38,9)', ListCost: 'DECIMAL(38,9)',
    ContractedUnitPrice: 'DECIMAL(38,9)', ListUnitPrice: 'DECIMAL(38,9)',
    ConsumedQuantity: 'DECIMAL(38,9)', PricingQuantity: 'DECIMAL(38,9)',
    PricingCurrencyContractedUnitPrice: 'DECIMAL(38,9)',
    PricingCurrencyEffectiveCost: 'DECIMAL(38,9)',
    PricingCurrencyListUnitPrice: 'DECIMAL(38,9)',
    x_CurrencyConversionRate: 'DOUBLE',
    BillingPeriodStart: 'TIMESTAMP', BillingPeriodEnd: 'TIMESTAMP',
    ChargePeriodStart: 'TIMESTAMP', ChargePeriodEnd: 'TIMESTAMP',
    x_ExportTime: 'TIMESTAMP',
    x_Credits: 'STRUCT(Id VARCHAR, FullName VARCHAR, "Type" VARCHAR, Name VARCHAR, Amount DOUBLE)[]',
    x_Labels: GCP_KEY_VALUE,
    x_ProjectLabels: GCP_KEY_VALUE,
    x_SystemLabels: GCP_KEY_VALUE,
    x_Tags: 'STRUCT(Key VARCHAR, Value VARCHAR, x_Inherited BOOLEAN, x_Namespace VARCHAR)[]',
    x_Project: 'STRUCT(Id VARCHAR, Name VARCHAR, "Number" VARCHAR)',
  },
};

/** True for types that arrive as JSON text in the CSV and have to be parsed
 *  rather than plainly cast. */
function isJsonBacked(type: string): boolean {
  return type === 'JSON' || type.startsWith('MAP(') || type.startsWith('STRUCT(');
}

function castExpr(column: string, type: string | undefined): string {
  const quoted = `"${column}"`;
  if (type === undefined) return `${quoted} AS ${quoted}`;
  if (type === 'JSON') return `CAST(${quoted} AS JSON) AS ${quoted}`;
  if (isJsonBacked(type)) {
    // Empty cells are only produced for scalar columns, but guard anyway so a
    // hand-edited sample cannot blow up with a JSON parse error.
    return `CAST(CAST(COALESCE(NULLIF(${quoted}, ''), '${type.endsWith('[]') ? '[]' : '{}'}') AS JSON) AS ${type}) AS ${quoted}`;
  }
  return `CAST(NULLIF(${quoted}, '') AS ${type}) AS ${quoted}`;
}

/** Read a sample CSV into a DuckDB table typed the way the provider's own
 *  export is typed. Returns the table name. */
export async function createNativeTable(
  conn: Runner,
  provider: SampleProvider,
  tableName = `native_${provider}`,
): Promise<string> {
  const types = PHYSICAL_TYPES[provider];
  const selects = NATIVE_COLUMNS[provider].map(col => castExpr(col, types[col]));
  const csvPath = join(SAMPLES_DIR, `${provider}.csv`);
  await conn.run(`
    CREATE OR REPLACE TABLE ${tableName} AS
    SELECT ${selects.join(', ')}
    FROM read_csv('${csvPath}', header = true, all_varchar = true)
  `);
  return tableName;
}

/** The projection each provider adapter has to produce before the query
 *  layer can read its export: every column of `QUERY_CONTRACT_COLUMNS`,
 *  physically present, with `Tags` as a MAP.
 *
 *  This lives in the fixtures on purpose — it is the *specification* the
 *  shipped adapters are tested against, not an adapter itself. AWS needs
 *  nothing beyond a pass-through; the other two show exactly how much work a
 *  provider that is not AWS actually costs. */
export function contractProjection(provider: SampleProvider): string {
  switch (provider) {
    case 'aws':
      // AWS's export already is the contract.
      return `SELECT
        ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
        ServiceName, ServiceCategory, ChargeDescription, ChargeCategory,
        PricingCategory, CommitmentDiscountStatus, ConsumedQuantity, ResourceId,
        BilledCost, EffectiveCost, ListCost, ContractedCost,
        SkuMeter, Tags, x_ServiceCode, x_Operation`;
    case 'azure':
      return `SELECT
        ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
        ServiceName, ServiceCategory, ChargeDescription, ChargeCategory,
        PricingCategory, CommitmentDiscountStatus,
        CAST(ConsumedQuantity AS DOUBLE) AS ConsumedQuantity, ResourceId,
        CAST(BilledCost AS DOUBLE) AS BilledCost,
        CAST(EffectiveCost AS DOUBLE) AS EffectiveCost,
        CAST(ListCost AS DOUBLE) AS ListCost,
        CAST(ContractedCost AS DOUBLE) AS ContractedCost,
        SkuMeter,
        -- Tags arrive as a JSON document; the query layer indexes a MAP.
        CAST(Tags AS MAP(VARCHAR, VARCHAR)) AS Tags,
        -- Azure publishes no service code and no operation dimension.
        ServiceName AS x_ServiceCode,
        CAST(NULL AS VARCHAR) AS x_Operation`;
    case 'gcp':
      return `SELECT
        ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
        ServiceName,
        -- GCP omits ServiceCategory outright: no source, so it defaults empty
        -- rather than being invented.
        '' AS ServiceCategory,
        ChargeDescription, ChargeCategory, PricingCategory,
        -- CUDs surface as x_Credits entries, not CommitmentDiscount* columns.
        CASE WHEN len(list_filter(x_Credits, c -> c."Type" = 'COMMITTED_USAGE_DISCOUNT')) > 0
             THEN 'Used' ELSE '' END AS CommitmentDiscountStatus,
        CAST(ConsumedQuantity AS DOUBLE) AS ConsumedQuantity, ResourceId,
        CAST(BilledCost AS DOUBLE) AS BilledCost,
        CAST(EffectiveCost AS DOUBLE) AS EffectiveCost,
        CAST(ListCost AS DOUBLE) AS ListCost,
        CAST(ContractedCost AS DOUBLE) AS ContractedCost,
        SkuId AS SkuMeter,
        -- Tag sources merged by precedence: tag bindings outrank resource
        -- labels, which outrank project labels. The sources overlap, and
        -- map_from_entries REJECTS a duplicate key rather than picking one —
        -- so keys are de-duplicated first and each one resolved to its
        -- strongest source. A NULL key would fail the same way, hence the
        -- filter.
        map_from_entries(list_transform(
          list_distinct(list_transform(
            list_filter(${GCP_TAG_SOURCES}, e -> e."Key" IS NOT NULL), e -> e."Key")),
          k -> struct_pack(
            k := k,
            v := list_filter(${GCP_TAG_SOURCES}, e -> e."Key" = k)[1]."Value"))) AS Tags,
        COALESCE(NULLIF(x_ServiceId, ''), ServiceName) AS x_ServiceCode,
        CAST(NULL AS VARCHAR) AS x_Operation`;
  }
}

export interface WrittenSample {
  /** Root passed to `buildSource` as `dataDir`. */
  readonly dataDir: string;
  /** Provider instance name — the directory under `dataDir`. */
  readonly providerName: string;
  readonly parquetPath: string;
}

/** Write one provider's sample to disk in the layout `buildSource` reads:
 *  `{dataDir}/{provider}/raw/daily-{month}/data.parquet`.
 *
 *  `shape: 'native'` writes the export exactly as the provider delivers it —
 *  which is what an ingest pipeline receives. `shape: 'contract'` writes the
 *  canonicalized form the query layer requires. */
export async function writeSampleParquet(
  conn: Runner,
  provider: SampleProvider,
  dataDir: string,
  shape: 'native' | 'contract',
): Promise<WrittenSample> {
  const providerName = shape === 'native' ? `${provider}-native` : provider;
  const partDir = join(dataDir, providerName, 'raw', `daily-${SAMPLE_MONTH}`);
  await mkdir(partDir, { recursive: true });
  const parquetPath = join(partDir, 'data.parquet');

  const table = await createNativeTable(conn, provider, `native_${provider}_${shape}`);
  const query = shape === 'native'
    ? `SELECT * FROM ${table}`
    : `${contractProjection(provider)} FROM ${table}`;
  await conn.run(`COPY (${query}) TO '${parquetPath}' (FORMAT PARQUET)`);

  return { dataDir, providerName, parquetPath };
}

/** The committed CSV's raw text — used by the drift test that re-runs the
 *  generator and compares. */
export async function readSampleCsv(provider: SampleProvider): Promise<string> {
  return readFile(join(SAMPLES_DIR, `${provider}.csv`), 'utf-8');
}
