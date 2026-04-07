import type { Dimension } from '@costgoblin/core/browser';
import { getDimensionId } from '../lib/dimensions.js';

interface DimensionSelectorProps {
  dimensions: Dimension[];
  selected: string;
  onSelect: (id: string) => void;
}

export function DimensionSelector({ dimensions, selected, onSelect }: DimensionSelectorProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-1">
      {dimensions.map((dim) => {
        const id = getDimensionId(dim);
        const isSelected = selected === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => { onSelect(id); }}
            className={[
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              isSelected
                ? 'bg-bg-secondary text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {dim.label}
          </button>
        );
      })}
    </div>
  );
}
