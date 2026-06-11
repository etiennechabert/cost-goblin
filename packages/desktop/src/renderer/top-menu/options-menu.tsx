import { useState, type ReactNode } from 'react';
import {
  Menu,
  Sun,
  Moon,
  Palette,
  Share2,
  Sparkles,
  Download,
  FileUp,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@costgoblin/ui';
import type { UpdateStatus } from '@costgoblin/core/browser';
import { CollapsibleSection } from './collapsible-section.js';

interface Props {
  isDark: boolean;
  onToggleTheme: () => void;
  palette: 'standard' | 'colorblind';
  onTogglePalette: () => void;
  activeNavId: string | null;
  onNavigate: (id: string) => void;
  updateStatus: UpdateStatus;
  onShowReleaseNotes: () => void;
  onCheckForUpdates: () => void;
  onShareConfig: () => void;
  onImportConfig: () => void;
}

function hasUpdateIndicator(status: UpdateStatus): boolean {
  return status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded';
}

interface MenuItemProps {
  onClick: () => void;
  active?: boolean;
  icon?: ReactNode;
  label: string;
  trailing?: ReactNode;
}

function MenuItem({ onClick, active, icon, label, trailing }: Readonly<MenuItemProps>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors',
        active === true
          ? 'bg-bg-tertiary text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
      ].join(' ')}
      aria-current={active === true ? 'page' : undefined}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}

export function OptionsMenu({
  isDark,
  onToggleTheme,
  palette,
  onTogglePalette,
  activeNavId,
  onNavigate,
  updateStatus,
  onShowReleaseNotes,
  onCheckForUpdates,
  onShareConfig,
  onImportConfig,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const indicator = hasUpdateIndicator(updateStatus);

  function close() { setOpen(false); }

  function renderUpdateItem(): React.JSX.Element {
    if (updateStatus.state === 'available') {
      return (
        <MenuItem
          onClick={() => { onShowReleaseNotes(); close(); }}
          icon={<Download size={16} />}
          label={`v${updateStatus.info.version} available`}
        />
      );
    }
    if (updateStatus.state === 'downloading') {
      return (
        <MenuItem
          onClick={() => { onShowReleaseNotes(); close(); }}
          icon={<RefreshCw size={16} className="animate-spin" />}
          label={`Downloading ${String(updateStatus.percent)}%`}
        />
      );
    }
    if (updateStatus.state === 'downloaded') {
      return (
        <MenuItem
          onClick={() => { onShowReleaseNotes(); close(); }}
          icon={<Download size={16} />}
          label="Restart to install"
        />
      );
    }
    if (updateStatus.state === 'checking') {
      return (
        <MenuItem
          onClick={() => { /* no-op while checking */ }}
          icon={<RefreshCw size={16} className="animate-spin" />}
          label="Checking for updates..."
        />
      );
    }
    return (
      <MenuItem
        onClick={() => { onCheckForUpdates(); }}
        icon={<RotateCw size={16} />}
        label={updateStatus.state === 'error' ? 'Retry update check' : 'Check for updates'}
      />
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary [-webkit-app-region:no-drag]"
          aria-label="Options"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Menu size={16} />
          {indicator && (
            <span
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent"
              aria-label="update available"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <CollapsibleSection title="Appearance">
          <MenuItem
            onClick={() => { onToggleTheme(); }}
            icon={isDark ? <Sun size={16} /> : <Moon size={16} />}
            label={isDark ? 'Light mode' : 'Dark mode'}
          />
          <MenuItem
            onClick={() => { onTogglePalette(); }}
            icon={<Palette size={16} />}
            label={palette === 'standard' ? 'Colorblind palette' : 'Standard palette'}
          />
        </CollapsibleSection>
        <CollapsibleSection title="Configuration">
          <MenuItem
            onClick={() => { onNavigate('cost-scope'); close(); }}
            active={activeNavId === 'cost-scope'}
            label="Cost Scope"
          />
          <MenuItem
            onClick={() => { onNavigate('dimensions'); close(); }}
            active={activeNavId === 'dimensions'}
            label="Dimensions"
          />
          <MenuItem
            onClick={() => { onNavigate('views-editor'); close(); }}
            active={activeNavId === 'views-editor'}
            label="Views Editor"
          />
        </CollapsibleSection>
        <CollapsibleSection title="Sharing">
          <MenuItem
            onClick={() => { onShareConfig(); close(); }}
            icon={<Share2 size={16} />}
            label="Share configuration…"
          />
          <MenuItem
            onClick={() => { onImportConfig(); close(); }}
            icon={<FileUp size={16} />}
            label="Import configuration…"
          />
        </CollapsibleSection>
        <CollapsibleSection title="Tools">
          <MenuItem
            onClick={() => { onNavigate('mcp'); close(); }}
            active={activeNavId === 'mcp'}
            icon={<Sparkles size={16} />}
            label="AI Assistant"
          />
        </CollapsibleSection>
        <CollapsibleSection
          title="Updates"
          indicator={indicator ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        >
          {renderUpdateItem()}
        </CollapsibleSection>
      </PopoverContent>
    </Popover>
  );
}
