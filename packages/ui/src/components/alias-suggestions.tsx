import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { AliasSuggestion } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

/** Props for the AliasSuggestions component.
 *  Displays suggested tag aliases for a dimension based on similarity analysis. */
export interface AliasSuggestionsProps {
  /** Tag dimension name to generate suggestions for (e.g., 'Environment', 'Owner') */
  readonly dimensionId: string;
  /** Callback fired when a suggestion is accepted and applied to the config */
  readonly onAccepted?: () => void;
}

/** Internal state for tracking which suggestions are being processed.
 *  Prevents double-clicks and provides loading feedback. */
interface SuggestionAction {
  readonly canonical: string;
  readonly action: 'accepting' | 'dismissing';
}

/** UI-specific suggestion state that combines the core AliasSuggestion
 *  with visual state for animations and pending actions. */
interface SuggestionState extends AliasSuggestion {
  /** True when this suggestion is currently being dismissed with animation */
  readonly dismissing: boolean;
}

/** AliasSuggestions component displays AI-detected tag alias groups and allows
 *  users to accept (merge into config) or dismiss (hide permanently) them.
 *
 *  Suggestions are generated using fuzzy matching (Levenshtein distance) and
 *  pattern detection (case variations, abbreviations, separator differences).
 *
 *  Example usage:
 *    <AliasSuggestions
 *      dimensionId="environment"
 *      onAccepted={() => { refetchData(); }}
 *    />
 *
 *  The component queries suggestions on mount and handles accept/dismiss actions
 *  via IPC handlers that update dimensions.yaml and dismissed-suggestions.json. */
export function AliasSuggestions({
  dimensionId,
  onAccepted,
}: Readonly<AliasSuggestionsProps>): React.JSX.Element | null {
  const api = useCostApi();
  const [suggestions, setSuggestions] = useState<readonly SuggestionState[]>([]);
  const [pendingAction, setPendingAction] = useState<SuggestionAction | null>(null);

  // Load suggestions from the backend on mount and when dimensionId changes
  const suggestionsQuery = useQuery(
    async () => {
      return await api.getAliasSuggestions(dimensionId);
    },
    [dimensionId, api],
  );

  // Sync query results to local state when query completes
  useEffect(() => {
    if (suggestionsQuery.status === 'success') {
      setSuggestions(suggestionsQuery.data.map(s => ({ ...s, dismissing: false })));
    }
  }, [suggestionsQuery]);

  async function handleAccept(canonical: string): Promise<void> {
    setPendingAction({ canonical, action: 'accepting' });
    try {
      const suggestion = suggestions.find(s => s.canonical === canonical);
      if (!suggestion) return;

      await api.acceptSuggestion(dimensionId, canonical, suggestion.aliases);
      setSuggestions(prev => prev.filter(s => s.canonical !== canonical));
      onAccepted?.();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDismiss(canonical: string): Promise<void> {
    // Start dismissing animation
    setSuggestions(prev => prev.map(s =>
      s.canonical === canonical ? { ...s, dismissing: true } : s,
    ));

    // Wait for animation to complete before removing from DOM
    await new Promise(resolve => { setTimeout(resolve, 200); });

    setPendingAction({ canonical, action: 'dismissing' });
    try {
      const suggestion = suggestions.find(s => s.canonical === canonical);
      if (!suggestion) return;

      await api.dismissSuggestion(dimensionId, canonical, suggestion.aliases);
      setSuggestions(prev => prev.filter(s => s.canonical !== canonical));
    } catch {
      // Revert dismissing state on error (toast notification will be added in future)
      setSuggestions(prev => prev.map(s =>
        s.canonical === canonical ? { ...s, dismissing: false } : s,
      ));
    } finally {
      setPendingAction(null);
    }
  }

  // Don't render anything if loading or no suggestions
  if (suggestionsQuery.status === 'loading') return null;
  if (suggestionsQuery.status === 'error') return null;
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-text-muted">Suggested Aliases</div>
      <div className="flex flex-col gap-2">
        {suggestions.map(suggestion => {
          const isProcessing = pendingAction?.canonical === suggestion.canonical;
          const isAccepting = isProcessing && pendingAction.action === 'accepting';
          const isDismissing = suggestion.dismissing || (isProcessing && pendingAction.action === 'dismissing');

          return (
            <div
              key={suggestion.canonical}
              className={`
                flex items-start gap-3 rounded border border-border bg-bg-secondary p-3
                transition-all duration-200
                ${isDismissing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}
              `}
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-text-primary">
                  {suggestion.canonical}
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  Merge: {suggestion.aliases.join(', ')}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { void handleAccept(suggestion.canonical); }}
                  disabled={isProcessing}
                  className={`
                    flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium
                    transition-colors
                    ${isAccepting
                      ? 'bg-accent/20 text-accent cursor-wait'
                      : 'bg-accent text-text-on-accent hover:bg-accent-hover'
                    }
                    disabled:cursor-not-allowed disabled:opacity-50
                  `}
                  aria-label={`Accept alias suggestion for ${suggestion.canonical}`}
                >
                  <Check className="h-3 w-3" />
                  {isAccepting ? 'Accepting...' : 'Accept'}
                </button>
                <button
                  type="button"
                  onClick={() => { void handleDismiss(suggestion.canonical); }}
                  disabled={isProcessing}
                  className={`
                    flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium
                    transition-colors
                    ${isDismissing
                      ? 'bg-text-muted/20 text-text-muted cursor-wait'
                      : 'bg-bg-tertiary text-text-muted hover:bg-bg-primary hover:text-text-primary'
                    }
                    disabled:cursor-not-allowed disabled:opacity-50
                  `}
                  aria-label={`Dismiss alias suggestion for ${suggestion.canonical}`}
                >
                  <X className="h-3 w-3" />
                  {isDismissing ? 'Dismissing...' : 'Dismiss'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
