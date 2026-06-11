import { CONFIG_BEACON_KEY } from '../types/sharing.js';

/** Parse an `s3://bucket/key` location (scheme optional) into bucket +
 *  object key. Returns null when the shape is unusable as a publish
 *  target: missing bucket, empty key, or a trailing slash — the bundle
 *  is a single object, not a prefix. */
export function splitS3Location(location: string): { readonly bucket: string; readonly key: string } | null {
  const stripped = location.trim().replace(/^s3:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  if (slashIdx <= 0) return null;
  const bucket = stripped.slice(0, slashIdx);
  const key = stripped.slice(slashIdx + 1);
  if (key.length === 0 || key.endsWith('/')) return null;
  return { bucket, key };
}

/** Default publish location for a team bundle: the well-known beacon key
 *  at the ROOT of the given bucket. Any prefix on the bucket path (CUR
 *  exports live under one) is dropped, because the setup wizard's
 *  discovery probes `costgoblin/org-config.yaml` relative to the bucket
 *  root — that is the discovery contract. */
export function suggestedConfigBeaconLocation(dailyBucket: string): string {
  const stripped = dailyBucket.trim().replace(/^s3:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  const bucket = slashIdx === -1 ? stripped : stripped.slice(0, slashIdx);
  return `s3://${bucket}/${CONFIG_BEACON_KEY}`;
}

/** True when a publish location will be auto-discovered by teammates'
 *  setup wizards — i.e. the key matches the well-known beacon key. A
 *  custom key still publishes fine but must be shared manually. */
export function isDiscoverableBeaconLocation(location: string): boolean {
  return splitS3Location(location)?.key === CONFIG_BEACON_KEY;
}
