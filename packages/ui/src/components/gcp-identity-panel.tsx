import { useState } from 'react';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from '@costgoblin/core/browser';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpIdentities,
  GcpListingIdentity,
  GcpSplitAccounts,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

/** "Signed in as" — which Google accounts a GCP setup runs as.
 *
 *  A GCP sync authenticates twice, through two stores that different commands
 *  change: bucket listing reads Application Default Credentials (or the
 *  provider's key file), while downloads (and the wizard's project list) run
 *  as gcloud's account. Before this panel the only way to learn either was an
 *  error naming the denied principal. Read-only: every remedy is a command to
 *  run, never an action taken here.
 *
 *  `context: 'wizard'` renders the compact form: just the account gcloud is
 *  signed in as (it lists the projects the wizard offers), plus one line when
 *  something would stop the setup. `context: 'provider'` (Data Management)
 *  shows both paths, each impersonating the provider's reader when it names
 *  one — as one line when nothing needs action, with the paths behind
 *  Details. */
export function GcpIdentityPanel({ providerName, context, refreshKey = 0 }: Readonly<{
  /** Whose `keyFile` / `impersonateServiceAccount` to apply. Omitted in the
   *  wizard, where no provider exists yet. */
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
      // Named per provider: Data Management shows one panel per GCP provider,
      // and identical landmark names are indistinguishable to a screen reader.
      aria-label={providerName === undefined ? 'Signed in as' : `Signed in as (${providerName})`}
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
        context === 'wizard'
          ? <CompactIdentities identities={query.data.identities} />
          : <Identities identities={query.data.identities} />
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
  return <div className="text-[11px] text-text-muted break-words">{children}</div>;
}

/** How to get a working ADC file, given which file the SDK reads. Signing in
 *  again writes only gcloud's well-known file, so it cannot fix the one
 *  `GOOGLE_APPLICATION_CREDENTIALS` names. */
function AdcRemedy({ file }: Readonly<{ file: GcpCredentialFile | null }>): React.JSX.Element {
  if (file?.origin === 'env') {
    return (
      <>
        fix or unset <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> — it names this file, and signing in
        again writes a different one
      </>
    );
  }
  if (file?.origin === 'key-file') return <>check the provider&apos;s <Command>keyFile</Command></>;
  return <>run <Command>{GCLOUD_ADC_LOGIN_COMMAND}</Command></>;
}

/** The wizard's form: the one account the user is working as — gcloud's,
 *  which lists the projects on offer — and a single line only when the setup
 *  would stall: gcloud or bucket access not signed in, or bucket access signed
 *  in as someone else. */
function CompactIdentities({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  const { listing, splitAccounts } = identities;
  const adcFile = listing.kind === 'not-signed-in' || listing.kind === 'unreadable' ? listing.file : undefined;
  return (
    <>
      <p className="mt-1 break-words">
        <CompactAccount download={identities.download} />
      </p>
      {adcFile !== undefined && (
        <Detail>Bucket access isn&apos;t signed in — <AdcRemedy file={adcFile} /></Detail>
      )}
      {splitAccounts !== null && (
        <Detail>
          Bucket access is signed in as <Principal>{splitAccounts.listingAccount}</Principal> — a different account.
        </Detail>
      )}
    </>
  );
}

function CompactAccount({ download }: Readonly<{ download: GcpDownloadIdentity }>): React.JSX.Element {
  switch (download.kind) {
    case 'gcloud':
      return download.account === null
        ? <span className="text-negative">gcloud isn&apos;t signed in — run <Command>{GCLOUD_CLI_LOGIN_COMMAND}</Command></span>
        : (
          <>
            <Principal>{download.account}</Principal>
            <span className="text-text-muted"> · gcloud configuration &quot;{download.configuration}&quot;</span>
          </>
        );
    case 'key-file':
      return download.email === null ? <span className="text-negative">An unreadable key file</span> : <Principal>{download.email}</Principal>;
    case 'cli-missing':
      return <span className="text-negative">The gcloud CLI is not installed</span>;
    case 'cli-error':
      return <span className="text-negative">gcloud couldn&apos;t report its configuration: {download.message}</span>;
  }
}

/** A provider with no reader that lists through an impersonated ADC file:
 *  listing reads as the file's service account, but downloads run as gcloud's
 *  own account, which typically cannot read the export. The fix is naming that
 *  account as the provider's reader, so both paths impersonate it. */
function readerlessImpersonation({ listing, download, reader }: GcpIdentities): { target: string; account: string } | null {
  if (reader !== null || listing.kind !== 'impersonated') return null;
  if (download.kind !== 'gcloud' || download.account === null) return null;
  return { target: listing.target, account: download.account };
}

/** Nothing to act on: both paths resolved to someone, nobody signed out or
 *  expired, no split, and no path bypassing an impersonation. */
function isHealthy(identities: GcpIdentities): boolean {
  const { listing, download, splitAccounts } = identities;
  if (splitAccounts !== null || readerlessImpersonation(identities) !== null) return false;
  const listingOk = listing.kind === 'impersonated' || listing.kind === 'service-account'
    || (listing.kind === 'user' && !(listing.account.status === 'unknown' && listing.account.reason === 'expired'));
  const downloadOk = (download.kind === 'gcloud' && download.account !== null)
    || (download.kind === 'key-file' && download.email !== null);
  return listingOk && downloadOk;
}

/** Who reads the bucket in the end: the provider's reader, else the service
 *  account an impersonated ADC file acts as. */
function readsAs({ listing, reader }: GcpIdentities): string | null {
  return reader ?? (listing.kind === 'impersonated' ? listing.target : null);
}

/** Data Management's form: one line when nothing needs action — who signs in
 *  and who it reads as — with both paths behind Details; the paths open, with
 *  a warning when they are two different people, otherwise. */
function Identities({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  if (!isHealthy(identities)) return <Paths identities={identities} />;
  const target = readsAs(identities);
  const { download } = identities;
  // Healthy guarantees a name here; the configuration is under Details.
  const account = downloadName(download);
  return (
    <div className="mt-1">
      <p className="min-w-0 break-words">
        {account !== null && <Principal>{account}</Principal>}
        {target !== null && <><span className="text-text-muted"> · reads as </span><Principal>{target}</Principal></>}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text-secondary">Details</summary>
        <Paths identities={identities} />
      </details>
    </div>
  );
}

function downloadName(download: GcpDownloadIdentity): string | null {
  switch (download.kind) {
    case 'gcloud': return download.account;
    case 'key-file': return download.email;
    case 'cli-missing':
    case 'cli-error':
      return null;
  }
}

function Paths({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  const { listing, reader } = identities;
  const bypassed = readerlessImpersonation(identities);
  return (
    <>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-text-muted">Bucket listing</dt>
        <dd className="min-w-0">
          {reader !== null && listing.kind === 'impersonated'
            // With a reader, an impersonated ADC file is unwrapped: the reader
            // is minted from the login underneath it, not through its account.
            ? (
              <>
                <span className="text-text-secondary">your Google account</span>
                <Detail>{fileDetail(listing.file)}</Detail>
              </>
            )
            : <ListingIdentity identity={listing} />}
          {reader !== null && <Impersonating target={reader} />}
        </dd>
        <dt className="text-text-muted">Downloads</dt>
        <dd className="min-w-0">
          <DownloadIdentity identity={identities.download} />
          {reader !== null && <Impersonating target={reader} />}
        </dd>
      </dl>
      {identities.splitAccounts !== null && <SplitAccountsWarning split={identities.splitAccounts} />}
      {bypassed !== null && (
        <p role="note" aria-label="Credential warning" className="mt-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text-primary break-words">
          Bucket listing reads as <Principal>{bypassed.target}</Principal>, but downloads run as{' '}
          <Principal>{bypassed.account}</Principal>. Add{' '}
          <Command>{`impersonateServiceAccount: ${bypassed.target}`}</Command> to this provider in{' '}
          <Command>costgoblin.yaml</Command> so both read as it.
        </p>
      )}
    </>
  );
}

/** The provider's reader, which both paths impersonate. */
function Impersonating({ target }: Readonly<{ target: string }>): React.JSX.Element {
  return <Detail>impersonating <Principal>{target}</Principal> (this provider&apos;s read-only service account)</Detail>;
}

function fileDetail(file: GcpCredentialFile): string {
  switch (file.origin) {
    case 'env': return `Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) · ${file.path}`;
    case 'well-known': return `Application Default Credentials · ${file.path}`;
    case 'key-file': return `Provider keyFile · ${file.path}`;
  }
}

function AccountText({ account, file }: Readonly<{ account: GcpAccountLookup; file: GcpCredentialFile }>): React.JSX.Element {
  if (account.status === 'known') return <Principal>{account.email}</Principal>;
  switch (account.reason) {
    case 'expired':
      return <span className="text-text-secondary">a Google account whose sign-in has expired — <AdcRemedy file={file} /></span>;
    case 'unreachable':
      return <span className="text-text-secondary">a Google account (couldn&apos;t reach Google to check which)</span>;
    case 'not-recorded':
      return <span className="text-text-secondary">your Google account (the credential doesn&apos;t record which)</span>;
  }
}

function ListingIdentity({ identity }: Readonly<{ identity: GcpListingIdentity }>): React.JSX.Element {
  switch (identity.kind) {
    case 'not-signed-in':
      return (
        <>
          <span className="text-negative">Not signed in</span> — <AdcRemedy file={identity.file} />
          {identity.file !== null && <Detail>No file at {identity.file.path}</Detail>}
        </>
      );
    case 'unreadable':
      return (
        <>
          <span className="text-negative">Couldn&apos;t read the credential file</span> — <AdcRemedy file={identity.file} />
          <Detail>{identity.file.path}</Detail>
        </>
      );
    case 'user':
      return (
        <>
          <AccountText account={identity.account} file={identity.file} />
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'impersonated':
      return (
        <>
          <Principal>{identity.target}</Principal>
          <Detail>Service account, impersonated · {fileDetail(identity.file)}</Detail>
        </>
      );
    case 'service-account':
      return (
        <>
          <Principal>{identity.email}</Principal>
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'other':
      return (
        <>
          <span className="text-text-secondary">A {identity.type ?? 'non-standard'} credential</span>
          <Detail>{fileDetail(identity.file)}</Detail>
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
            ? <><span className="text-negative">No active gcloud account</span> — run <Command>{GCLOUD_CLI_LOGIN_COMMAND}</Command></>
            : <Principal>{identity.account}</Principal>}
          <Detail>gcloud CLI · configuration &quot;{identity.configuration}&quot;</Detail>
        </>
      );
    case 'key-file':
      return (
        <>
          {identity.email === null
            ? <span className="text-negative">Couldn&apos;t read the service account key</span>
            : <Principal>{identity.email}</Principal>}
          <Detail>Provider keyFile · {identity.path}</Detail>
        </>
      );
    case 'cli-missing':
      return <span className="text-negative">The gcloud CLI is not installed — downloads need it</span>;
    case 'cli-error':
      return (
        <>
          <span className="text-negative">gcloud couldn&apos;t report its configuration</span>
          <Detail>{identity.message}</Detail>
        </>
      );
  }
}

function SplitAccountsWarning({ split }: Readonly<{ split: GcpSplitAccounts }>): React.JSX.Element {
  return (
    <p role="note" aria-label="Credential warning" className="mt-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text-primary break-words">
      Downloads run as <Principal>{split.downloadAccount}</Principal>, but bucket listing runs as{' '}
      <Principal>{split.listingAccount}</Principal> — two different accounts, and each needs its own access. To use one
      account for both, run <Command>{`gcloud config set account ${split.listingAccount}`}</Command> — and if gcloud has
      never signed in as that account, <Command>{`${GCLOUD_CLI_LOGIN_COMMAND} ${split.listingAccount}`}</Command> first.
    </p>
  );
}
