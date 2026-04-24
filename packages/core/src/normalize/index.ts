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

export {
  normalizeForPatternMatching,
  isCaseVariation,
  isSeparatorVariation,
  isPotentialAbbreviation,
  hasPatternMatch,
  similarity,
  isSimilar,
  findSimilar,
  clusterBySimilarity,
  generateAliasSuggestions,
} from './similarity.js';
export type { AliasSuggestion } from './similarity.js';
