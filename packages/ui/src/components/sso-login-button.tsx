import { useEffect, useRef, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

const AWS_CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';

const DEFAULT_HINT = 'A browser window will open. Refresh this page after logging in.';

// Launching `aws sso login` can take several seconds before the browser opens.
// Lock the button for this long after a click so impatient repeat-clicks don't
// spawn multiple SSO tabs.
const LOCK_MS = 30_000;

export function SsoLoginButton({ profile, hint = DEFAULT_HINT }: Readonly<{ profile: string; hint?: string }>) {
  const api = useCostApi();
  const [cliMissing, setCliMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (lockTimer.current !== null) clearTimeout(lockTimer.current);
  }, []);

  const handleClick = () => {
    if (busy) return;
    setBusy(true);
    lockTimer.current = setTimeout(() => {
      lockTimer.current = null;
      setBusy(false);
    }, LOCK_MS);
    api.ssoLogin(profile).catch((err: unknown) => {
      // The login didn't start — unlock immediately so the user can retry.
      if (lockTimer.current !== null) {
        clearTimeout(lockTimer.current);
        lockTimer.current = null;
      }
      setBusy(false);
      if (err instanceof Error && err.message.includes('AWS_CLI_NOT_FOUND')) {
        setCliMissing(true);
      }
    });
  };

  if (cliMissing) {
    return (
      <div className="mt-2 text-xs text-text-secondary">
        <span>AWS CLI is not installed. </span>
        <a href={AWS_CLI_INSTALL_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
          Install the AWS CLI
        </a>
        <span> and restart CostGoblin.</span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-accent"
      >
        {busy && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
        {busy ? 'Opening SSO Login…' : 'Open SSO Login'}
      </button>
      <span className="text-xs text-text-secondary">{hint}</span>
    </div>
  );
}
