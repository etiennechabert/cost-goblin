import { useState, useMemo } from 'react';
import { ChevronDown, Star, LayoutDashboard } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@costgoblin/ui';

export interface DashboardItem {
  readonly id: string;
  readonly name: string;
}

interface Props {
  items: readonly DashboardItem[];
  activeId: string | null;
  defaultId: string;
  onSelect: (id: string) => void;
  onSetDefault: (id: string) => void;
}

export function DashboardsDropdown({
  items,
  activeId,
  defaultId,
  onSelect,
  onSetDefault,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => {
    const def = items.find(i => i.id === defaultId);
    const rest = items.filter(i => i.id !== defaultId);
    return def === undefined ? rest : [def, ...rest];
  }, [items, defaultId]);

  const activeIsCustom = items.some(i => i.id === activeId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={[
            'flex items-center rounded-md transition-colors [-webkit-app-region:no-drag]',
            activeIsCustom
              ? 'gap-1.5 px-3 py-1.5 text-sm font-medium bg-bg-tertiary text-text-primary'
              : 'gap-1 p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
          ].join(' ')}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={activeIsCustom ? undefined : 'Dashboards'}
          title={activeIsCustom ? undefined : 'Dashboards'}
        >
          {activeIsCustom ? 'Dashboards' : <LayoutDashboard size={18} />}
          <ChevronDown
            size={activeIsCustom ? 14 : 12}
            className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <ul className="flex flex-col" role="menu">
          {sorted.map((item) => {
            const isDefault = item.id === defaultId;
            const isActive = item.id === activeId;
            return (
              <li key={item.id} className="flex items-stretch gap-0.5" role="none">
                <button
                  type="button"
                  onClick={() => { onSetDefault(item.id); }}
                  className={[
                    'flex items-center justify-center rounded-md w-7 transition-colors',
                    isDefault
                      ? 'text-accent'
                      : 'text-text-muted hover:text-accent hover:bg-bg-tertiary/50',
                  ].join(' ')}
                  aria-label={isDefault ? `${item.name} is the default dashboard` : `Set ${item.name} as default`}
                  title={isDefault ? 'Default dashboard' : 'Set as default'}
                  disabled={isDefault}
                >
                  <Star
                    size={14}
                    fill={isDefault ? 'currentColor' : 'none'}
                  />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(item.id);
                    setOpen(false);
                  }}
                  className={[
                    'flex-1 text-left px-2 py-1.5 text-sm rounded-md transition-colors',
                    isActive
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                  ].join(' ')}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item.name}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
