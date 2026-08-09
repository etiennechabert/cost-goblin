import { rmSync, mkdirSync } from 'node:fs';

import { setup } from '../packages/core/src/__fixtures__/setup.js';
import { V8_DIR } from './helpers.js';

/** Playwright globalSetup: the synthetic fixture parquet is generated, never
 *  committed, so a bare `npx playwright test` must build it itself (fresh
 *  clones, CI runners). setup() probes for every artifact it generates and
 *  returns immediately on a warm tree. */
export default async function globalSetup(): Promise<void> {
  // Start every run from an empty coverage drop dir. V8_DIR is a stable path
  // under $TMPDIR that nothing else cleans, and collect-coverage.ts globs the
  // whole directory — so without this, running one suite and then collecting
  // silently merges shards from previous runs and reports a number for a run
  // that never happened. CI is unaffected (fresh runner per shard); local
  // verification is exactly where the wrong number would mislead.
  rmSync(V8_DIR, { recursive: true, force: true });
  mkdirSync(V8_DIR, { recursive: true });
  await setup();
}
