import type { Table } from '@tanstack/react-table';
import { Settings2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';

/** Column visibility toggle dropdown for TanStack Table.
 *  Displays a Settings icon button that opens a dropdown menu with checkboxes
 *  for each column. Clicking a checkbox toggles that column's visibility.
 *
 *  Works with any TanStack Table instance that has columnVisibility state
 *  and onColumnVisibilityChange callback configured. */
export interface ColumnVisibilityToggleProps<TData> {
  /** TanStack Table instance */
  readonly table: Table<TData>;
  /** Optional className for the trigger button */
  readonly className?: string | undefined;
}

export function ColumnVisibilityToggle<TData>({
  table,
  className,
}: Readonly<ColumnVisibilityToggleProps<TData>>): React.JSX.Element {
  const columns = table.getAllColumns().filter(col => col.getCanHide());

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={className}>
          <Settings2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map(column => {
          const columnId = column.id;
          const header = typeof column.columnDef.header === 'string'
            ? column.columnDef.header
            : columnId;

          return (
            <DropdownMenuCheckboxItem
              key={columnId}
              checked={column.getIsVisible()}
              onCheckedChange={(value) => { column.toggleVisibility(value); }}
            >
              {header}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
