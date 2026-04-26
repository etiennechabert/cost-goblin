import type { CostScopeConfig, ExclusionCondition, ExclusionRule } from '../types/cost-scope.js';
import { DEFAULT_LAG_DAYS } from '../types/cost-scope.js';

interface YamlCondition { dimensionId: string; values: string[] }
interface YamlRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  builtIn: boolean;
  conditions: YamlCondition[];
}

export interface YamlCostScope {
  costMetric: string;
  costPerspective?: string;
  lagDays?: number;
  rules: YamlRule[];
}

function conditionToYaml(c: ExclusionCondition): YamlCondition {
  return { dimensionId: String(c.dimensionId), values: [...c.values] };
}

function ruleToYaml(r: ExclusionRule): YamlRule {
  return {
    id: r.id,
    name: r.name,
    ...(r.description !== undefined ? { description: r.description } : {}),
    enabled: r.enabled,
    builtIn: r.builtIn,
    conditions: r.conditions.map(conditionToYaml),
  };
}

export function costScopeToYaml(cfg: CostScopeConfig): YamlCostScope {
  const lagDays = cfg.lagDays ?? DEFAULT_LAG_DAYS;
  return {
    costMetric: cfg.costMetric,
    // Only emit when non-default — keeps legacy YAMLs from churning
    // when the serializer round-trips them.
    ...(cfg.costPerspective !== undefined && cfg.costPerspective !== 'gross'
      ? { costPerspective: cfg.costPerspective }
      : {}),
    ...(lagDays !== DEFAULT_LAG_DAYS ? { lagDays } : {}),
    rules: cfg.rules.map(ruleToYaml),
  };
}
