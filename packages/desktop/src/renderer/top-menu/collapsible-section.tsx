import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface Props {
  title: string;
  defaultOpen?: boolean;
  indicator?: ReactNode;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  indicator,
  children,
}: Readonly<Props>): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => { setOpen(prev => !prev); }}
        className="flex w-full items-center justify-between px-2 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted hover:text-text-secondary transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          {title}
          {indicator}
        </span>
        <ChevronDown
          size={12}
          className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
        />
      </button>
      {open && <div className="pb-1 pt-0.5">{children}</div>}
    </div>
  );
}
