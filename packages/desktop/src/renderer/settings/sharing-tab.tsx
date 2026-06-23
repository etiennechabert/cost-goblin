import { Share2, FileUp } from 'lucide-react';

interface Props {
  readonly onShare: () => void;
  readonly onImport: () => void;
}

function ActionCard({ icon, title, description, actionLabel, onClick }: Readonly<{
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-text-secondary">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{title}</p>
          <p className="mt-0.5 text-xs text-text-muted">{description}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        className="shrink-0 rounded-md border border-border px-3.5 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/** The Sharing settings tab — collects the Share/Import configuration actions
 *  that used to live in the hamburger popover. The actual transfer still runs
 *  through the existing Share/Import dialogs (opened via the callbacks). */
export function SharingTab({ onShare, onImport }: Readonly<Props>): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Sharing</h2>
        <p className="mt-1 text-sm text-text-secondary">Share your CostGoblin configuration with teammates, or import theirs.</p>
      </div>

      <div className="flex flex-col gap-3">
        <ActionCard
          icon={<Share2 size={18} />}
          title="Share configuration"
          description="Export your dimensions, views and cost scope as a bundle — to a file, an S3 beacon, or over the local network."
          actionLabel="Share…"
          onClick={onShare}
        />
        <ActionCard
          icon={<FileUp size={18} />}
          title="Import configuration"
          description="Apply a configuration bundle from a teammate. The app reloads once the new config is in place."
          actionLabel="Import…"
          onClick={onImport}
        />
      </div>
    </div>
  );
}
