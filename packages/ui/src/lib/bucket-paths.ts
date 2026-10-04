/** The `s3://bucket/` (or `gs://bucket/`) every path lives under, or null when
 *  there is a single path, the paths span buckets, or one sits at the bucket
 *  root. Setup's Confirm step then prints the bucket once, and each tier's
 *  folder fits on its own line instead of wrapping under a repeated bucket
 *  name. */
export function sharedBucketRoot(paths: readonly string[]): string | null {
  if (paths.length < 2) return null;
  const root = /^[a-z0-9]+:\/\/[^/]+\//.exec(paths[0] ?? '')?.[0];
  if (root === undefined) return null;
  return paths.every(p => p.startsWith(root) && p.length > root.length) ? root : null;
}
