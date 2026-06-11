import type { BuiltInDimension, DimensionsConfig, TagDimension } from '../types/config.js';

function builtInToYaml(d: BuiltInDimension): Record<string, unknown> {
  return {
    name: d.name,
    label: d.label,
    field: d.field,
    ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
    ...(d.description === undefined ? {} : { description: d.description }),
    ...(d.normalize === undefined ? {} : { normalize: d.normalize }),
    ...(d.aliases === undefined ? {} : { aliases: Object.fromEntries(Object.entries(d.aliases).map(([k, v]) => [k, [...v]])) }),
    ...(d.useOrgAccounts === true ? { useOrgAccounts: true } : {}),
    ...(typeof d.accountNameFromTag === 'string' && d.accountNameFromTag.length > 0 ? { accountNameFromTag: d.accountNameFromTag } : {}),
    ...(d.nameStripPatterns !== undefined && d.nameStripPatterns.length > 0 ? { nameStripPatterns: [...d.nameStripPatterns] } : {}),
    // Persist useRegionNames whenever the user has set it explicitly
    // (either value), so toggling off sticks past a reload. Leaving it
    // unset lets mergeDefaultBuiltIns backfill `true` for the Region dim
    // on legacy configs — we only want that for first-time migration.
    ...(d.useRegionNames === undefined ? {} : { useRegionNames: d.useRegionNames }),
    ...(d.enabled === false ? { enabled: false } : {}),
    ...(d.defaultFilterValues !== undefined && d.defaultFilterValues.length > 0 ? { defaultFilterValues: [...d.defaultFilterValues] } : {}),
  };
}

function tagToYaml(t: TagDimension): Record<string, unknown> {
  return {
    ...(t.tagName === undefined || t.tagName.length === 0 ? {} : { tagName: t.tagName }),
    label: t.label,
    ...(t.concept === undefined ? {} : { concept: t.concept }),
    ...(t.normalize === undefined ? {} : { normalize: t.normalize }),
    ...(t.separator === undefined ? {} : { separator: t.separator }),
    ...(t.aliases === undefined ? {} : { aliases: Object.fromEntries(Object.entries(t.aliases).map(([k, v]) => [k, [...v]])) }),
    ...(t.accountTagFallback === undefined ? {} : { accountTagFallback: t.accountTagFallback }),
    ...(t.missingValueTemplate === undefined ? {} : { missingValueTemplate: t.missingValueTemplate }),
    ...(t.pathSegment === undefined ? {} : { pathSegment: { separator: t.pathSegment.separator, index: t.pathSegment.index } }),
    ...(t.description === undefined ? {} : { description: t.description }),
    ...(t.enabled === false ? { enabled: false } : {}),
    ...(t.defaultFilterValues !== undefined && t.defaultFilterValues.length > 0 ? { defaultFilterValues: [...t.defaultFilterValues] } : {}),
  };
}

/** YAML-ready shape for dimensions.yaml. Keys are emitted in a stable
 *  order and undefined/default fields are omitted so round-tripping a
 *  config doesn't produce noisy diffs. */
export function dimensionsConfigToYaml(config: DimensionsConfig): Record<string, unknown> {
  return {
    builtIn: config.builtIn.map(builtInToYaml),
    tags: config.tags.map(tagToYaml),
    ...(config.order === undefined ? {} : { order: [...config.order] }),
  };
}
