/** GCS bucket-name rules and location splitting.
 *
 *  Lives in its own leaf module — with NO imports — so the config validator,
 *  the Storage SDK handle and the rsync spawn path can share one predicate
 *  without dragging node built-ins or the SDK into each other.
 *
 *  Why it matters: a bucket name comes from config, and config is shareable
 *  (bundles, beacons, peer pull, workspaces, git-shared YAML). The Storage SDK
 *  puts the name in its request URL unencoded — WHATWG parsing then maps `\`
 *  to `/`, cuts at `#` and starts a query at `?`, so a crafted name can list a
 *  different bucket than the one shown. On Windows the name also reaches a
 *  cmd.exe line as the `gcloud storage rsync` source. The GCS naming rules
 *  admit none of those characters, so enforcing them closes both sinks.
 */

/** Human-readable summary of the rules `isValidGcsBucketName` enforces, for
 *  rejection messages. */
export const GCS_BUCKET_NAME_RULES =
  'GCS bucket names use only lowercase letters, digits, "-", "_" and ".", start and end with a letter or digit, '
  + 'and are 3-63 characters (up to 222 when dotted, with each dot-separated part at most 63)';

const BUCKET_CHARSET = /^[a-z0-9._-]+$/;
const ALNUM = /^[a-z0-9]$/;

/** Whether `name` is a legal GCS bucket name: charset `[a-z0-9._-]`, first
 *  and last character alphanumeric, total length 3-222, and every
 *  dot-separated component 1-63 characters (so an undotted name is at most
 *  63, and `a..b` is rejected). */
export function isValidGcsBucketName(name: string): boolean {
  if (name.length < 3 || name.length > 222) return false;
  if (!BUCKET_CHARSET.test(name)) return false;
  if (!ALNUM.test(name.charAt(0)) || !ALNUM.test(name.charAt(name.length - 1))) return false;
  return name.split('.').every(component => component.length >= 1 && component.length <= 63);
}

/** Splits a `gs://bucket/prefix` location (scheme optional, mirroring how
 *  `parseS3Path` tolerates a bare `bucket/prefix`) into its two parts. Does
 *  NOT validate the bucket — pair it with `isValidGcsBucketName`. */
export function splitGcsLocation(location: string): { bucket: string; prefix: string } {
  const stripped = location.replace(/^gs:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  if (slashIdx === -1) {
    return { bucket: stripped, prefix: '' };
  }
  return {
    bucket: stripped.slice(0, slashIdx),
    prefix: stripped.slice(slashIdx + 1),
  };
}

/** Throws a plain `Error` when `bucket` is not a legal GCS bucket name. Used
 *  at the sinks (the Storage SDK handle and the rsync spawn path) as a
 *  second line behind config-load validation. The name is JSON-quoted so a
 *  control character in it cannot corrupt the log line the message lands in. */
export function assertValidGcsBucketName(bucket: string): void {
  if (!isValidGcsBucketName(bucket)) {
    throw new Error(`Invalid GCS bucket name ${JSON.stringify(bucket)}: ${GCS_BUCKET_NAME_RULES}`);
  }
}
