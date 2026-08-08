import { setup } from '../packages/core/src/__fixtures__/setup.js';

/** Playwright globalSetup: the synthetic fixture parquet is generated, never
 *  committed, so a bare `npx playwright test` must build it itself (fresh
 *  clones, CI runners). setup() probes for every artifact it generates and
 *  returns immediately on a warm tree. */
export default async function globalSetup(): Promise<void> {
  await setup();
}
