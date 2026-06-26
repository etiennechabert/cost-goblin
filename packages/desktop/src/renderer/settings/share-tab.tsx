import { ShareConfigPanel } from '@costgoblin/ui';

/** The Share settings tab — exports/publishes this machine's configuration
 *  (and offers peer data sharing) inline, in place of the old modal. */
export function ShareTab(): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Share configuration</h2>
        <p className="mt-1 text-sm text-text-secondary">Send your configuration to a teammate — as a file, an S3 beacon, or over the local network.</p>
      </div>
      <ShareConfigPanel />
    </div>
  );
}
