import { Settings2, Database, Target, Tags, LayoutDashboard, Share2, FileDown, Sparkles, Gauge } from 'lucide-react';

/** The settings surface is "setting mode": a full-canvas, tabbed workspace that
 *  is deliberately separate from "view mode" (looking at cost data). Every
 *  configuration page lives behind one of these tab ids — and this registry is
 *  the SINGLE source of truth for the tab list, ordering, labels and icons.
 *
 *  It drives (a) the left rail in `SettingsShell`, (b) the command-palette
 *  "Settings" group, and (c) the host's render switch. Adding a settings page
 *  means adding one entry here — not editing six hand-synced sites. */
export type SettingsTabId =
  | 'general'
  | 'data-sync'
  | 'cost-scope'
  | 'dimensions'
  | 'dashboards'
  | 'share'
  | 'import'
  | 'ai-assistant'
  | 'performance';

export interface SettingsTabMeta {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly Icon: React.ComponentType<{ size?: number | string; className?: string | undefined }>;
  /** Extra search terms so the command palette finds a tab by what it does,
   *  not just its label (e.g. "dark mode" → General, "memory" → Performance). */
  readonly keywords: readonly string[];
}

export const SETTINGS_TABS: readonly SettingsTabMeta[] = [
  {
    id: 'general',
    label: 'General',
    Icon: Settings2,
    keywords: ['appearance', 'theme', 'dark mode', 'light mode', 'palette', 'colorblind', 'default dashboard', 'updates', 'version'],
  },
  {
    id: 'data-sync',
    label: 'Data & Sync',
    Icon: Database,
    keywords: ['sync', 'aws', 's3', 'download', 'retention', 'organization', 'accounts', 'region', 'ssm', 'profile', 'setup', 'delete data', 'reload'],
  },
  {
    id: 'cost-scope',
    label: 'Cost Scope',
    Icon: Target,
    keywords: ['metric', 'amortized', 'unblended', 'on-demand', 'perspective', 'net', 'gross', 'exclusions', 'lag'],
  },
  {
    id: 'dimensions',
    label: 'Dimensions',
    Icon: Tags,
    keywords: ['tags', 'aliases', 'normalization', 'grouping', 'account tags'],
  },
  {
    id: 'dashboards',
    label: 'Dashboards',
    Icon: LayoutDashboard,
    keywords: ['views', 'widgets', 'dashboard editor', 'layout', 'charts'],
  },
  {
    id: 'share',
    label: 'Share',
    Icon: Share2,
    keywords: ['share', 'export', 'publish', 'beacon', 's3', 'network', 'peer', 'team', 'sharing key', 'configuration'],
  },
  {
    id: 'import',
    label: 'Import',
    Icon: FileDown,
    keywords: ['import', 'apply', 'bundle', 'restore', 'teammate', 'pull', 's3', 'configuration'],
  },
  {
    id: 'ai-assistant',
    label: 'AI Assistant',
    Icon: Sparkles,
    keywords: ['mcp', 'assistant', 'token', 'claude', 'chatgpt', 'gemini', 'llm', 'tools'],
  },
  {
    id: 'performance',
    label: 'Performance',
    Icon: Gauge,
    keywords: ['memory', 'threads', 'duckdb', 'tuning', 'cpu', 'ram'],
  },
];

const TAB_IDS: ReadonlySet<string> = new Set(SETTINGS_TABS.map(t => t.id));

/** Narrow an arbitrary string (e.g. a command-palette id) to a SettingsTabId. */
export function isSettingsTabId(id: string): id is SettingsTabId {
  return TAB_IDS.has(id);
}
