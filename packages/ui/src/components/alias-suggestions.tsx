import { useEffect, useState } from 'react';
import { ArrowRightLeft, Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import type { AliasSuggestion } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

export interface AliasSuggestionsProps {
  readonly dimensionId: string;
  readonly onAccepted?: (canonical: string, aliases: readonly string[]) => void;
}

interface SuggestionState extends AliasSuggestion {
  readonly dismissing: boolean;
}

export function AliasSuggestions({
  dimensionId,
  onAccepted,
}: Readonly<AliasSuggestionsProps>): React.JSX.Element | null {
  const api = useCostApi();
  const [suggestions, setSuggestions] = useState<readonly SuggestionState[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const query = useQuery(
    () => api.getAliasSuggestions(dimensionId),
    [dimensionId, api],
  );

  useEffect(() => {
    if (query.status === 'success') {
      setSuggestions(query.data.map(s => ({ ...s, dismissing: false })));
    }
  }, [query]);

  async function handleAccept(canonical: string): Promise<void> {
    setPending(canonical);
    try {
      const s = suggestions.find(x => x.canonical === canonical);
      if (!s) return;
      await api.acceptSuggestion(dimensionId, canonical, s.aliases);
      setSuggestions(prev => prev.filter(x => x.canonical !== canonical));
      onAccepted?.(canonical, s.aliases);
    } finally {
      setPending(null);
    }
  }

  async function handleDismiss(canonical: string): Promise<void> {
    setSuggestions(prev => prev.map(s =>
      s.canonical === canonical ? { ...s, dismissing: true } : s,
    ));
    await new Promise(resolve => { setTimeout(resolve, 200); });
    setPending(canonical);
    try {
      const s = suggestions.find(x => x.canonical === canonical);
      if (!s) return;
      await api.dismissSuggestion(dimensionId, canonical, s.aliases);
      setSuggestions(prev => prev.filter(x => x.canonical !== canonical));
    } catch {
      setSuggestions(prev => prev.map(s =>
        s.canonical === canonical ? { ...s, dismissing: false } : s,
      ));
    } finally {
      setPending(null);
    }
  }

  if (query.status !== 'success' || suggestions.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); }}
        className="flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text-primary transition-colors self-start"
      >
        {open
          ? <ChevronDown className="h-3 w-3" />
          : <ChevronRight className="h-3 w-3" />}
        Suggested Aliases ({String(suggestions.length)})
      </button>
      {open && (
        <div className="flex flex-col gap-2 mt-1">
          {suggestions.map(s => {
            const isProcessing = pending === s.canonical;
            return (
              <div
                key={s.canonical}
                className={`flex items-start gap-3 rounded border border-border bg-bg-secondary p-3 transition-all duration-200 ${s.dismissing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-text-primary">{s.canonical}</div>
                  <div className="mt-1 text-xs text-text-muted">Merge: {s.aliases.join(', ')}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSuggestions(prev => prev.map(x => {
                        if (x.canonical !== s.canonical) return x;
                        const newCanonical = x.aliases[0];
                        if (newCanonical === undefined) return x;
                        return { ...x, canonical: newCanonical, aliases: [x.canonical, ...x.aliases.slice(1)] };
                      }));
                    }}
                    disabled={isProcessing}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors bg-bg-tertiary text-text-muted hover:bg-bg-primary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Flip alias suggestion for ${s.canonical}`}
                  >
                    <ArrowRightLeft className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleAccept(s.canonical); }}
                    disabled={isProcessing}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors bg-accent text-text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Accept alias suggestion for ${s.canonical}`}
                  >
                    <Check className="h-3 w-3" />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleDismiss(s.canonical); }}
                    disabled={isProcessing}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors bg-bg-tertiary text-text-muted hover:bg-bg-primary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Dismiss alias suggestion for ${s.canonical}`}
                  >
                    <X className="h-3 w-3" />
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
