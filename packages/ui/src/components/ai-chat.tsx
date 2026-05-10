import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { Button } from './ui/button.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import type { ConversationalInsight } from '@costgoblin/core/browser';

interface Message {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly supportingData?: readonly string[];
  readonly timestamp: string;
}

interface AIChatProps {
  /** Optional initial messages to display in the chat history. */
  readonly initialMessages?: readonly Message[];
}

export function AIChat({ initialMessages = [] }: Readonly<AIChatProps>) {
  const [messages, setMessages] = useState<readonly Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const api = useCostApi();

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = useCallback((e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (trimmed === '' || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    // Call the API directly
    api.generateInsight({
      type: 'conversational',
      query: trimmed,
    })
      .then((insight) => {
        const result = insight.result as ConversationalInsight;
        const baseMessage = {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: result.answer,
          timestamp: new Date().toISOString(),
        };
        const assistantMessage: Message = result.supportingData !== undefined
          ? { ...baseMessage, supportingData: result.supportingData }
          : baseMessage;
        setMessages(prev => [...prev, assistantMessage]);
      })
      .catch((error: unknown) => {
        const errorMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, errorMessage]);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [inputValue, isLoading, api]);

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-bg-secondary">
      {/* Chat header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bot className="h-5 w-5 text-text-secondary" />
        <h2 className="text-sm font-semibold text-text-primary">AI Cost Assistant</h2>
      </div>

      {/* Messages container */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <Bot className="h-12 w-12 text-text-muted mb-3" />
            <p className="text-sm text-text-primary font-medium mb-1">
              Ask me anything about your costs
            </p>
            <p className="text-xs text-text-secondary max-w-sm">
              Try: "Which team spent the most on S3 last month?" or "What caused our costs to increase this week?"
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {message.role === 'assistant' && (
              <div className="flex-shrink-0 mt-1">
                <Bot className="h-5 w-5 text-text-secondary" />
              </div>
            )}
            <div
              className={`flex flex-col max-w-[80%] ${
                message.role === 'user'
                  ? 'bg-accent text-white rounded-2xl rounded-tr-sm px-4 py-2'
                  : 'bg-bg-tertiary/50 text-text-primary rounded-2xl rounded-tl-sm px-4 py-3'
              }`}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
              {message.supportingData !== undefined && message.supportingData.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border/30">
                  <p className="text-xs uppercase tracking-wider text-text-muted mb-2">
                    Supporting Data
                  </p>
                  <ul className="space-y-1">
                    {message.supportingData.map((data, idx) => (
                      <li key={idx} className="text-xs flex items-start gap-2">
                        <span className="text-text-secondary mt-0.5">•</span>
                        <span>{data}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {message.role === 'user' && (
              <div className="flex-shrink-0 mt-1">
                <User className="h-5 w-5 text-text-secondary" />
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3 justify-start">
            <div className="flex-shrink-0 mt-1">
              <Bot className="h-5 w-5 text-text-secondary" />
            </div>
            <div className="flex items-center gap-2 bg-bg-tertiary/50 rounded-2xl rounded-tl-sm px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
              <span className="text-sm text-text-secondary">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="border-t border-border px-4 py-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); }}
            placeholder="Ask a question about your costs..."
            disabled={isLoading}
            className="flex-1 h-10 rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-secondary outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <Button
            type="submit"
            size="icon"
            disabled={inputValue.trim() === '' || isLoading}
            className="h-10 w-10 flex-shrink-0"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
