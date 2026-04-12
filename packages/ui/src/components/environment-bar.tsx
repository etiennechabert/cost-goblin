import { formatDollars } from './format.js';

interface Environment {
  name: string;
  cost: number;
}

interface EnvironmentBarProps {
  environments: Environment[];
  selected: string | null;
  onSelect: (env: string | null) => void;
}

export function EnvironmentBar({ environments, selected, onSelect }: Readonly<EnvironmentBarProps>) {
  function handleClick(name: string) {
    onSelect(selected === name ? null : name);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {environments.map((env) => {
        const isSelected = selected === env.name;
        return (
          <button
            key={env.name}
            type="button"
            onClick={() => { handleClick(env.name); }}
            className={[
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              isSelected
                ? 'border-accent bg-accent-muted text-accent'
                : 'border-border bg-bg-tertiary/20 text-text-secondary hover:border-border hover:text-text-primary',
            ].join(' ')}
          >
            <span className="capitalize">{env.name}</span>
            <span className="text-text-secondary">·</span>
            <span className={isSelected ? 'text-accent' : 'text-text-secondary'}>
              {formatDollars(env.cost)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
