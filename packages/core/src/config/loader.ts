import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { CostGoblinConfig, DimensionsConfig, OrgTreeConfig } from '../types/index.js';
import type { ViewsConfig } from '../types/views.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { validateConfig, validateDimensions, validateOrgTree } from './validator.js';
import { validateViews } from './views-validator.js';
import { validateCostScope } from './cost-scope-validator.js';
import { readTextIfExists, retryTransientFs } from '../utils/atomic-file.js';
import { isStringRecord } from '../utils/json.js';

export async function loadConfig(path: string): Promise<CostGoblinConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateConfig(raw);
}

export async function loadDimensions(path: string): Promise<DimensionsConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateDimensions(raw);
}

export async function loadOrgTree(path: string): Promise<OrgTreeConfig> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return { tree: [] };
  }
  const raw: unknown = parse(content);
  return validateOrgTree(raw);
}

export async function loadViews(path: string, liveDimensionIds?: ReadonlySet<string>): Promise<ViewsConfig> {
  // A transient lock (AV, indexer) is retried: its caller seeds only a missing
  // file and surfaces anything else, so an un-retried EBUSY would hide the
  // user's dashboards for the session.
  const content = await retryTransientFs(() => readFile(path, 'utf-8'));
  const raw: unknown = parse(content);
  return validateViews(raw, liveDimensionIds);
}

export async function loadCostScope(path: string, liveDimensionIds?: ReadonlySet<string>): Promise<CostScopeConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateCostScope(raw, liveDimensionIds);
}

/** A YAML config file's top-level mapping, read to be rewritten; null only
 *  when the file doesn't exist. Any other read failure (transient ones are
 *  retried) throws, and so does a file that isn't a YAML mapping — a syntax
 *  error, a list, a scalar — leaving it for the user to fix: rewriting from
 *  an empty mapping would drop everything it held. A blank document (an empty
 *  file, only comments) reads as {}: it holds nothing to lose. */
export async function readYamlMappingIfExists(path: string): Promise<Readonly<Record<string, unknown>> | null> {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  const doc: unknown = parse(text);
  if (doc === null || doc === undefined) return {};
  if (!isStringRecord(doc)) throw new Error(`${path} is not a YAML mapping; refusing to rewrite it`);
  return doc;
}
