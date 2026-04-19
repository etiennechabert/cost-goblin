import type { CostScopeConfig, ExclusionCondition, ExclusionRule } from '../types/cost-scope.js';

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
  return { costMetric: cfg.costMetric, rules: cfg.rules.map(ruleToYaml) };
}
