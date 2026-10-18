import { useCostApi } from '../hooks/use-cost-api.js';
import { ConfigLoadError, type ConfigFileLoadErrorProps } from './config-load-error.js';

/** views.yaml exists but didn't load. A deleted file is re-seeded with the
 *  defaults on the retry. */
export function ViewsLoadError({ message, onRetry, showOpenFolder = false }: ConfigFileLoadErrorProps): React.JSX.Element {
  const api = useCostApi();
  return (
    <ConfigLoadError
      title="Couldn't load your dashboards"
      hint="views.yaml was left as it is. Fix it, or delete it to restore the default dashboards, then retry."
      message={message}
      onRetry={onRetry}
      onOpenFolder={showOpenFolder ? () => { api.revealViewsFolder().catch(() => undefined); } : undefined}
    />
  );
}
