import { useCostApi } from '../hooks/use-cost-api.js';
import { RetryButton } from './sso-login-button.js';
import { Button } from './ui/button.js';

interface ViewsLoadErrorProps {
  /** Why views.yaml didn't load, as the main process reported it. */
  readonly message: string;
  /** Read views.yaml again. */
  readonly onRetry: () => void | Promise<void>;
  /** Also offer "Open folder" (off where the page already has one). */
  readonly showOpenFolder?: boolean;
}

/** views.yaml exists but didn't load (a YAML or validation error, or it can't
 *  be read). The main process leaves such a file as it is, so the way out is
 *  to fix or delete it and retry; a deleted file is re-seeded with the
 *  defaults. */
export function ViewsLoadError({ message, onRetry, showOpenFolder = false }: ViewsLoadErrorProps): React.JSX.Element {
  const api = useCostApi();
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-sm">
      <p className="font-medium text-negative">Couldn&apos;t load your dashboards</p>
      <p className="text-text-secondary">
        views.yaml was left as it is. Fix it, or delete it to restore the default dashboards, then retry.
      </p>
      <p className="whitespace-pre-wrap break-words font-mono text-xs text-negative">{message}</p>
      <div className="flex items-center gap-2 self-end">
        {showOpenFolder && (
          <Button variant="ghost" size="sm" onClick={() => { api.revealViewsFolder().catch(() => undefined); }}>
            Open folder
          </Button>
        )}
        <RetryButton onRetry={onRetry} />
      </div>
    </div>
  );
}
