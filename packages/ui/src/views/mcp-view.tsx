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

/** URL with the token as a query param, for clients that only accept a URL and
 *  can't set an Authorization header. */
function buildUrlWithToken(token: string): string {
  return `${MCP_URL}?token=${token}`;
}

function CopyButton({ text }: Readonly<{ text: string }>) {
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
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
    </button>
  );
}

function CodeBlock({ children }: Readonly<{ children: string }>) {
  return (
    <div className="relative">
      <CopyButton text={children} />
      <pre className="rounded-lg bg-bg-primary border border-border p-4 pr-12 text-sm text-text-secondary overflow-x-auto font-mono">
        {children}
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

function buildProviders(token: string): { name: string; config: string; docs: string }[] {
  return [
    {
      name: 'Claude / Cursor / Windsurf',
      config: buildJsonConfig(token),
      docs: 'Add to claude_desktop_config.json, .mcp.json, or your editor MCP settings:',
    },
    {
      name: 'ChatGPT',
      config: buildUrlWithToken(token),
      docs: 'In ChatGPT \u2192 Settings \u2192 Add MCP server, paste this URL (token included):',
    },
    {
      name: 'Gemini',
      config: buildUrlWithToken(token),
      docs: 'In Gemini \u2192 Settings \u2192 Extensions \u2192 Add MCP server, paste this URL (token included):',
    },
  ];
}

export function McpView() {
  const api = useCostApi();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [token, setToken] = useState('');
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    api.getMcpServerRunning().then(setRunning).catch(() => undefined);
    api.getMcpToken().then(setToken).catch(() => undefined);
  }, [api]);

  const handleToggle = useCallback(() => {
    setToggling(true);
    const next = !running;
    api.setMcpServerRunning(next).then(() => {
      setRunning(next);
      setToggling(false);
    }).catch(() => undefined);
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

  const providers = useMemo(() => buildProviders(token), [token]);

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
            <span className={`flex h-2.5 w-2.5 rounded-full ${running ? 'bg-accent animate-pulse' : 'bg-text-muted'}`} />
            <div>
              <p className="text-sm font-medium text-text-primary">
                MCP server {running ? 'running' : 'stopped'}
              </p>
              {running && <p className="text-xs text-text-muted font-mono mt-0.5">{MCP_URL}</p>}
            </div>
          </div>
          <button
            type="button"
            disabled={toggling}
            onClick={handleToggle}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors disabled:opacity-50"
          >
            {running ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>

      {/* Access token */}
      <div className="rounded-xl border border-border bg-bg-secondary/50 p-5">
        <div className="flex items-center gap-2 mb-1.5">
          <KeyRound className="size-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Access token</h3>
        </div>
        <p className="text-xs text-text-secondary mb-3">
          Every request to the server must include this token, so only apps you&rsquo;ve configured can reach your billing data. It&rsquo;s already baked into the configs below. Keep it private &mdash; anyone with it (and access to this machine) can query your costs.
        </p>
        <div className="relative">
          {token.length > 0 && <CopyButton text={token} />}
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
          {providers.map((provider) => {
            const isExpanded = expandedProvider === provider.name;
            return (
              <div key={provider.name} className="rounded-lg border border-border bg-bg-secondary/50 overflow-hidden">
                <button
                  type="button"
                  onClick={() => { setExpandedProvider(isExpanded ? null : provider.name); }}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-tertiary/30 transition-colors"
                >
                  <span className="text-sm font-medium text-text-primary">{provider.name}</span>
                  <span className="text-xs text-text-muted">{isExpanded ? 'Hide' : 'Show config'}</span>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-2">
                    <p className="text-xs text-text-secondary">{provider.docs}</p>
                    <CodeBlock>{provider.config}</CodeBlock>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
