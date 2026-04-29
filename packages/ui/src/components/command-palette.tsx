import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
} from './ui/dialog.js';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './ui/command.js';

export interface CommandPaletteAction {
  id: string;
  label: string;
  onSelect: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandPaletteAction[];
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
}: Readonly<CommandPaletteProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');

  // Focus input when dialog opens and reset search
  useEffect(() => {
    if (open) {
      setSearch('');
      // Use setTimeout to ensure the dialog is fully rendered
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [open]);

  // Filter actions based on search query
  const filteredActions = actions.filter((action) => {
    if (search === '') return true;

    const searchLower = search.toLowerCase();
    const labelMatch = action.label.toLowerCase().includes(searchLower);
    const keywordsMatch =
      action.keywords !== undefined &&
      action.keywords.some((keyword) =>
        keyword.toLowerCase().includes(searchLower),
      );
    return labelMatch || keywordsMatch;
  });

  const handleSelect = (action: CommandPaletteAction) => {
    action.onSelect();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-2xl max-w-2xl">
        <Command>
          <CommandInput
            ref={inputRef}
            placeholder="Type a command or search..."
            className="h-12"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
          <CommandList>
            {filteredActions.length === 0 ? (
              <CommandEmpty>No results found.</CommandEmpty>
            ) : (
              <CommandGroup>
                {filteredActions.map((action) => (
                  <CommandItem
                    key={action.id}
                    value={action.id}
                    onSelect={() => {
                      handleSelect(action);
                    }}
                  >
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
