import * as React from 'react';
import { cn } from '../../lib/utils.js';

type CommandContextValue = {
  search: string;
  setSearch: (search: string) => void;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  itemCount: number;
  setItemCount: (count: number) => void;
};

const CommandContext = React.createContext<CommandContextValue | null>(null);

function useCommandContext(): CommandContextValue {
  const ctx = React.useContext(CommandContext);
  if (ctx === null) {
    throw new Error('Command components must be used within Command');
  }
  return ctx;
}

export const Command = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
    const [search, setSearch] = React.useState('');
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const [itemCount, setItemCount] = React.useState(0);

    const value = React.useMemo<CommandContextValue>(
      () => ({
        search,
        setSearch,
        selectedIndex,
        setSelectedIndex,
        itemCount,
        setItemCount,
      }),
      [search, selectedIndex, itemCount],
    );

    return (
      <CommandContext.Provider value={value}>
        <div
          ref={ref}
          className={cn(
            'flex h-full w-full flex-col overflow-hidden rounded-lg bg-bg-secondary text-text-primary',
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </CommandContext.Provider>
    );
  },
);
Command.displayName = 'Command';

export const CommandInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => {
  const { search, setSearch, setSelectedIndex } = useCommandContext();

  return (
    <div className="flex items-center border-b border-border px-3">
      <input
        ref={ref}
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setSelectedIndex(0);
        }}
        className={cn(
          'flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
});
CommandInput.displayName = 'CommandInput';

export interface CommandListProps extends React.HTMLAttributes<HTMLDivElement> {
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

export const CommandList = React.forwardRef<HTMLDivElement, CommandListProps>(
  ({ className, children, onKeyDown, ...props }, ref) => {
    const { selectedIndex, setSelectedIndex, itemCount } = useCommandContext();

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex(Math.min(selectedIndex + 1, itemCount - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex(Math.max(selectedIndex - 1, 0));
        }
        onKeyDown?.(e);
      },
      [selectedIndex, setSelectedIndex, itemCount, onKeyDown],
    );

    return (
      <div
        ref={ref}
        role="listbox"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden', className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);
CommandList.displayName = 'CommandList';

export const CommandEmpty = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('py-6 text-center text-sm text-text-muted', className)}
        {...props}
      />
    );
  },
);
CommandEmpty.displayName = 'CommandEmpty';

export interface CommandGroupProps
  extends React.HTMLAttributes<HTMLDivElement> {
  heading?: string;
}

export const CommandGroup = React.forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ className, heading, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="group"
        className={cn('overflow-hidden p-1', className)}
        {...props}
      >
        {heading !== undefined && (
          <div className="px-2 py-1.5 text-xs font-medium text-text-muted">
            {heading}
          </div>
        )}
        {children}
      </div>
    );
  },
);
CommandGroup.displayName = 'CommandGroup';

export interface CommandItemProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value?: string;
  onSelect?: (value: string) => void;
  disabled?: boolean;
}

export const CommandItem = React.forwardRef<HTMLDivElement, CommandItemProps>(
  ({ className, value, onSelect, disabled = false, children, ...props }, ref) => {
    const { selectedIndex, setItemCount } = useCommandContext();
    const itemRef = React.useRef<HTMLDivElement>(null);
    const [itemIndex, setItemIndex] = React.useState(-1);

    React.useEffect(() => {
      const currentRef = itemRef.current;
      if (currentRef === null) return;

      const parent = currentRef.parentElement;
      if (parent === null) return;

      const items = Array.from(parent.querySelectorAll('[role="option"]'));
      const index = items.indexOf(currentRef);
      setItemIndex(index);
      setItemCount(items.length);
    }, [setItemCount]);

    React.useEffect(() => {
      if (itemIndex === selectedIndex && itemRef.current !== null) {
        itemRef.current.scrollIntoView({ block: 'nearest' });
      }
    }, [itemIndex, selectedIndex]);

    const isSelected = itemIndex === selectedIndex;

    const handleClick = React.useCallback(() => {
      if (disabled) return;
      if (value !== undefined && onSelect !== undefined) {
        onSelect(value);
      }
    }, [disabled, value, onSelect]);

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' && isSelected && !disabled) {
          e.preventDefault();
          if (value !== undefined && onSelect !== undefined) {
            onSelect(value);
          }
        }
      },
      [isSelected, disabled, value, onSelect],
    );

    return (
      <div
        ref={(node) => {
          itemRef.current = node;
          if (typeof ref === 'function') {
            ref(node);
          } else if (ref !== null) {
            ref.current = node;
          }
        }}
        role="option"
        aria-selected={isSelected}
        aria-disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
          isSelected && !disabled
            ? 'bg-accent-muted text-accent'
            : 'hover:bg-bg-tertiary hover:text-text-primary',
          disabled && 'pointer-events-none opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
CommandItem.displayName = 'CommandItem';

export const CommandSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      role="separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
});
CommandSeparator.displayName = 'CommandSeparator';
