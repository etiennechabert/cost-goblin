import { ImportConfigPanel } from '@costgoblin/ui';

/** The Import settings tab — applies a teammate's configuration bundle inline,
 *  in place of the old modal. */
export function ImportTab({ onApplied }: Readonly<{ onApplied: () => void }>): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Import configuration</h2>
        <p className="mt-1 text-sm text-text-secondary">Bring in a teammate's configuration.</p>
      </div>
      <ImportConfigPanel onApplied={onApplied} />
    </div>
  );
}
