# FOCUS 1.2 provider samples

Three committed samples of one billing month (2026-05), each shaped the way
that provider's **native** FOCUS 1.2 export actually delivers it:

| File | Export | Columns | Rows |
|---|---|---|---|
| `samples/aws.csv` | AWS Data Exports, `FOCUS_1_2_AWS` table | 52 | 116 |
| `samples/azure.csv` | Microsoft Cost Management FOCUS 1.2 | 64 | 116 |
| `samples/gcp.csv` | Google Cloud FOCUS BigQuery export | 50 | 116 |

The data is **synthetic** — no real account, resource or cost figure appears
in it. What is real is the *shape*: column sets, physical types, value
vocabularies and the gaps between what FOCUS specifies and what each provider
ships.

All three render the **same** set of billing events, so any difference between
the files is a difference in how that provider bills or exports — never
generator noise. Both facts are asserted in
`packages/core/src/__tests__/focus-1-2-samples.integration.test.ts`.

## Why native shapes rather than idealized FOCUS

A sample where all three providers carry an identical 57-column FOCUS 1.2
schema would be fiction, and tests written against it would pass while real
ingest fails. The interesting content of these files is precisely what each
provider *omits*:

| Query-contract column | AWS | Azure | GCP |
|---|---|---|---|
| `ServiceCategory` | ✅ | ✅ | ❌ absent |
| `CommitmentDiscountStatus` | ✅ | ✅ | ❌ — CUDs surface in `x_Credits` |
| `SkuMeter` | ✅ | ✅ | ❌ — only `SkuId` |
| `Tags` | ✅ MAP | ⚠️ JSON document | ❌ — `x_Labels` / `x_Tags` repeated records |
| `x_ServiceCode` | ✅ | ❌ AWS extension | ❌ — closest is `x_ServiceId` |
| `x_Operation` | ✅ | ❌ AWS extension | ❌ |

GCP additionally omits three columns FOCUS 1.2 marks mandatory with no
condition attached — `BillingAccountName`, `InvoiceIssuerName` and
`ServiceCategory`.

`shapes.ts` encodes all of this, including the FOCUS 1.2 requirement levels
themselves (21 mandatory columns, 32 conditional), so the gap analysis is a
data structure rather than prose.

## Physical types

A CSV cannot express that AWS delivers `Tags` as a Parquet `MAP`, Azure as a
JSON document, and GCP as `ARRAY<STRUCT<Key, Value>>` under a different name.
`load.ts` restores the real types on the way into Parquet — including
`DECIMAL(38,9)` costs for GCP (BigQuery `NUMERIC`) and `DECIMAL(29,10)` for
Azure. This matters: tag extraction in the query layer is
`element_at(Tags, 'key')[1]`, which only compiles against a `MAP`.

Empty CSV cells load as `NULL`, the way a real export delivers absent values.

Nested columns are stored in the CSV as JSON text and parsed back on load.

## Using them in a test

```ts
const { providerName } = await writeSampleParquet(conn, 'gcp', dataDir, 'contract');
const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: asProviderName(providerName), periods: ['2026-05'] }] });
```

`shape: 'native'` writes the export exactly as the provider delivers it — what
an ingest pipeline receives. `shape: 'contract'` writes the canonicalized form
the query layer requires; `contractProjection()` in `load.ts` is that mapping,
and doubles as the specification a provider adapter has to satisfy. The shipped
AWS path needs no projection at all; GCP's real adapter lives with the sync
code (see the GCP provider work), not here.

## Regenerating

```bash
npx tsx packages/core/src/__fixtures__/focus-1-2/write-samples.ts
```

Output is deterministic — a seeded generator and fixed timestamps, so an
unchanged generator rewrites identical bytes. A test compares the committed
CSVs against a fresh generator run, so the two cannot drift apart silently.

## Sources

Column sets were taken from vendor references, not from prose summaries, and
last re-checked on 2026-08-04:

- **FOCUS 1.2 requirement levels** — the FinOps Foundation validator's rule
  model `model-1.2.0.1.json`
  ([finopsfoundation/focus_validator](https://github.com/finopsfoundation/focus_validator)):
  every rule whose `Requirement.CheckFunction` is `ColumnPresent`, split by
  keyword and applicability.
- **AWS** — [FOCUS 1.2 with AWS columns](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-focus-1-2-aws.html):
  the full FOCUS 1.2 column set plus exactly three AWS columns
  (`x_Discounts`, `x_Operation`, `x_ServiceCode`).
- **Azure** — `src/open-data/dataset-metadata/FocusCost_1.2-preview.json` in
  [microsoft/finops-toolkit](https://github.com/microsoft/finops-toolkit)
  (106 columns). The `x_` extensions are trimmed here to the eleven that carry
  signal for a cost tool; the standard FOCUS columns are complete.
- **GCP** — [Structure of FOCUS data export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/focus-export),
  cross-checked against a live export schema.

For comparison, the only *official* public FOCUS dataset
([FOCUS-Sample-Data](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data),
CC BY 4.0) is FOCUS **1.0**, CSV-only, and contains 115 Google Cloud rows out
of 5.5 million — which is why these samples exist.
