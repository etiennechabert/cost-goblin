import { Sparkles, AlertCircle, ExternalLink, CheckCircle2, Loader2 } from 'lucide-react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { AIChat } from '../components/ai-chat.js';
import type { OllamaStatus, AIModel, AIPreferences } from '@costgoblin/core/browser';

function SetupInstructions({ status }: Readonly<{ status: OllamaStatus }>) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="max-w-2xl w-full space-y-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="rounded-full bg-negative/10 p-3">
            <AlertCircle className="h-8 w-8 text-negative" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-text-primary">Ollama Not Connected</h2>
            <p className="text-sm text-text-secondary mt-1">
              {status.state === 'disconnected' ? status.error : 'Could not reach Ollama service'}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-bg-secondary p-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-text-primary mb-2">Getting Started</h3>
            <p className="text-sm text-text-secondary">
              CostGoblin uses Ollama to run AI models locally on your machine. This keeps your billing data private — no cloud API calls.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent">
                1
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">Install Ollama</p>
                <p className="text-xs text-text-secondary mt-1">
                  Download and install Ollama from the official website
                </p>
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover mt-2"
                >
                  <span>ollama.com/download</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent">
                2
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">Start Ollama Service</p>
                <p className="text-xs text-text-secondary mt-1">
                  Run the Ollama service in the background
                </p>
                <code className="block mt-2 px-3 py-2 bg-bg-tertiary/50 rounded text-xs font-mono text-text-primary">
                  ollama serve
                </code>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent">
                3
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">Download a Model</p>
                <p className="text-xs text-text-secondary mt-1">
                  Pull a model optimized for cost analysis. Recommended: llama3.2 (small, fast)
                </p>
                <code className="block mt-2 px-3 py-2 bg-bg-tertiary/50 rounded text-xs font-mono text-text-primary">
                  ollama pull llama3.2
                </code>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center text-xs font-bold text-accent">
                4
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">Refresh This Page</p>
                <p className="text-xs text-text-secondary mt-1">
                  Once Ollama is running and you have a model downloaded, refresh to connect
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-bg-tertiary/30 px-4 py-3">
          <p className="text-xs text-text-muted">
            <strong className="text-text-primary">Privacy-first:</strong> All AI inference runs locally on your machine. Your billing data never leaves your computer. Ollama connects to localhost:11434 only.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectionStatus({ status, models, preferences }: Readonly<{
  status: OllamaStatus;
  models: readonly AIModel[];
  preferences: AIPreferences | null;
}>) {
  const isConnected = status.state === 'connected';

  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-bg-secondary">
      <div className="flex items-center gap-3">
        <Sparkles className={`h-5 w-5 ${isConnected ? 'text-accent' : 'text-negative'}`} />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-text-primary">AI Insights</h1>
            <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
              isConnected
                ? 'bg-positive/10 text-positive'
                : 'bg-negative/10 text-negative'
            }`}>
              {isConnected ? (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  <span>Connected</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-3 w-3" />
                  <span>Disconnected</span>
                </>
              )}
            </div>
          </div>
          {isConnected && (
            <p className="text-xs text-text-secondary mt-0.5">
              {models.length} {models.length === 1 ? 'model' : 'models'} available
              {preferences !== null && preferences.defaultModel !== null && ` • Using ${preferences.defaultModel}`}
            </p>
          )}
        </div>
      </div>
      {status.state === 'connected' && (
        <div className="text-xs text-text-muted">
          Ollama {status.version}
        </div>
      )}
    </div>
  );
}

export function AIInsights() {
  const api = useCostApi();
  const statusQuery = useQuery(() => api.getOllamaStatus(), [api]);
  const modelsQuery = useQuery(() => api.listAIModels(), [api]);
  const prefsQuery = useQuery(() => api.getAIPreferences(), [api]);

  const status = statusQuery.status === 'success' ? statusQuery.data : null;
  const models = modelsQuery.status === 'success' ? modelsQuery.data : [];
  const preferences = prefsQuery.status === 'success' ? prefsQuery.data : null;

  const isLoading = statusQuery.status === 'loading' || statusQuery.status === 'idle';
  const isConnected = status !== null && status.state === 'connected';

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center h-full">
          <div className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
            <span className="text-sm text-text-secondary">Checking Ollama connection...</span>
          </div>
        </div>
      </div>
    );
  }

  if (status === null) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-3">
            <AlertCircle className="h-12 w-12 text-negative" />
            <p className="text-sm text-text-secondary">Failed to check Ollama status</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ConnectionStatus status={status} models={models} preferences={preferences} />
      {!isConnected ? (
        <SetupInstructions status={status} />
      ) : models.length === 0 ? (
        <div className="flex items-center justify-center h-full px-6">
          <div className="max-w-lg text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-warning mx-auto" />
            <div>
              <h2 className="text-xl font-bold text-text-primary mb-2">No Models Found</h2>
              <p className="text-sm text-text-secondary mb-4">
                Ollama is running, but no models are installed. Download a model to start using AI insights.
              </p>
              <code className="block px-4 py-3 bg-bg-tertiary/50 rounded text-xs font-mono text-text-primary">
                ollama pull llama3.2
              </code>
              <p className="text-xs text-text-muted mt-3">
                Recommended models: llama3.2 (fast), mistral (balanced), llama3:70b (most capable)
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 p-6 overflow-hidden">
          <AIChat />
        </div>
      )}
    </div>
  );
}
