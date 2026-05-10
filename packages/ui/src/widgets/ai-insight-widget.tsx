import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { Sparkles, RefreshCw } from 'lucide-react';
import { AIInsightCard } from '../components/ai-insight-card.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { AIInsight, OllamaStatus } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { asDimensionId } from '@costgoblin/core/browser';
import { mergeFilters } from './widget.js';

export function AIInsightWidget({
  dateRange,
  globalFilters,
  spec,
}: WidgetCommonProps) {
  const api = useCostApi();
  const [insight, setInsight] = useState<AIInsight | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAIInsight = spec.type === 'ai-insight';

  const filters = mergeFilters(globalFilters, spec.filters);

  // Check Ollama status
  const statusQuery = useQuery<OllamaStatus>(
    () => isAIInsight ? api.getOllamaStatus() : Promise.resolve({ state: 'disconnected', error: 'AI widget disabled' }),
    [isAIInsight, api],
  );

  if (!isAIInsight) return null;

  if (statusQuery.status === 'loading') {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
        <CoinRainLoader height={200} count={4} />
      </div>
    );
  }

  const ollamaStatus = statusQuery.status === 'success' ? statusQuery.data : null;
  const isConnected = ollamaStatus?.state === 'connected';

  const handleGenerateInsight = async () => {
    if (!isConnected) return;

    setGenerating(true);
    setError(null);

    try {
      const result = await api.generateInsight({
        type: 'trend-summary',
        dateRange,
        filters,
        groupBy: asDimensionId('service'),
      });

      setInsight(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate insight');
    } finally {
      setGenerating(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full flex flex-col items-center justify-center gap-4">
        <Sparkles className="w-12 h-12 text-text-tertiary" />
        <div className="text-center">
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            AI Insights Unavailable
          </h3>
          <p className="text-sm text-text-secondary mb-4">
            Ollama is not running. Start Ollama to generate AI cost insights.
          </p>
          <p className="text-xs text-text-tertiary">
            Install from{' '}
            <a
              href="https://ollama.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary hover:underline"
            >
              ollama.ai
            </a>
          </p>
        </div>
      </div>
    );
  }

  if (!insight && !generating && !error) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full flex flex-col items-center justify-center gap-4">
        <Sparkles className="w-12 h-12 text-accent-primary" />
        <div className="text-center">
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            AI Cost Insights
          </h3>
          <p className="text-sm text-text-secondary mb-4">
            Generate an AI-powered summary of your cost trends
          </p>
          <button
            onClick={() => { void handleGenerateInsight(); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Generate AI Insight
          </button>
        </div>
      </div>
    );
  }

  if (generating) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-accent-primary" />
          <h3 className="text-base font-semibold text-text-primary">
            AI Cost Insights
          </h3>
        </div>
        <div className="flex flex-col items-center justify-center py-12">
          <CoinRainLoader height={150} count={3} />
          <p className="text-sm text-text-secondary mt-4">
            Generating AI insight...
          </p>
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent-primary" />
            <h3 className="text-base font-semibold text-text-primary">
              AI Cost Insights
            </h3>
          </div>
          <button
            onClick={() => { void handleGenerateInsight(); }}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
        <div className="text-center py-8">
          <p className="text-sm text-text-error mb-2">
            Failed to generate insight
          </p>
          <p className="text-xs text-text-tertiary">
            {error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent-primary" />
            <h3 className="text-base font-semibold text-text-primary">
              AI Cost Insights
            </h3>
          </div>
          <button
            onClick={() => { void handleGenerateInsight(); }}
            disabled={generating}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-4 h-4" />
            Regenerate
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <AIInsightCard insight={insight} />
        </div>
      </div>
    </div>
  );
}
