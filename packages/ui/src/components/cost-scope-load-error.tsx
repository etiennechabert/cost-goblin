import { useCostApi } from '../hooks/use-cost-api.js';
import { ConfigLoadError, type ConfigFileLoadErrorProps } from './config-load-error.js';

/** cost-scope.yaml exists but didn't load. Every cost query fails until it
 *  does: the main process never runs one without the user's metric and
 *  exclusion rules. A deleted file is re-seeded with the defaults on the
 *  retry. */
export function CostScopeLoadError({ message, onRetry, showOpenFolder = false }: ConfigFileLoadErrorProps): React.JSX.Element {
  const api = useCostApi();
  return (
    <ConfigLoadError
      title="Couldn't load your cost scope"
      hint="cost-scope.yaml was left as it is, and costs can't be shown until it loads. Fix it, or delete it to restore the defaults, then retry."
      message={message}
      onRetry={onRetry}
      onOpenFolder={showOpenFolder ? () => { api.revealCostScopeFolder().catch(() => undefined); } : undefined}
    />
  );
}
