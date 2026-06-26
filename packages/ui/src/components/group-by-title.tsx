import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import type { Dimension, DimensionId } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';

interface GroupByTitleProps {
  readonly dimensions: readonly Dimension[];
  readonly currentGroupBy: DimensionId;
  readonly onGroupByChange: (id: DimensionId) => void;
  readonly label: string;
  readonly suffix?: string | undefined;
}

export function GroupByTitle({ dimensions, currentGroupBy, onGroupByChange, label, suffix }: GroupByTitleProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
        >
          {label}{suffix === undefined ? '' : ` ${suffix}`}
          <ChevronDown className="size-3.5 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {dimensions.map((dim) => {
          const id = getDimensionId(dim);
          const isActive = id === currentGroupBy;
          return (
            <button
              key={id}
              type="button"
              onClick={() => { onGroupByChange(id); setOpen(false); }}
              className={[
                'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors',
                isActive
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
              ].join(' ')}
            >
              {getDimensionLabel(dim)}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
