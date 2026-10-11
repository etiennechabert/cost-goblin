/** Regenerates the committed CloudFormation template.
 *
 *   npx tsx scripts/aws-exports/write-template.ts
 *
 *  Output is deterministic, and a test fails if the committed file drifts from
 *  what packages/core/src/aws-setup/exports-stack.ts generates. */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderExportsStackYaml } from '../../packages/core/src/aws-setup/index.js';

const path = join(dirname(fileURLToPath(import.meta.url)), 'costgoblin-exports.yaml');
await writeFile(path, renderExportsStackYaml());
process.stdout.write(`  wrote ${path}\n`);
