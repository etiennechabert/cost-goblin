import { RetryButton } from './sso-login-button.js';
import { Button } from './ui/button.js';

/** The props of a load error for one config file (ViewsLoadError,
 *  CostScopeLoadError). */
export interface ConfigFileLoadErrorProps {
  /** Why the file didn't load, as the main process reported it. */
  readonly message: string;
  /** Read the file again. */
  readonly onRetry: () => void | Promise<void>;
  /** Also offer "Open folder" (off where the page already has one). */
  readonly showOpenFolder?: boolean;
}

interface ConfigLoadErrorProps extends Pick<ConfigFileLoadErrorProps, 'message' | 'onRetry'> {
  readonly title: string;
  /** What became of the file and how to get out of it. */
  readonly hint: string;
  /** Reveal the file in the OS file manager; no button without it. */
  readonly onOpenFolder?: (() => void) | undefined;
}

/** A config file exists but didn't load (a YAML or validation error, or it
 *  can't be read). The main process leaves such a file as it is, so the way
 *  out is to fix or delete it and retry. */
export function ConfigLoadError({ title, hint, message, onRetry, onOpenFolder }: ConfigLoadErrorProps): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-sm">
      <p className="font-medium text-negative">{title}</p>
      <p className="text-text-secondary">{hint}</p>
      <p className="whitespace-pre-wrap break-words font-mono text-xs text-negative">{message}</p>
      <div className="flex items-center gap-2 self-end">
        {onOpenFolder !== undefined && (
          <Button variant="ghost" size="sm" onClick={onOpenFolder}>
            Open folder
          </Button>
        )}
        <RetryButton onRetry={onRetry} />
      </div>
    </div>
  );
}
