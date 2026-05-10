import { Sparkles, TrendingUp, TrendingDown, Minus, Lightbulb, MessageSquare } from 'lucide-react';
import { formatDollars } from './format.js';
import type { AIInsight } from '@costgoblin/core/browser';

interface AIInsightCardProps {
  /** `null` means "not loaded yet" — the card renders placeholders so the
   *  user doesn't briefly see empty content before the real insight lands. */
  insight: AIInsight | null;
}

const PLACEHOLDER = '—';

export function AIInsightCard({ insight }: Readonly<AIInsightCardProps>) {
  const hasInsight = insight !== null;

  if (!hasInsight) {
    return (
      <div className="flex flex-col rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-5 w-5 text-text-secondary" />
          <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">AI Insight</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-2xl text-text-muted">{PLACEHOLDER}</p>
        </div>
      </div>
    );
  }

  const { result, model, generatedAt, inferenceTimeMs } = insight;
  const timestamp = new Date(generatedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="flex flex-col rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-text-secondary" />
          <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            {result.type === 'trend-summary' && 'Trend Summary'}
            {result.type === 'optimization' && 'Optimization'}
            {result.type === 'conversational' && 'AI Answer'}
          </p>
        </div>
        {result.type === 'trend-summary' && (
          <div className="flex items-center gap-1">
            {result.trend === 'increasing' && <TrendingUp className="h-4 w-4 text-negative" />}
            {result.trend === 'decreasing' && <TrendingDown className="h-4 w-4 text-positive" />}
            {result.trend === 'stable' && <Minus className="h-4 w-4 text-text-secondary" />}
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-4">
        {result.type === 'trend-summary' && (
          <>
            <div>
              <p className="text-sm text-text-primary leading-relaxed">{result.summary}</p>
            </div>
            {result.keyFindings.length > 0 && (
              <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
                <p className="text-xs uppercase tracking-wider text-text-muted mb-2">Key Findings</p>
                <ul className="space-y-1.5">
                  {result.keyFindings.map((finding, idx) => (
                    <li key={idx} className="text-xs text-text-primary flex items-start gap-2">
                      <span className="text-text-secondary mt-0.5">•</span>
                      <span>{finding}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {result.type === 'optimization' && (
          <>
            {result.totalEstimatedSavings > 0 && (
              <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
                <p className="text-xs uppercase tracking-wider text-text-muted">Total Estimated Savings</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-positive">
                  {formatDollars(result.totalEstimatedSavings)}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">per month</p>
              </div>
            )}
            <div className="space-y-3">
              {result.suggestions.map((suggestion, idx) => (
                <div key={idx} className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-start gap-2">
                      <Lightbulb className="h-4 w-4 text-text-secondary mt-0.5 flex-shrink-0" />
                      <p className="text-sm font-semibold text-text-primary">{suggestion.title}</p>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide flex-shrink-0 ${
                        suggestion.priority === 'high'
                          ? 'bg-negative/20 text-negative'
                          : suggestion.priority === 'medium'
                            ? 'bg-text-secondary/20 text-text-secondary'
                            : 'bg-text-muted/20 text-text-muted'
                      }`}
                    >
                      {suggestion.priority}
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary mb-2 ml-6">{suggestion.description}</p>
                  <p className="text-xs font-semibold text-positive ml-6">
                    Save {formatDollars(suggestion.estimatedSavings)}/month
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {result.type === 'conversational' && (
          <>
            <div className="flex items-start gap-3">
              <MessageSquare className="h-5 w-5 text-text-secondary mt-0.5 flex-shrink-0" />
              <p className="text-sm text-text-primary leading-relaxed">{result.answer}</p>
            </div>
            {result.supportingData !== undefined && result.supportingData.length > 0 && (
              <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
                <p className="text-xs uppercase tracking-wider text-text-muted mb-2">Supporting Data</p>
                <ul className="space-y-1.5">
                  {result.supportingData.map((data, idx) => (
                    <li key={idx} className="text-xs text-text-primary flex items-start gap-2">
                      <span className="text-text-secondary mt-0.5">•</span>
                      <span>{data}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-border/50 flex items-center justify-between text-xs text-text-muted">
        <span>Model: {model}</span>
        <div className="flex items-center gap-3">
          <span>{timestamp}</span>
          <span>{inferenceTimeMs}ms</span>
        </div>
      </div>
    </div>
  );
}
