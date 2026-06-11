import { describe, expect, it } from 'vitest';
import { isDiscoverableBeaconLocation, splitS3Location, suggestedConfigBeaconLocation } from '../config/sharing-location.js';
import { CONFIG_BEACON_KEY } from '../types/index.js';

describe('splitS3Location', () => {
  it('parses scheme and scheme-less object locations', () => {
    expect(splitS3Location('s3://my-bucket/costgoblin/org-config.yaml')).toEqual({ bucket: 'my-bucket', key: 'costgoblin/org-config.yaml' });
    expect(splitS3Location('my-bucket/some/key.yaml')).toEqual({ bucket: 'my-bucket', key: 'some/key.yaml' });
    expect(splitS3Location('  s3://b/k.yaml  ')).toEqual({ bucket: 'b', key: 'k.yaml' });
  });

  it('rejects bucket-only, empty-key and prefix (trailing slash) forms', () => {
    expect(splitS3Location('s3://my-bucket')).toBeNull();
    expect(splitS3Location('s3://my-bucket/')).toBeNull();
    expect(splitS3Location('s3://my-bucket/prefix/')).toBeNull();
    expect(splitS3Location('')).toBeNull();
    expect(splitS3Location('/key-without-bucket')).toBeNull();
  });
});

describe('suggestedConfigBeaconLocation', () => {
  it('targets the well-known key at the bucket root, dropping any CUR prefix', () => {
    expect(suggestedConfigBeaconLocation('s3://my-bucket/cur/daily/')).toBe(`s3://my-bucket/${CONFIG_BEACON_KEY}`);
    expect(suggestedConfigBeaconLocation('my-bucket/daily')).toBe(`s3://my-bucket/${CONFIG_BEACON_KEY}`);
    expect(suggestedConfigBeaconLocation('s3://my-bucket')).toBe(`s3://my-bucket/${CONFIG_BEACON_KEY}`);
  });
});

describe('isDiscoverableBeaconLocation', () => {
  it('is true only for the well-known key', () => {
    expect(isDiscoverableBeaconLocation(`s3://any-bucket/${CONFIG_BEACON_KEY}`)).toBe(true);
    expect(isDiscoverableBeaconLocation('s3://any-bucket/custom/org-config.yaml')).toBe(false);
    expect(isDiscoverableBeaconLocation('s3://any-bucket/costgoblin/')).toBe(false);
    expect(isDiscoverableBeaconLocation('garbage')).toBe(false);
  });
});
