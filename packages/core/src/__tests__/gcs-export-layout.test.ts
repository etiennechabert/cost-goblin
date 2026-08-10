import { describe, it, expect } from 'vitest';
import { classifyGcsFolder, gcsTiersOverlap, isBillingPeriodFolder, parseBillingPeriod } from '../sync/gcs-export-layout.js';

describe('gcsTiersOverlap', () => {
  it('accepts the two sibling tier folders the exporter writes', () => {
    expect(gcsTiersOverlap('gs://b/focus/daily/', 'gs://b/focus/hourly/')).toBe(false);
  });

  it('rejects the identical folder', () => {
    expect(gcsTiersOverlap('gs://b/focus/daily/', 'gs://b/focus/daily/')).toBe(true);
  });

  it('rejects containment in either direction', () => {
    // Following the deploy script's closing line verbatim produces exactly
    // this pair, and the daily listing would match every hourly shard.
    expect(gcsTiersOverlap('gs://b/focus', 'gs://b/focus/hourly')).toBe(true);
    expect(gcsTiersOverlap('gs://b/focus/hourly', 'gs://b/focus')).toBe(true);
  });

  it('normalizes the scheme and trailing slashes before comparing', () => {
    expect(gcsTiersOverlap('b/focus/daily', 'gs://b/focus/daily///')).toBe(true);
    expect(gcsTiersOverlap(`gs://b/focus/daily${'/'.repeat(500)}`, 'b/focus/daily')).toBe(true);
  });

  it('does not treat a shared name prefix as containment', () => {
    // `daily` vs `daily-archive`: a naive startsWith on the un-slashed value
    // would call these an overlap and block a legitimate pair.
    expect(gcsTiersOverlap('gs://b/focus/daily', 'gs://b/focus/daily-archive')).toBe(false);
  });

  it('keeps different buckets independent', () => {
    expect(gcsTiersOverlap('gs://b1/focus/daily', 'gs://b2/focus/daily')).toBe(false);
  });
});

describe('parseBillingPeriod', () => {
  it('extracts the YYYY-MM from an exporter period folder', () => {
    expect(parseBillingPeriod('billing_period=2026-07')).toBe('2026-07');
  });

  it('tolerates the trailing slash a GCS common prefix carries', () => {
    expect(parseBillingPeriod('billing_period=2026-07/')).toBe('2026-07');
  });

  it('rejects a month outside 01-12', () => {
    // The sync's own raw/{tier}-{period} dirs are keyed by this string, so a
    // folder named billing_period=2026-13 is not a period — it is a folder
    // that happens to look like one, and treating it as an export would make
    // the wizard accept a location the sync then finds empty.
    expect(parseBillingPeriod('billing_period=2026-13')).toBeNull();
    expect(parseBillingPeriod('billing_period=2026-00')).toBeNull();
  });

  it('rejects near-misses on the shape', () => {
    expect(parseBillingPeriod('billing_period=2026-7')).toBeNull();
    expect(parseBillingPeriod('billing_period=26-07')).toBeNull();
    expect(parseBillingPeriod('billing_period')).toBeNull();
    expect(parseBillingPeriod('daily')).toBeNull();
    expect(parseBillingPeriod('')).toBeNull();
  });

  it('rejects a prefixed lookalike rather than matching mid-string', () => {
    expect(parseBillingPeriod('x-billing_period=2026-07')).toBeNull();
  });
});

describe('isBillingPeriodFolder', () => {
  it('agrees with parseBillingPeriod', () => {
    expect(isBillingPeriodFolder('billing_period=2026-07')).toBe(true);
    expect(isBillingPeriodFolder('metadata')).toBe(false);
  });
});

describe('classifyGcsFolder', () => {
  it('classifies a tier folder holding period partitions as an export', () => {
    const result = classifyGcsFolder(['billing_period=2026-06', 'billing_period=2026-07']);
    expect(result.kind).toBe('export');
    if (result.kind !== 'export') throw new Error('expected export');
    expect(result.periods).toEqual(['2026-06', '2026-07']);
  });

  it('sorts periods chronologically regardless of listing order', () => {
    const result = classifyGcsFolder(['billing_period=2026-07', 'billing_period=2025-12']);
    if (result.kind !== 'export') throw new Error('expected export');
    expect(result.periods).toEqual(['2025-12', '2026-07']);
  });

  it('ignores non-period siblings when periods are present', () => {
    const result = classifyGcsFolder(['billing_period=2026-07', '_tmp', 'notes']);
    if (result.kind !== 'export') throw new Error('expected export');
    expect(result.periods).toEqual(['2026-07']);
  });

  it('recognises the exporter PREFIX folder as the tier parent', () => {
    // The single most common GCP misconfiguration: pointing the provider at
    // gs://bucket/focus rather than gs://bucket/focus/daily, which makes the
    // daily tier list the hourly shards too.
    const result = classifyGcsFolder(['daily', 'hourly']);
    expect(result.kind).toBe('tier-parent');
    if (result.kind !== 'tier-parent') throw new Error('expected tier-parent');
    expect(result.tiers).toEqual(['daily', 'hourly']);
  });

  it('reports a daily-only deployment as a tier parent too', () => {
    const result = classifyGcsFolder(['daily']);
    if (result.kind !== 'tier-parent') throw new Error('expected tier-parent');
    expect(result.tiers).toEqual(['daily']);
  });

  it('orders tiers daily-then-hourly, not by listing order', () => {
    const result = classifyGcsFolder(['hourly', 'daily']);
    if (result.kind !== 'tier-parent') throw new Error('expected tier-parent');
    expect(result.tiers).toEqual(['daily', 'hourly']);
  });

  it('prefers the export reading when a folder somehow holds both', () => {
    // A tier folder named `daily` containing a stray `daily` subfolder must
    // still be selectable — the period partitions are what the sync reads.
    const result = classifyGcsFolder(['billing_period=2026-07', 'daily']);
    expect(result.kind).toBe('export');
  });

  it('classifies a bucket root full of unrelated folders as unknown', () => {
    expect(classifyGcsFolder(['logs', 'backups']).kind).toBe('unknown');
  });

  it('classifies an empty listing as unknown', () => {
    expect(classifyGcsFolder([]).kind).toBe('unknown');
  });

  it('does not treat an AWS-shaped export as a GCP one', () => {
    // data/ + metadata/ is the S3 FOCUS Data Export layout. The GCP exporter
    // never writes it, so accepting it here would let the wizard hand the GCP
    // sync a location it cannot read.
    expect(classifyGcsFolder(['data', 'metadata']).kind).toBe('unknown');
  });

  it('tolerates trailing slashes throughout', () => {
    const result = classifyGcsFolder(['daily/', 'hourly/']);
    if (result.kind !== 'tier-parent') throw new Error('expected tier-parent');
    expect(result.tiers).toEqual(['daily', 'hourly']);
  });
});
