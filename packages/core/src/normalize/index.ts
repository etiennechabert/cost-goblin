export {
  applyNormalizationRule,
  normalizeTagValue,
  resolveAlias,
  normalizeAndResolve,
  buildAliasSqlCase,
  applyStripPatterns,
  applyRegionFriendlyNames,
} from './normalize.js';
export type { RegionEnrichment } from './normalize.js';

export { generateAliasSuggestions } from './similarity.js';
export type { AliasSuggestion } from './similarity.js';
