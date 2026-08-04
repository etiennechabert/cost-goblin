/** Regenerates the committed provider samples.
 *
 *   npx tsx packages/core/src/__fixtures__/focus-1-2/write-samples.ts
 *
 *  Output is deterministic: running this on an unchanged generator rewrites
 *  the same bytes, and a test fails if the committed CSVs drift from what the
 *  generator produces. */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSampleCsv } from './samples.js';
import { SAMPLE_PROVIDERS } from './shapes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'samples');

await mkdir(SAMPLES_DIR, { recursive: true });
for (const provider of SAMPLE_PROVIDERS) {
  const csv = buildSampleCsv(provider);
  const path = join(SAMPLES_DIR, `${provider}.csv`);
  await writeFile(path, csv);
  process.stdout.write(`  wrote ${path} (${String(csv.split('\n').length - 2)} rows)\n`);
}
