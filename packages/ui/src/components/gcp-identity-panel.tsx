import { useState } from 'react';
import type {
  GcpAccountLookup,
  GcpDownloadIdentity,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

/** "Signed in as" — which Google identities a GCP setup runs as.
 *
 *  A GCP sync authenticates twice, through two stores that different commands
 *  change: bucket listing reads Application Default Credentials, while
 *  downloads (and the wizard's project list) run as gcloud's active account.
 *  Before this panel the only way to learn either was an error naming the
 *  denied principal. It shows both, and says in plain words when they
 *  disagree in a way that will break (or silently re-route) a sync.
 *
 *  `context` only changes copy: in the wizard the gcloud account also lists
 *  projects, which is the usual reason someone switches it. */
export function GcpIdentityPanel({ providerName, context, refreshKey = 0 }: Readonly<{
  /** Whose `impersonateServiceAccount` / `keyFile` to apply. Omitted in the
   *  wizard before a provider exists. */
  providerName?: string | undefined;
  context: 'wizard' | 'provider';
  /** Bump to re-read, e.g. after a sign-in the parent ran. */
  refreshKey?: number;
}>): React.JSX.Element {
  const api = useCostApi();
  const [recheck, setRecheck] = useState(0);
  const query = useQuery(() => api.getGcpIdentities(providerName), [providerName, refreshKey, recheck]);

  return (
    <section
      aria-label="Signed in as"
      className="rounded-lg border border-border bg-bg-tertiary/20 px-3 py-2.5 text-left text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-text-secondary">Signed in as</span>
        <button
          type="button"
          onClick={() => { setRecheck(n => n + 1); }}
          disabled={query.status === 'loading'}
          className="text-[11px] text-text-muted underline underline-offset-2 hover:text-text-secondary disabled:opacity-50"
        >
          Re-check
        </button>
      </div>
      {(query.status === 'idle' || query.status === 'loading') && (
        <p className="mt-1.5 text-text-muted">Checking Google Cloud credentials…</p>
      )}
      {query.status === 'error' && (
        <p className="mt-1.5 text-text-muted break-words">Couldn&apos;t check credentials: {query.error.message}</p>
      )}
      {query.status === 'success' && query.data.status === 'unavailable' && (
        <p className="mt-1.5 text-text-muted break-words">Couldn&apos;t check credentials: {query.data.reason}</p>
      )}
      {query.status === 'success' && query.data.status === 'ok' && (
        <>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-text-muted">Bucket listing</dt>
            <dd className="min-w-0"><ListingIdentity identity={query.data.identities.listing} /></dd>
            <dt className="text-text-muted">{context === 'wizard' ? 'Downloads & projects' : 'Downloads'}</dt>
            <dd className="min-w-0"><DownloadIdentity identity={query.data.identities.download} /></dd>
          </dl>
          {query.data.identities.warnings.length > 0 && (
            <ul aria-label="Credential warnings" className="mt-2 flex flex-col gap-1.5">
              {query.data.identities.warnings.map(warning => (
                <li
                  key={warning.kind}
                  className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text-primary break-words"
                >
                  <WarningText warning={warning} context={context} />
                </li>
              ))}
            </ul>
          )}
          {query.data.identities.notes.length > 0 && (
            <ul aria-label="Credential notes" className="mt-2 flex flex-col gap-1.5">
              {query.data.identities.notes.map(note => (
                <li key={note.kind} className="text-text-muted break-words">
                  <NoteText note={note} context={context} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Principal({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return <span className="font-mono text-text-primary break-all">{children}</span>;
}

function Command({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return <code className="font-mono text-text-secondary break-all">{children}</code>;
}

function Detail({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="text-[11px] text-text-muted break-all">{children}</div>;
}

const ADC_LOGIN = 'gcloud auth application-default login';

function AccountText({ account }: Readonly<{ account: GcpAccountLookup }>): React.JSX.Element {
  if (account.status === 'known') return <Principal>{account.email}</Principal>;
  switch (account.reason) {
    case 'expired':
      return <span className="text-text-secondary">a Google account whose sign-in has expired — run <Command>{ADC_LOGIN}</Command></span>;
    case 'unreachable':
      return <span className="text-text-secondary">a Google account (couldn&apos;t reach Google to check which)</span>;
    case 'not-recorded':
      return <span className="text-text-secondary">your Google account (the credential doesn&apos;t record which)</span>;
  }
}

function SourceText({ source }: Readonly<{ source: GcpImpersonationSource }>): React.JSX.Element {
  if (source.kind === 'user') return <AccountText account={source.account} />;
  if (source.kind === 'service-account') return <Principal>{source.email}</Principal>;
  return <span className="text-text-secondary">a {source.type ?? 'unknown'} credential</span>;
}

function adcDetail(path: string): string {
  return `Application Default Credentials · ${path}`;
}

function ListingIdentity({ identity }: Readonly<{ identity: GcpListingIdentity }>): React.JSX.Element {
  switch (identity.kind) {
    case 'not-signed-in':
      return (
        <>
          <span className="text-negative">Not signed in</span> — run <Command>{ADC_LOGIN}</Command>
          {identity.credentialsPath !== null && <Detail>No file at {identity.credentialsPath}</Detail>}
        </>
      );
    case 'unreadable':
      return (
        <>
          <span className="text-negative">Couldn&apos;t read the credential file</span>
          <Detail>{identity.credentialsPath}</Detail>
        </>
      );
    case 'user':
      return (
        <>
          <AccountText account={identity.account} />
          <Detail>{adcDetail(identity.credentialsPath)}</Detail>
        </>
      );
    case 'impersonated':
      return (
        <>
          <SourceText source={identity.source} /> <span className="text-text-muted">impersonating</span>{' '}
          <Principal>{identity.target}</Principal>
          <Detail>{adcDetail(identity.credentialsPath)}</Detail>
        </>
      );
    case 'service-account':
      return (
        <>
          <Principal>{identity.email}</Principal>
          <Detail>
            {identity.origin === 'key-file'
              ? `Service account key · ${identity.credentialsPath}`
              : adcDetail(identity.credentialsPath)}
          </Detail>
        </>
      );
    case 'external':
      return (
        <>
          <span className="text-text-secondary">Workload identity federation</span>
          {identity.target !== null && (
            <> <span className="text-text-muted">impersonating</span> <Principal>{identity.target}</Principal></>
          )}
          <Detail>{adcDetail(identity.credentialsPath)}</Detail>
        </>
      );
    case 'unrecognized':
      return (
        <>
          <span className="text-text-secondary">An unrecognized credential type{identity.type === null ? '' : ` (${identity.type})`}</span>
          <Detail>{adcDetail(identity.credentialsPath)}</Detail>
        </>
      );
  }
}

function DownloadIdentity({ identity }: Readonly<{ identity: GcpDownloadIdentity }>): React.JSX.Element {
  switch (identity.kind) {
    case 'gcloud':
      return (
        <>
          {identity.account === null
            ? <><span className="text-negative">No active gcloud account</span> — run <Command>gcloud auth login</Command></>
            : <Principal>{identity.account}</Principal>}
          {identity.impersonate !== null && (
            <> <span className="text-text-muted">impersonating</span> <Principal>{identity.impersonate}</Principal></>
          )}
          <Detail>
            gcloud CLI{identity.configuration === null ? '' : ` · configuration "${identity.configuration}"`}
          </Detail>
        </>
      );
    case 'key-file':
      return (
        <>
          {identity.email === null
            ? <span className="text-negative">Couldn&apos;t read the service account key</span>
            : <Principal>{identity.email}</Principal>}
          <Detail>Service account key · {identity.keyFile}</Detail>
        </>
      );
    case 'cli-missing':
      return <span className="text-negative">The gcloud CLI is not installed</span>;
    case 'cli-error':
      return (
        <>
          <span className="text-negative">gcloud couldn&apos;t report its account</span>
          <Detail>{identity.message}</Detail>
        </>
      );
  }
}

function WarningText({ warning, context }: Readonly<{ warning: GcpIdentityWarning; context: 'wizard' | 'provider' }>): React.JSX.Element {
  switch (warning.kind) {
    case 'adc-target-mismatch':
      return (
        <>
          Bucket listing uses <Principal>{warning.adcTarget}</Principal>, but this provider downloads as{' '}
          <Principal>{warning.providerTarget}</Principal>. Application Default Credentials are machine-wide, so
          they were last set up for a different service account. Run{' '}
          <Command>{`${ADC_LOGIN} --impersonate-service-account=${warning.providerTarget}`}</Command> — note that
          any other provider relying on <Principal>{warning.adcTarget}</Principal> will switch too.
        </>
      );
    case 'adc-not-impersonated':
      return (
        <>
          This provider is set to use <Principal>{warning.providerTarget}</Principal>, but Application Default
          Credentials don&apos;t impersonate it, so bucket listing runs as the signed-in identity itself. Run{' '}
          <Command>{`${ADC_LOGIN} --impersonate-service-account=${warning.providerTarget}`}</Command>.
        </>
      );
    case 'split-accounts':
      return (
        <>
          {context === 'wizard' ? 'Downloads and the project list run' : 'Downloads run'} as{' '}
          <Principal>{warning.downloadAccount}</Principal>, but bucket listing runs as{' '}
          <Principal>{warning.listingAccount}</Principal> — two different accounts, and each needs its own
          access.{' '}
          {context === 'wizard' && 'If you switched gcloud to another account just to list projects, switch it back before syncing. '}
          To use one account for both, run <Command>{`gcloud config set account ${warning.listingAccount}`}</Command>.
        </>
      );
  }
}

function NoteText({ note, context }: Readonly<{ note: GcpIdentityNote; context: 'wizard' | 'provider' }>): React.JSX.Element {
  return (
    <>
      Google doesn&apos;t record which account signed in to Application Default Credentials
      {note.target === null ? '' : ' with impersonation'}, so this can&apos;t be checked:{' '}
      {context === 'wizard' ? 'downloads and the project list run' : 'downloads run'} as{' '}
      <Principal>{note.downloadAccount}</Principal>
      {note.target === null
        ? ', which should be the account you signed in with.'
        : <>, which should be the account you signed in with — and needs permission to impersonate <Principal>{note.target}</Principal> too.</>}
    </>
  );
}
