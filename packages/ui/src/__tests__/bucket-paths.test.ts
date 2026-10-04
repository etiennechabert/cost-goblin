import { describe, expect, it } from 'vitest';
import { sharedBucketRoot } from '../lib/bucket-paths.js';

describe('sharedBucketRoot', () => {
  it('returns the bucket every tier lives in', () => {
    expect(sharedBucketRoot(['s3://b/focus_daily/x/', 's3://b/focus_hourly/y/', 's3://b/cost_optimization/z/'])).toBe('s3://b/');
    expect(sharedBucketRoot(['gs://acme/focus/daily/', 'gs://acme/focus/hourly/'])).toBe('gs://acme/');
  });

  it('keeps full paths for a single tier', () => {
    expect(sharedBucketRoot(['s3://b/focus_daily/'])).toBeNull();
  });

  it('keeps full paths when the tiers span buckets', () => {
    expect(sharedBucketRoot(['s3://b/daily/', 's3://other/hourly/'])).toBeNull();
    // A bucket whose name extends another's is a different bucket.
    expect(sharedBucketRoot(['s3://b/daily/', 's3://bb/hourly/'])).toBeNull();
  });

  it('keeps full paths when a tier sits at the bucket root', () => {
    expect(sharedBucketRoot(['s3://b/', 's3://b/hourly/'])).toBeNull();
  });
});
