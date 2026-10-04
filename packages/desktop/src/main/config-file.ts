import { stringify } from 'yaml';
import { readYamlMappingIfExists, writeFileAtomic } from '@costgoblin/core';
import { upsertWizardProvider, type WizardProviderConfig } from './config-upsert.js';

// The reads and writes around config-upsert's pure transforms of
// costgoblin.yaml. No electron import, so the handlers and the tests share it.

/** costgoblin.yaml's mapping, to be rewritten by a handler that needs one to
 *  exist. Throws when it doesn't, and whenever readYamlMappingIfExists does:
 *  a config that can't be read or parsed is left for the user to fix. */
export async function readConfigMapping(configPath: string): Promise<Readonly<Record<string, unknown>>> {
  const doc = await readYamlMappingIfExists(configPath);
  if (doc === null) throw new Error(`${configPath} does not exist`);
  return doc;
}

/** Write the setup wizard's provider into costgoblin.yaml (created on first
 *  run), keeping every other provider and top-level key. Only a missing file
 *  starts from an empty config: one that fails to read — a Windows AV lock
 *  outlasting the retries — or to parse throws, rather than be rewritten
 *  with just this provider, dropping the others and their credentials. */
export async function upsertWizardProviderFile(configPath: string, wizard: WizardProviderConfig): Promise<void> {
  const existing = (await readYamlMappingIfExists(configPath)) ?? {};
  await writeFileAtomic(configPath, stringify(upsertWizardProvider(existing, wizard)));
}
