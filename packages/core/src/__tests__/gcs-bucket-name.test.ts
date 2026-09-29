import { describe, expect, it } from 'vitest';
import { assertValidGcsBucketName, isValidGcsBucketName, splitGcsLocation } from '../sync/gcs-bucket-name.js';
import { parseGcsPath } from '../sync/gcs-client.js';

describe('isValidGcsBucketName', () => {
  it('accepts legal names', () => {
    const component63 = 'a'.repeat(63);
    // 3 x 63 + 3 dots + 30 = 222 characters, every component <= 63.
    const dotted222 = `${component63}.${component63}.${component63}.${'b'.repeat(30)}`;
    expect(dotted222).toHaveLength(222);
    for (const ok of ['billing-export', 'my_bucket.1', 'abc', component63, dotted222, 'a-b_c.d-e']) {
      expect(isValidGcsBucketName(ok), ok).toBe(true);
    }
  });

  it('rejects every URL and shell metacharacter', () => {
    const metas = ['\\', '#', '?', '%', '"', '&', '|', '^', '<', '>', "'", '$', '!', '`', '/', ':', ' ', '\t', '\n', '\0'];
    for (const ch of metas) {
      expect(isValidGcsBucketName(`bkt${ch}name`), JSON.stringify(ch)).toBe(false);
    }
  });

  it('rejects uppercase and bad leading/trailing characters', () => {
    for (const bad of ['Bucket', 'bUcket', '-bkt', 'bkt-', '.bkt', 'bkt.', '_bkt', 'bkt_']) {
      expect(isValidGcsBucketName(bad), bad).toBe(false);
    }
  });

  it('enforces the length and component boundaries', () => {
    const component63 = 'a'.repeat(63);
    expect(isValidGcsBucketName('ab')).toBe(false);
    expect(isValidGcsBucketName('')).toBe(false);
    expect(isValidGcsBucketName('a'.repeat(64))).toBe(false);
    expect(isValidGcsBucketName(`${'a'.repeat(64)}.bkt`)).toBe(false);
    const dotted223 = `${component63}.${component63}.${component63}.${'b'.repeat(31)}`;
    expect(dotted223).toHaveLength(223);
    expect(isValidGcsBucketName(dotted223)).toBe(false);
    expect(isValidGcsBucketName('a..b')).toBe(false);
  });
});

describe('splitGcsLocation', () => {
  it('matches parseGcsPath', () => {
    for (const loc of ['gs://b/p/q', 'b/p', 'b', 'gs://bkt/', 'gs:///f']) {
      expect(splitGcsLocation(loc), loc).toEqual(parseGcsPath(loc));
    }
    expect(splitGcsLocation('gs://b/p/q')).toEqual({ bucket: 'b', prefix: 'p/q' });
    expect(splitGcsLocation('b')).toEqual({ bucket: 'b', prefix: '' });
  });
});

describe('assertValidGcsBucketName', () => {
  it('throws a plain Error for an invalid name and passes a valid one', () => {
    expect(() => { assertValidGcsBucketName('billing-export'); }).not.toThrow();
    expect(() => { assertValidGcsBucketName('bkt"&calc&"'); }).toThrow(/Invalid GCS bucket name/);
  });
});
