export {
  applyNormalizationRule,
  normalizeTagValue,
  resolveAlias,
  normalizeAndResolve,
  buildAliasSqlCase,
  applyRegionFriendlyNames,
} from './normalize.js';
export type { RegionEnrichment } from './normalize.js';

// `stripNamesBounded` (./strip-bounded.ts) is deliberately NOT re-exported
// here: this barrel is part of the browser entry, and that module needs
// node:vm. It is exported from the Node entry (src/index.ts) only.

export { generateAliasSuggestions } from './similarity.js';
export type { AliasSuggestion } from './similarity.js';
