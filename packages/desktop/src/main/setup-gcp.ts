import { isStringRecord, parseJsonArray } from '@costgoblin/core';
import type { GcpProject } from '@costgoblin/core';

/** Pure parsers behind the GCP setup handlers, kept out of `handlers/setup.ts`
 *  so they can be tested without spawning gcloud or reaching Cloud Storage —
 *  the same split `setup-manifest.ts` makes for the AWS side. */

/** Projects whose buckets are still usable. `gcloud projects list` also
 *  returns projects pending deletion; a project the user picks must not
 *  vanish underneath the bucket step. An ABSENT lifecycleState is kept —
 *  older CLI versions omit it, and absent is not the same as non-ACTIVE. */
function isUsableLifecycle(entry: Readonly<Record<string, unknown>>): boolean {
  const state: unknown = entry['lifecycleState'];
  if (typeof state !== 'string') return true;
  return state === 'ACTIVE';
}

/** Narrow `gcloud projects list --format=json` stdout into the project list.
 *
 *  Returns `[]` rather than throwing on unparseable output: gcloud writes
 *  update nags and "no active account" prose to stdout in some configurations,
 *  and the caller distinguishes "no projects" from "command failed" by the
 *  exit code, not by this. */
export function parseGcloudProjects(stdout: string): GcpProject[] {
  const parsed = parseJsonArray(stdout);
  if (parsed === null) return [];

  const projects: GcpProject[] = [];
  for (const entry of parsed) {
    if (!isStringRecord(entry)) continue;
    if (!isUsableLifecycle(entry)) continue;
    const rawId: unknown = entry['projectId'];
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const rawName: unknown = entry['name'];
    const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : rawId;
    projects.push({ projectId: rawId, name });
  }
  return projects;
}

/** Pull the child folder names out of a `getFiles({ delimiter: '/' })`
 *  response.
 *
 *  The SDK types `apiResponse` as `unknown` (the common prefixes live only
 *  there, not on the `File[]`), so every step is guarded. Names come back
 *  relative to `parentPrefix` and without the trailing delimiter, matching
 *  what `browseS3` returns for the AWS wizard. */
export function extractGcsPrefixNames(apiResponse: unknown, parentPrefix: string): string[] {
  if (!isStringRecord(apiResponse)) return [];
  const raw: unknown = apiResponse['prefixes'];
  if (!Array.isArray(raw)) return [];

  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    // A prefix outside the browsed folder would be mangled by a blind
    // length-slice into a name that resolves nowhere when clicked.
    if (!value.startsWith(parentPrefix)) continue;
    const relative = value.slice(parentPrefix.length).replace(/\/$/, '');
    if (relative.length === 0) continue;
    names.push(relative);
  }
  return names;
}
