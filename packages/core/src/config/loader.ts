import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { CostGoblinConfig, DimensionsConfig, OrgTreeConfig } from '../types/index.js';
import type { ViewsConfig } from '../types/views.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { validateConfig, validateDimensions, validateOrgTree } from './validator.js';
import { validateViews } from './views-validator.js';
import { validateCostScope } from './cost-scope-validator.js';

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
  } catch (err) {
    // Only a missing file means "no tree". One that can't be read (EACCES)
    // rejects like one that doesn't parse, instead of reading as empty.
    if (isMissingFile(err)) return { tree: [] };
    throw err;
  }
  const raw: unknown = parse(content);
  return validateOrgTree(raw);
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export async function loadViews(path: string, liveDimensionIds?: ReadonlySet<string>): Promise<ViewsConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  // A views.yaml written before topN had to be a positive integer still loads.
  return validateViews(raw, liveDimensionIds, { invalidTopN: 'drop' });
}

export async function loadCostScope(path: string, liveDimensionIds?: ReadonlySet<string>): Promise<CostScopeConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateCostScope(raw, liveDimensionIds);
}
