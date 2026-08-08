import { useEffect, useRef, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';

/** Fallback copy for a panel with no `onRetry` wired — the user has to leave
 *  the screen and come back for the failed call to run again. */
const DEFAULT_HINT = 'A browser window will open. Refresh this page after logging in.';

/** Copy used whenever `onRetry` IS wired, i.e. the escape route is right here.
 *  The old wording sent people looking for a refresh that doesn't exist: the
 *  CLI login resolves as soon as the browser opens, so nothing in the renderer
 *  ever learns that the sign-in finished, and the error panel sat there until
 *  the view was remounted (or the app restarted). */
const RETRY_HINT = 'A browser window will open — come back here and hit Retry.';

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

const GCLOUD_BASE = {
  notFoundMarker: 'GCLOUD_CLI_NOT_FOUND',
  cliName: 'Google Cloud CLI',
  installUrl: 'https://cloud.google.com/sdk/docs/install',
  installLabel: 'Install the gcloud CLI',
} as const;

/** Application Default Credentials — the store the listing SDK reads. */
const GCLOUD_ADC: CliLoginVariant = {
  ...GCLOUD_BASE,
  idleLabel: 'Open Google Sign-in',
  busyLabel: 'Opening Google Sign-in…',
};

/** The gcloud CLI's own active account — the store `gcloud storage rsync`
 *  runs as. Labelled distinctly because re-running the other one cannot fix
 *  it, and a user who has just tried that needs to see this is different. */
const GCLOUD_CLI: CliLoginVariant = {
  ...GCLOUD_BASE,
  idleLabel: 'Sign in the gcloud CLI',
  busyLabel: 'Opening gcloud sign-in…',
};

/** The shared button. The two clouds differ only in which API method they
 *  call, which CLI they name, and what the button says — everything else (the
 *  repeat-click lock, the unlock-on-failure, the CLI-missing fallback) is one
 *  implementation rather than two copies drifting apart. */
function CliLoginButton({ variant, start, hint, onRetry }: Readonly<{
  variant: CliLoginVariant;
  /** Starts the login. Rejects with the variant's `*_NOT_FOUND` marker when
   *  the CLI is absent — the one failure with its own remedy. */
  start: () => Promise<void>;
  hint?: string | undefined;
  /** Re-runs whatever failed with the expired credentials. Rendered as a second
   *  button, because starting the login is only half the flow: the CLI resolves
   *  on spawn and the sign-in itself finishes in a browser this process never
   *  hears back from, so without an explicit re-run the panel is a dead end. */
  onRetry?: (() => void | Promise<void>) | undefined;
}>) {
  const [cliMissing, setCliMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** Whether the login button has been pressed, which is what lets the retry
   *  button say "I've signed in" rather than a bare, ambiguous "Retry". */
  const [started, setStarted] = useState(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A retry that succeeds usually unmounts this panel (the caller's query flips
  // back to loading), so the settle handler below can land after unmount.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (lockTimer.current !== null) clearTimeout(lockTimer.current);
    };
  }, []);

  const handleRetry = () => {
    if (onRetry === undefined || retrying) return;
    setRetrying(true);
    // `onRetry` is sync for callers that just bump a query key and async for
    // callers that await the re-fetch; normalise so both clear the spinner.
    const settled = () => { if (mounted.current) setRetrying(false); };
    const result: void | Promise<void> = onRetry();
    void Promise.resolve(result).then(settled, settled);
  };

  const handleClick = () => {
    if (busy) return;
    setBusy(true);
    setStarted(true);
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
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          title="Re-run the check that failed — use this once the browser sign-in is done"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-tertiary/60 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-bg-tertiary/60"
        >
          {retrying && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-text-muted/40 border-t-text-primary" aria-hidden="true" />}
          {retrying ? 'Retrying…' : started ? "I've signed in — Retry" : 'Retry'}
        </button>
      )}
      <span className="text-xs text-text-secondary">{hint ?? (onRetry !== undefined ? RETRY_HINT : DEFAULT_HINT)}</span>
    </div>
  );
}

/** Re-runs `aws sso login` for one profile. `onRetry` re-runs the call that
 *  failed; pass it wherever the panel would otherwise strand the user. */
export function SsoLoginButton({ profile, hint, onRetry }: Readonly<{
  profile: string;
  hint?: string | undefined;
  onRetry?: (() => void | Promise<void>) | undefined;
}>) {
  const api = useCostApi();
  return <CliLoginButton variant={AWS} start={() => api.ssoLogin(profile)} hint={hint} onRetry={onRetry} />;
}

/** Signs one of GCP's two credential stores back in.
 *
 *  `mode: 'adc'` (the default) re-establishes Application Default Credentials,
 *  which the listing SDK reads. `mode: 'cli'` signs the gcloud CLI itself in,
 *  which is what `gcloud storage rsync` runs as. They are NOT interchangeable
 *  — a stale CLI account is unfixable by re-running ADC, so offering only the
 *  ADC button for that error sent the user round a loop that never terminated.
 *
 *  Takes no profile: both are machine-wide, unlike an AWS profile — which is
 *  why this goes through its own API method rather than `ssoLogin(profile)`.
 *  `providerName` names the provider whose failure raised the button, so ADC
 *  is minted with that provider's impersonation rather than another's. */
export function GcloudLoginButton({ mode = 'adc', providerName, hint, onRetry }: Readonly<{
  mode?: 'adc' | 'cli';
  providerName?: string;
  hint?: string | undefined;
  onRetry?: (() => void | Promise<void>) | undefined;
}> = {}) {
  const api = useCostApi();
  return (
    <CliLoginButton
      variant={mode === 'cli' ? GCLOUD_CLI : GCLOUD_ADC}
      start={() => api.gcloudLogin(mode, providerName)}
      hint={hint}
      onRetry={onRetry}
    />
  );
}
