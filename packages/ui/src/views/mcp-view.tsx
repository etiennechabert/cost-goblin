import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, Sparkles } from 'lucide-react';

import { useCostApi } from '../hooks/use-cost-api.js';

const MCP_PORT = 19532;
const MCP_URL = `http://localhost:${String(MCP_PORT)}/mcp`;
const TOKEN_MASK = '•'.repeat(28);

function buildJsonConfig(token: string): string {
  return JSON.stringify({
    mcpServers: {
      costgoblin: {
        type: 'streamable-http',
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

/** Gemini CLI settings.json: `httpUrl` selects the Streamable HTTP transport. */
function buildGeminiConfig(token: string): string {
  return JSON.stringify({
    mcpServers: {
      costgoblin: {
        httpUrl: MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

function CopyButton({ text, label }: Readonly<{ text: string; label: string }>) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 rounded-md p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
      aria-label={label}
    >
      {copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
    </button>
  );
}

/** A config snippet. `display` is what's on screen (token masked unless
 *  revealed); `copyText` is what Copy writes, always with the real token, or
 *  null while the token hasn't loaded (no Copy button then). */
function CodeBlock({ display, copyText, copyLabel }: Readonly<{ display: string; copyText: string | null; copyLabel: string }>) {
  return (
    <div className="relative">
      {copyText !== null && <CopyButton text={copyText} label={copyLabel} />}
      <pre className="rounded-lg bg-bg-primary border border-border p-4 pr-12 text-sm text-text-secondary overflow-x-auto font-mono">
        {display}
      </pre>
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  {
    title: 'Cost overview',
    prompt: 'What are my top 5 AWS services by cost this month?',
  },
  {
    title: 'Anomaly detection',
    prompt: 'Compare my costs this week vs last week. What changed the most?',
  },
  {
    title: 'Tag quality',
    prompt: 'Analyze my tag coverage and suggest tag groupings to better allocate costs by team.',
  },
  {
    title: 'Deep dive',
    prompt: 'Break down my EC2 costs by account and region for the last 30 days.',
  },
  {
    title: 'Cost optimization',
    prompt: 'Show me services where spending increased more than 20% compared to last month.',
  },
  {
    title: 'Spending report',
    prompt: 'Generate a full overview of my cloud spending: top services, trends, anomalies, and recommendations.',
  },
];

interface Provider {
  readonly name: string;
  readonly docs: string;
  readonly render: (token: string) => string;
}

// Only clients that can send an Authorization header are listed: the server
// never accepts the token from the URL.
const PROVIDERS: readonly Provider[] = [
  {
    name: 'Claude / Cursor / Windsurf',
    docs: 'Add to claude_desktop_config.json, .mcp.json, or your editor MCP settings:',
    render: buildJsonConfig,
  },
  {
    name: 'Gemini CLI',
    docs: 'Add to ~/.gemini/settings.json (or .gemini/settings.json in a project):',
    render: buildGeminiConfig,
  },
];

type ServerState = boolean | null;

export function McpView() {
  const api = useCostApi();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  // null until the first query answers: never claim "running" (or "stopped")
  // before the main process has said so.
  const [running, setRunning] = useState<ServerState>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    api.getMcpServerRunning().then(setRunning).catch(() => { setRunning(false); });
    api.getMcpToken().then(setToken).catch(() => undefined);
  }, [api]);

  const handleToggle = useCallback(() => {
    if (running === null) return;
    const next = !running;
    setToggling(true);
    setToggleError(null);
    api.setMcpServerRunning(next).then(() => {
      setRunning(next);
    }).catch((err: unknown) => {
      setToggleError(err instanceof Error ? err.message : String(err));
      // The main process knows the real state (a failed Enable leaves it off).
      api.getMcpServerRunning().then(setRunning).catch(() => { setRunning(false); });
    }).finally(() => {
      setToggling(false);
    });
  }, [api, running]);

  const handleRegenerate = useCallback(() => {
    setRegenerating(true);
    api.regenerateMcpToken().then((next) => {
      setToken(next);
      setTokenRevealed(true);
    }).catch(() => undefined).finally(() => {
      setRegenerating(false);
      setConfirmingRegen(false);
    });
  }, [api]);

  const snippets = useMemo(() => PROVIDERS.map((provider) => ({
    name: provider.name,
    docs: provider.docs,
    display: provider.render(tokenRevealed ? token : TOKEN_MASK),
    copyText: token.length > 0 ? provider.render(token) : null,
  })), [token, tokenRevealed]);

  let statusLabel: string;
  if (running === null) statusLabel = 'Checking…';
  else if (running) statusLabel = 'MCP server running';
  else statusLabel = 'MCP server stopped';

  let tokenDisplay: string;
  if (token.length === 0) tokenDisplay = 'Loading…';
  else if (tokenRevealed) tokenDisplay = token;
  else tokenDisplay = TOKEN_MASK;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto">
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-accent" />
          <h2 className="text-xl font-semibold text-text-primary">AI Assistant</h2>
        </div>
        <p className="text-sm text-text-secondary mt-1">
          CostGoblin includes a built-in MCP server that lets AI assistants query your billing data directly.
        </p>
      </div>

      {/* Status */}
      <div className="rounded-xl border border-border bg-bg-secondary/50 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`flex h-2.5 w-2.5 rounded-full ${running === true ? 'bg-accent animate-pulse' : 'bg-text-muted'}`} />
            <div>
              <p className="text-sm font-medium text-text-primary">
                {statusLabel}
              </p>
              {running === true && <p className="text-xs text-text-muted font-mono mt-0.5">{MCP_URL}</p>}
            </div>
          </div>
          <button
            type="button"
            disabled={toggling || running === null}
            onClick={handleToggle}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors disabled:opacity-50"
          >
            {running === true ? 'Disable' : 'Enable'}
          </button>
        </div>
        <p className="text-xs text-text-secondary mt-3">
          Off by default. Once enabled, the server starts automatically each time CostGoblin launches.
        </p>
        {toggleError !== null && (
          <p role="alert" className="text-xs text-negative mt-2 break-words">{toggleError}</p>
        )}
      </div>

      {/* Access token */}
      <div className="rounded-xl border border-border bg-bg-secondary/50 p-5">
        <div className="flex items-center gap-2 mb-1.5">
          <KeyRound className="size-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Access token</h3>
        </div>
        <p className="text-xs text-text-secondary mb-3">
          Every request to the server must send this token in an <code className="font-mono">Authorization: Bearer</code> header, so only apps you&rsquo;ve configured can reach your billing data. The configs below include it: it stays hidden on screen until you click Reveal, and Copy always copies the real value. Keep it private &mdash; anyone with it (and access to this machine) can query your costs.
        </p>
        <div className="relative">
          {token.length > 0 && <CopyButton text={token} label="Copy token" />}
          <pre className="rounded-lg bg-bg-primary border border-border p-4 pr-12 text-sm text-text-secondary overflow-x-auto font-mono">
            {tokenDisplay}
          </pre>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => { setTokenRevealed((v) => !v); }}
            disabled={token.length === 0}
            className="text-xs px-2.5 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors disabled:opacity-50"
          >
            {tokenRevealed ? 'Hide' : 'Reveal'}
          </button>
          {confirmingRegen ? (
            <>
              <span className="text-xs text-text-secondary">Existing clients will stop working until updated.</span>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={regenerating}
                className="text-xs px-2.5 py-1 rounded-md border border-negative/50 text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
              >
                {regenerating ? 'Regenerating…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmingRegen(false); }}
                className="text-xs px-2.5 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { setConfirmingRegen(true); }}
              disabled={token.length === 0}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="size-3" />
              Regenerate
            </button>
          )}
        </div>
      </div>

      {/* Setup */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Connect your AI assistant</h3>
        <div className="space-y-2">
          {snippets.map((snippet) => {
            const isExpanded = expandedProvider === snippet.name;
            return (
              <div key={snippet.name} className="rounded-lg border border-border bg-bg-secondary/50 overflow-hidden">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => { setExpandedProvider(isExpanded ? null : snippet.name); }}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-tertiary/30 transition-colors"
                >
                  <span className="text-sm font-medium text-text-primary">{snippet.name}</span>
                  <span className="text-xs text-text-muted">{isExpanded ? 'Hide' : 'Show config'}</span>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-2">
                    <p className="text-xs text-text-secondary">{snippet.docs}</p>
                    <CodeBlock display={snippet.display} copyText={snippet.copyText} copyLabel={`Copy ${snippet.name} config`} />
                    {!tokenRevealed && snippet.copyText !== null && (
                      <p className="text-xs text-text-muted">Token hidden. Copy includes it, or click Reveal above.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-text-muted mt-3">
          ChatGPT and other cloud-hosted assistants can&rsquo;t reach this server: it listens only on this computer&rsquo;s loopback address.
        </p>
      </div>

      {/* Available tools */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Available tools</h3>
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {[
              ['get_cost_overview', 'High-level cost summary'],
              ['query_costs', 'Break down by dimension'],
              ['query_daily_costs', 'Daily/weekly time series'],
              ['query_trends', 'Period-over-period changes'],
              ['query_entity_detail', 'Deep dive on one entity'],
              ['query_missing_tags', 'Find untagged resources'],
              ['list_dimensions', 'Available group-by fields'],
              ['get_filter_values', 'Values for a dimension'],
              ['explore_data', 'Browse raw line items'],
              ['run_sql', 'Ad-hoc SQL queries'],
            ].map(([name, desc]) => (
              <div key={name} className="flex items-baseline gap-2 py-1">
                <code className="text-xs font-mono text-accent shrink-0">{name}</code>
                <span className="text-xs text-text-muted truncate">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Example prompts */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Example prompts</h3>
        <div className="grid grid-cols-2 gap-3">
          {EXAMPLE_PROMPTS.map((ex) => (
            <div key={ex.title} className="rounded-lg border border-border bg-bg-secondary/50 p-3">
              <p className="text-xs font-medium text-text-secondary mb-1">{ex.title}</p>
              <p className="text-sm text-text-primary leading-snug">&ldquo;{ex.prompt}&rdquo;</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
