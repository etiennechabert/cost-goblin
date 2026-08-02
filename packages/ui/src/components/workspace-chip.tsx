import type { WorkspacesInfo } from '@costgoblin/core/browser';
import { Boxes, Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

export interface WorkspaceChipProps {
  /** Current workspaces state, loaded by the host at boot. */
  readonly info: WorkspacesInfo;
  /** Called with the target workspace name. The HOST owns the confirm dialog
   *  and the actual switch — the chip stays dumb. */
  readonly onSwitch: (name: string) => void;
  /** Open Settings → Workspaces. */
  readonly onManage: () => void;
}

/** Compact app-header chip showing the active workspace, with a dropdown to
 *  jump to another one. Renders nothing in pinned mode or when only a single
 *  workspace exists — the header stays clean for the common case. */
export function WorkspaceChip({ info, onSwitch, onManage }: Readonly<WorkspaceChipProps>): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (info.mode !== 'workspace' || info.workspaces.length < 2) return null;
  const activeName = info.active ?? info.workspaces.find(w => w.active)?.name ?? '—';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* no-drag: the chip sits in the draggable title-bar area — without the
            opt-out, clicks would drag the window instead of opening the menu. */}
        <button
          type="button"
          data-testid="workspace-chip"
          aria-label={`Workspace: ${activeName}`}
          className="[-webkit-app-region:no-drag] inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary/40 px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          <Boxes size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
          <span className="max-w-40 truncate font-mono">{activeName}</span>
          <ChevronDown size={12} className="shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-60 p-1 [-webkit-app-region:no-drag]">
        <div className="flex flex-col" role="group" aria-label="Workspaces">
          {info.workspaces.map(ws => (
            <button
              key={ws.name}
              type="button"
              disabled={ws.active}
              onClick={() => { setOpen(false); onSwitch(ws.name); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-primary hover:bg-bg-tertiary transition-colors disabled:cursor-default disabled:hover:bg-transparent"
            >
              <Check size={14} className={ws.active ? 'shrink-0 text-accent' : 'shrink-0 invisible'} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{ws.name}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => { setOpen(false); onManage(); }}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            Manage workspaces…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
