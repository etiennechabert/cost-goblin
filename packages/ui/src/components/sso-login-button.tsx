import { useEffect, useState } from 'react';
import { Button } from './ui/button.js';
import { useCostApi } from '../hooks/use-cost-api.js';

const HINT = 'A browser window will open — come back here and hit Retry.';

// Launching a cloud CLI's login can take several seconds before the browser
// opens. Lock the button for this long after a launch so impatient
// repeat-clicks don't spawn multiple consent tabs.
const LOCK_MS = 30_000;

/** When each login was last launched, keyed by CLI + target.
 *
 *  Module scope rather than component state, because this component does not
 *  survive its own remedy: every panel that hosts it is gated on an error
 *  string, `onRetry` clears that string before re-fetching, and Data & Sync
 *  re-polls every 5s — so the button unmounts and remounts constantly. A lock
 *  held in `useState` was therefore reset by the very Retry it sits next to,
 *  letting a user spawn a second `aws sso login` (and a second consent tab)
 *  seconds after the first — exactly what the lock exists to prevent.
 *
 *  Bounded by the number of distinct profiles/modes a session touches, so it
 *  needs no eviction. */
const launchedAt = new Map<string, number>();

function lockRemainingMs(key: string): number {
  const at = launchedAt.get(key);
  if (at === undefined) return 0;
  return Math.max(0, at + LOCK_MS - Date.now());
}

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

/** What the login button is doing. A union rather than a bag of booleans, so
 *  states like "spawning AND cli-missing" cannot be represented. The 30s lock
 *  is deliberately NOT in here — see `launchedAt`. */
type LaunchState =
  | { status: 'idle' }
  | { status: 'spawning' }
  | { status: 'cli-missing' };

function Spinner({ tone }: Readonly<{ tone: 'on-accent' | 'on-surface' }>) {
  const colors = tone === 'on-accent'
    ? 'border-white/40 border-t-white'
    : 'border-text-muted/40 border-t-text-primary';
  return <span className={`inline-block h-3 w-3 animate-spin rounded-full border-2 ${colors}`} aria-hidden="true" />;
}

/** Re-runs the call that failed with the credential error.
 *
 *  Exported standalone because not every failure has a sign-in remedy: an
 *  `AccessDenied`, a project-level IAM denial or a dropped connection strands
 *  the user just as badly, and those panels previously offered nothing at all.
 *  `signedIn` is set by the login button once it has actually launched a
 *  browser flow. */
export function RetryButton({ onRetry, signedIn = false }: Readonly<{
  onRetry: () => void | Promise<void>;
  signedIn?: boolean;
}>) {
  const [retrying, setRetrying] = useState(false);

  const handleClick = () => {
    if (retrying) return;
    setRetrying(true);
    const clear = () => { setRetrying(false); };
    // `onRetry` is sync for callers that just bump a query key and async for
    // callers that await the re-fetch; normalise so both clear the spinner.
    // The try/catch covers a caller that throws synchronously — without it the
    // button would sit disabled on "Retrying…" with no way back.
    try {
      const result: void | Promise<void> = onRetry();
      void Promise.resolve(result).then(clear, clear);
    } catch {
      clear();
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleClick}
      disabled={retrying}
      title="Re-run the check that failed"
    >
      {retrying && <Spinner tone="on-surface" />}
      {retrying ? 'Retrying…' : signedIn ? "I've signed in — Retry" : 'Retry'}
    </Button>
  );
}

/** The shared button. The two clouds differ only in which API method they
 *  call, which CLI they name, and what the button says — everything else (the
 *  repeat-click lock, the unlock-on-failure, the CLI-missing fallback) is one
 *  implementation rather than two copies drifting apart. */
function CliLoginButton({ variant, lockKey, start, onRetry }: Readonly<{
  variant: CliLoginVariant;
  /** Identifies the credential this button signs in, so the launch lock is
   *  shared by every panel targeting it and survives their remounts. */
  lockKey: string;
  /** Starts the login. Rejects with the variant's `*_NOT_FOUND` marker when
   *  the CLI is absent — the one failure with its own remedy. */
  start: () => Promise<void>;
  /** Re-runs whatever failed with the expired credentials. Required, because
   *  starting the login is only half the flow: the CLI resolves on spawn and
   *  the sign-in itself finishes in a browser this process never hears back
   *  from, so without an explicit re-run the panel is a dead end. */
  onRetry: () => void | Promise<void>;
}>) {
  const [launch, setLaunch] = useState<LaunchState>({ status: 'idle' });
  // The lock lives outside React, so nothing else would re-render this
  // component when it expires. Bumped by the timer below and on a new launch.
  const [, tick] = useState(0);

  const launchedTs = launchedAt.get(lockKey);
  const busy = launch.status === 'spawning' || lockRemainingMs(lockKey) > 0;

  useEffect(() => {
    if (launchedTs === undefined) return;
    const remaining = launchedTs + LOCK_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => { tick(n => n + 1); }, remaining);
    return () => { clearTimeout(timer); };
  }, [launchedTs]);

  const handleClick = () => {
    if (busy) return;
    setLaunch({ status: 'spawning' });
    start().then(
      () => {
        // Spawn succeeded — a browser is opening. Only now is the lock armed
        // and the retry allowed to say "I've signed in".
        launchedAt.set(lockKey, Date.now());
        setLaunch({ status: 'idle' });
        tick(n => n + 1);
      },
      (err: unknown) => {
        // The login never started, so nothing is locked and nothing was signed
        // in — a spawn EACCES must not leave the retry claiming otherwise.
        setLaunch(err instanceof Error && err.message.includes(variant.notFoundMarker)
          ? { status: 'cli-missing' }
          : { status: 'idle' });
      },
    );
  };

  // The CLI is missing, so the login button has nothing to run — but the retry
  // still does, and this is the state that most needs it: the user leaves to
  // install the CLI and comes back.
  if (launch.status === 'cli-missing') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-text-secondary">
          {variant.cliName} is not installed.{' '}
          <a href={variant.installUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
            {variant.installLabel}
          </a>
          , then retry.
        </span>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Button size="sm" onClick={handleClick} disabled={busy}>
        {busy && <Spinner tone="on-accent" />}
        {busy ? variant.busyLabel : variant.idleLabel}
      </Button>
      <RetryButton onRetry={onRetry} signedIn={launchedTs !== undefined} />
      <span className="text-xs text-text-secondary">{HINT}</span>
    </div>
  );
}

/** Re-runs `aws sso login` for one profile. `onRetry` re-runs the call that
 *  failed — without it the panel is a dead end, so it is required. */
export function SsoLoginButton({ profile, onRetry }: Readonly<{
  profile: string;
  onRetry: () => void | Promise<void>;
}>) {
  const api = useCostApi();
  return (
    <CliLoginButton
      variant={AWS}
      lockKey={`aws:${profile}`}
      start={() => api.ssoLogin(profile)}
      onRetry={onRetry}
    />
  );
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
export function GcloudLoginButton({ mode = 'adc', providerName, onRetry }: Readonly<{
  mode?: 'adc' | 'cli';
  providerName?: string;
  onRetry: () => void | Promise<void>;
}>) {
  const api = useCostApi();
  return (
    <CliLoginButton
      variant={mode === 'cli' ? GCLOUD_CLI : GCLOUD_ADC}
      // Machine-wide credentials, so the lock is shared across providers: two
      // panels for two GCP providers must not each spawn a consent tab.
      lockKey={`gcloud:${mode}`}
      start={() => api.gcloudLogin(mode, providerName)}
      onRetry={onRetry}
    />
  );
}
