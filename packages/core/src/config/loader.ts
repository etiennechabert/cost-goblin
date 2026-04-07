import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { CostGoblinConfig, DimensionsConfig, OrgTreeConfig } from '../types/index.js';
import { validateConfig, validateDimensions, validateOrgTree } from './validator.js';

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
