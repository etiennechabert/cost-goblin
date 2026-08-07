import { useEffect, useRef, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

const DEFAULT_HINT = 'A browser window will open. Refresh this page after logging in.';

// Launching a cloud CLI's login can take several seconds before the browser
// opens. Lock the button for this long after a click so impatient
// repeat-clicks don't spawn multiple consent tabs.
const LOCK_MS = 30_000;

/** The per-cloud copy. `start` is passed separately rather than living here,
 *  because the AWS one closes over a profile prop and so cannot be a constant. */
interface CliLoginVariant {
  readonly notFoundMarker: string;
  readonly cliName: string;
  readonly installUrl: string;
  readonly installLabel: string;
  readonly idleLabel: string;
  readonly busyLabel: string;
}

const AWS: CliLoginVariant = {
  notFoundMarker: 'AWS_CLI_NOT_FOUND',
  cliName: 'AWS CLI',
  installUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  installLabel: 'Install the AWS CLI',
  idleLabel: 'Open SSO Login',
  busyLabel: 'Opening SSO Login…',
};

const GCLOUD: CliLoginVariant = {
  notFoundMarker: 'GCLOUD_CLI_NOT_FOUND',
  cliName: 'Google Cloud CLI',
  installUrl: 'https://cloud.google.com/sdk/docs/install',
  installLabel: 'Install the gcloud CLI',
  idleLabel: 'Open Google Sign-in',
  busyLabel: 'Opening Google Sign-in…',
};

/** The shared button. The two clouds differ only in which API method they
 *  call, which CLI they name, and what the button says — everything else (the
 *  repeat-click lock, the unlock-on-failure, the CLI-missing fallback) is one
 *  implementation rather than two copies drifting apart. */
function CliLoginButton({ variant, start, hint }: Readonly<{
  variant: CliLoginVariant;
  /** Starts the login. Rejects with the variant's `*_NOT_FOUND` marker when
   *  the CLI is absent — the one failure with its own remedy. */
  start: () => Promise<void>;
  hint: string;
}>) {
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
    start().catch((err: unknown) => {
      // The login didn't start — unlock immediately so the user can retry.
      if (lockTimer.current !== null) {
        clearTimeout(lockTimer.current);
        lockTimer.current = null;
      }
      setBusy(false);
      if (err instanceof Error && err.message.includes(variant.notFoundMarker)) {
        setCliMissing(true);
      }
    });
  };

  if (cliMissing) {
    return (
      <div className="mt-2 text-xs text-text-secondary">
        <span>{variant.cliName} is not installed. </span>
        <a href={variant.installUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
          {variant.installLabel}
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
        {busy ? variant.busyLabel : variant.idleLabel}
      </button>
      <span className="text-xs text-text-secondary">{hint}</span>
    </div>
  );
}

/** Re-runs `aws sso login` for one profile. */
export function SsoLoginButton({ profile, hint = DEFAULT_HINT }: Readonly<{ profile: string; hint?: string }>) {
  const api = useCostApi();
  return <CliLoginButton variant={AWS} start={() => api.ssoLogin(profile)} hint={hint} />;
}

/** Re-establishes GCP Application Default Credentials.
 *
 *  Takes no profile: ADC is a single machine-wide credential, unlike an AWS
 *  profile — which is why it goes through its own `gcloudLogin()` API method
 *  rather than reusing `ssoLogin(profile)`. */
export function GcloudLoginButton({ hint = DEFAULT_HINT }: Readonly<{ hint?: string }> = {}) {
  const api = useCostApi();
  return <CliLoginButton variant={GCLOUD} start={() => api.gcloudLogin()} hint={hint} />;
}
