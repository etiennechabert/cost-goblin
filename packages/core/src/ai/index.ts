export type { ModelName, InsightType, OllamaStatus, AIModel, AIPreferences } from './types.js';
export { asModelName } from './types.js';
export type {
  TrendSummaryParams,
  OptimizationParams,
  ConversationalParams,
  InsightParams,
  OptimizationSuggestion,
  TrendSummaryInsight,
  OptimizationInsight,
  ConversationalInsight,
  InsightResult,
  AIInsight,
  InsightGenerationState,
} from './types.js';

export type {
  OllamaClientOptions,
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  OllamaHandle,
} from './ollama-client.js';
export { createOllamaHandle } from './ollama-client.js';

export {
  buildTrendSummaryPrompt,
  buildOptimizationPrompt,
  buildConversationalPrompt,
  buildPrompt,
} from './prompt-builder.js';
