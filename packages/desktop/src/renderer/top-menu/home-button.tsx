import { Home } from 'lucide-react';

interface Props {
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
}

export function HomeButton({ isActive, onClick, tooltip }: Readonly<Props>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md p-1.5 transition-colors [-webkit-app-region:no-drag]',
        isActive
          ? 'bg-bg-tertiary text-text-primary'
          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
      ].join(' ')}
      aria-label="Go to default dashboard"
      aria-current={isActive ? 'page' : undefined}
      title={tooltip}
    >
      <Home className="h-4 w-4" />
    </button>
  );
}
