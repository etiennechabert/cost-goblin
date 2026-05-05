import { useState } from 'react';
import { Check, Copy, Sparkles } from 'lucide-react';

const MCP_PORT = 19532;
const MCP_URL = `http://localhost:${String(MCP_PORT)}/mcp`;

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

const CLAUDE_CONFIG = JSON.stringify({
  mcpServers: {
    costgoblin: {
      type: 'streamable-http',
      url: MCP_URL,
    },
  },
}, null, 2);

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
    title: 'Tag coverage',
    prompt: 'Which resources are missing the "team" tag and how much do they cost?',
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
    title: 'Custom SQL',
    prompt: 'Run a SQL query to find the top 10 most expensive resources by daily average cost.',
  },
];

const PROVIDERS: { name: string; configLabel: string; config: string; docs: string }[] = [
  {
    name: 'Claude Desktop',
    configLabel: 'claude_desktop_config.json',
    config: CLAUDE_CONFIG,
    docs: 'Add to your Claude Desktop config file:',
  },
  {
    name: 'Claude Code',
    configLabel: '.mcp.json',
    config: JSON.stringify({
      mcpServers: {
        costgoblin: {
          type: 'streamable-http',
          url: MCP_URL,
        },
      },
    }, null, 2),
    docs: 'Add to your project .mcp.json or run:',
  },
  {
    name: 'Cursor / Windsurf',
    configLabel: 'MCP settings',
    config: JSON.stringify({
      mcpServers: {
        costgoblin: {
          type: 'streamable-http',
          url: MCP_URL,
        },
      },
    }, null, 2),
    docs: 'Add to your editor MCP settings:',
  },
];

export function McpView() {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

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
        <div className="flex items-center gap-3">
          <span className="flex h-2.5 w-2.5 rounded-full bg-accent animate-pulse" />
          <div>
            <p className="text-sm font-medium text-text-primary">MCP server running</p>
            <p className="text-xs text-text-muted font-mono mt-0.5">{MCP_URL}</p>
          </div>
        </div>
      </div>

      {/* Setup */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Connect your AI assistant</h3>
        <div className="space-y-2">
          {PROVIDERS.map((provider) => {
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
