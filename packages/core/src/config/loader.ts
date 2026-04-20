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
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateOrgTree(raw);
}

export async function loadViews(path: string): Promise<ViewsConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateViews(raw);
}

export async function loadCostScope(path: string): Promise<CostScopeConfig> {
  const content = await readFile(path, 'utf-8');
  const raw: unknown = parse(content);
  return validateCostScope(raw);
}
