import { useState } from 'react';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from '@costgoblin/core/browser';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadPrincipal,
  GcpIdentities,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
  GcpListingImpersonationVia,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

type PanelContext = 'wizard' | 'provider';

/** "Signed in as" — which Google identities a GCP setup runs as.
 *
 *  A GCP sync authenticates twice, through two stores that different commands
 *  change: bucket listing reads Application Default Credentials (or the
 *  provider's key file) — impersonating the provider's read-only service
 *  account, when it names one — while downloads (and the wizard's project
 *  list) run with gcloud's own credentials. Before this panel the only way to learn
 *  either was an error naming the denied principal. It shows both, and says
 *  in plain words when they disagree in a way that will break (or silently
 *  re-route) a sync. Read-only: every remedy is a command to run, never an
 *  action taken here.
 *
 *  `context: 'wizard'` renders the compact form: just the account gcloud is
 *  signed in as (it lists the projects the wizard offers), plus one line when
 *  something would stop the setup. Impersonation belongs to the provider —
 *  its service account is chosen later — so the wizard says nothing about
 *  it. `context: 'provider'` (Data Management) shows both paths in full. */
export function GcpIdentityPanel({ providerName, context, refreshKey = 0 }: Readonly<{
  /** Whose `impersonateServiceAccount` / `keyFile` to apply. Omitted in the
   *  wizard, where no provider exists yet. */
  providerName?: string | undefined;
  context: PanelContext;
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

function Identities({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  const loginPath = identities.adcLoginPath;
  return (
    <>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-text-muted">Bucket listing</dt>
        <dd className="min-w-0"><ListingIdentity identity={identities.listing} loginPath={loginPath} /></dd>
        <dt className="text-text-muted">Downloads</dt>
        <dd className="min-w-0"><DownloadIdentity identity={identities.download} /></dd>
      </dl>
      {identities.warnings.length > 0 && (
        <ul aria-label="Credential warnings" className="mt-2 flex flex-col gap-1.5">
          {identities.warnings.map(warning => (
            <li
              key={warning.kind}
              className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text-primary break-words"
            >
              <WarningText warning={warning} />
            </li>
          ))}
        </ul>
      )}
      {identities.notes.length > 0 && (
        <ul aria-label="Credential notes" className="mt-2 flex flex-col gap-1.5">
          {identities.notes.map(note => (
            <li key={note.kind} className="text-text-muted break-words">
              <NoteText note={note} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The wizard's form: the one account the user is working as — gcloud's,
 *  which lists the projects on offer — and a single line only when the setup
 *  would stall: gcloud or bucket access not signed in, or bucket access signed
 *  in as someone else. */
function CompactIdentities({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  const { download, listing } = identities;
  const split = identities.warnings.find(w => w.kind === 'split-accounts');
  const adcFile = listing.kind === 'not-signed-in' || listing.kind === 'unreadable' ? listing.file : undefined;
  return (
    <>
      <p className="mt-1 break-words">
        <CompactAccount download={download} />
      </p>
      {adcFile !== undefined && (
        <Detail>
          Bucket access isn&apos;t signed in — <AdcRemedy file={adcFile} loginPath={identities.adcLoginPath} />
        </Detail>
      )}
      {split !== undefined && (
        <Detail>
          Bucket access is signed in as <Principal>{split.listingAccount}</Principal> — a different account.
        </Detail>
      )}
    </>
  );
}

function CompactAccount({ download }: Readonly<{ download: GcpDownloadIdentity }>): React.JSX.Element {
  switch (download.kind) {
    case 'gcloud':
      if (download.principal.kind === 'account' && download.principal.account === null) {
        return <span className="text-negative">gcloud isn&apos;t signed in — run <Command>{GCLOUD_CLI_LOGIN_COMMAND}</Command></span>;
      }
      return (
        <>
          <DownloadPrincipalText principal={download.principal} />
          <span className="text-text-muted"> · gcloud configuration &quot;{download.configuration}&quot;</span>
        </>
      );
    case 'cli-missing':
      return <span className="text-negative">The gcloud CLI is not installed</span>;
    case 'cli-error':
      return <span className="text-negative">gcloud couldn&apos;t report its configuration: {download.message}</span>;
  }
}

const isServiceAccount = (email: string): boolean => email.toLowerCase().endsWith('.gserviceaccount.com');

function Principal({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return <span className="font-mono text-text-primary break-all">{children}</span>;
}

function Command({ children }: Readonly<{ children: string }>): React.JSX.Element {
  return <code className="font-mono text-text-secondary break-all">{children}</code>;
}

function Detail({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="text-[11px] text-text-muted break-words">{children}</div>;
}

function Impersonating({ target }: Readonly<{ target: string }>): React.JSX.Element {
  return <> <span className="text-text-muted">impersonating</span> <Principal>{target}</Principal></>;
}

/** How to get a working ADC file, given which file the SDK reads. Always the
 *  plain login (the app's Sign in button): a provider's read-only service
 *  account is impersonated per provider on top of it, so ADC itself never
 *  needs `--impersonate-service-account`. */
function AdcRemedy({ file, loginPath }: Readonly<{ file: GcpCredentialFile | null; loginPath: string | null }>): React.JSX.Element {
  if (file?.origin === 'env') {
    return (
      <>
        fix or unset <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> — it names this file, and signing in
        again writes a different one
      </>
    );
  }
  if (file?.origin === 'key-file') return <>check the provider&apos;s <Command>keyFile</Command></>;
  if (loginPath !== null) {
    return (
      <>
        run <Command>{GCLOUD_ADC_LOGIN_COMMAND}</Command> — but <Command>CLOUDSDK_CONFIG</Command> is set, so gcloud
        writes <Command>{loginPath}</Command>, which CostGoblin doesn&apos;t read: unset{' '}
        <Command>CLOUDSDK_CONFIG</Command>, or point <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> at that file
      </>
    );
  }
  return <>run <Command>{GCLOUD_ADC_LOGIN_COMMAND}</Command></>;
}

function AccountText({ account, file, loginPath }: Readonly<{ account: GcpAccountLookup; file: GcpCredentialFile; loginPath: string | null }>): React.JSX.Element {
  if (account.status === 'known') return <Principal>{account.email}</Principal>;
  switch (account.reason) {
    case 'expired':
      return <span className="text-text-secondary">a Google account whose sign-in has expired — <AdcRemedy file={file} loginPath={loginPath} /></span>;
    case 'unreachable':
      return <span className="text-text-secondary">a Google account (couldn&apos;t reach Google to check which)</span>;
    case 'not-recorded':
      return <span className="text-text-secondary">your Google account (the credential doesn&apos;t record which)</span>;
  }
}

function SourceText({ source, file, loginPath }: Readonly<{ source: GcpImpersonationSource; file: GcpCredentialFile; loginPath: string | null }>): React.JSX.Element {
  switch (source.kind) {
    case 'user': return <AccountText account={source.account} file={file} loginPath={loginPath} />;
    case 'service-account': return <Principal>{source.email}</Principal>;
    case 'federated':
      return (
        <>
          <span className="text-text-secondary">Workload or workforce identity federation</span>
          {source.target !== null && <Impersonating target={source.target} />}
        </>
      );
    case 'other':
      return <span className="text-text-secondary">an unrecognized credential{source.type === null ? '' : ` (${source.type})`}</span>;
  }
}

/** Where listing's impersonation comes from: the provider's read-only
 *  service account, or (no reader) a legacy impersonated ADC file itself. */
function ImpersonationDetail({ via }: Readonly<{ via: GcpListingImpersonationVia }>): React.JSX.Element {
  if (via.kind === 'credential') {
    return <Detail>Impersonated by the credential itself (an <Command>--impersonate-service-account</Command> sign-in) — this provider names no read-only service account</Detail>;
  }
  return (
    <>
      <Detail>This provider&apos;s read-only service account (<Command>impersonateServiceAccount</Command>), minted from your sign-in</Detail>
      {via.adcTarget !== null && (
        <Detail>
          Your Application Default Credentials impersonate <Principal>{via.adcTarget}</Principal> themselves; this provider
          doesn&apos;t use that — it mints its reader from the sign-in underneath
        </Detail>
      )}
    </>
  );
}

function fileDetail(file: GcpCredentialFile): string {
  switch (file.origin) {
    case 'env': return `Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) · ${file.path}`;
    case 'well-known': return `Application Default Credentials · ${file.path}`;
    case 'key-file': return `Provider keyFile · ${file.path}`;
  }
}

function ListingIdentity({ identity, loginPath }: Readonly<{ identity: GcpListingIdentity; loginPath: string | null }>): React.JSX.Element {
  switch (identity.kind) {
    case 'not-signed-in':
      return (
        <>
          <span className="text-negative">Not signed in</span> — <AdcRemedy file={identity.file} loginPath={loginPath} />
          {identity.file !== null && <Detail>No file at {identity.file.path}</Detail>}
        </>
      );
    case 'unreadable':
      return (
        <>
          <span className="text-negative">Couldn&apos;t read the credential file</span> — <AdcRemedy file={identity.file} loginPath={loginPath} />
          <Detail>{identity.file.path}</Detail>
        </>
      );
    case 'user':
      return (
        <>
          <AccountText account={identity.account} file={identity.file} loginPath={loginPath} />
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'impersonated':
      return (
        <>
          <SourceText source={identity.source} file={identity.file} loginPath={loginPath} />
          <Impersonating target={identity.target} />
          <ImpersonationDetail via={identity.via} />
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'service-account':
      return (
        <>
          <Principal>{identity.email}</Principal>
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'external':
      return (
        <>
          <span className="text-text-secondary">Workload or workforce identity federation</span>
          {identity.target !== null && <Impersonating target={identity.target} />}
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'unrecognized':
      return (
        <>
          <span className="text-negative">A credential the Cloud Storage SDK can&apos;t use{identity.type === null ? '' : ` (${identity.type})`}</span>
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
  }
}

function DownloadPrincipalText({ principal }: Readonly<{ principal: GcpDownloadPrincipal }>): React.JSX.Element {
  switch (principal.kind) {
    case 'account':
      return principal.account === null
        ? <span className="text-negative">No active gcloud account</span>
        : <Principal>{principal.account}</Principal>;
    case 'key-file':
      return principal.email === null
        ? <span className="text-negative">a key file it can&apos;t name</span>
        : <Principal>{principal.email}</Principal>;
    case 'access-token-file':
      return <span className="text-text-secondary">a pre-minted access token (gcloud doesn&apos;t say whose)</span>;
  }
}

function principalDetail(principal: GcpDownloadPrincipal): string | null {
  switch (principal.kind) {
    case 'account': return principal.fromEnv ? 'account set by CLOUDSDK_CORE_ACCOUNT' : null;
    case 'key-file': return principal.origin === 'provider' ? `Provider keyFile · ${principal.path}` : `gcloud's auth/credential_file_override · ${principal.path}`;
    case 'access-token-file': return `gcloud's auth/access_token_file · ${principal.path}`;
  }
}

function DownloadIdentity({ identity }: Readonly<{ identity: GcpDownloadIdentity }>): React.JSX.Element {
  switch (identity.kind) {
    case 'gcloud': {
      const extra = principalDetail(identity.principal);
      return (
        <>
          <DownloadPrincipalText principal={identity.principal} />
          {identity.impersonate !== null && <Impersonating target={identity.impersonate.target} />}
          <Detail>
            gcloud CLI · configuration &quot;{identity.configuration}&quot;
            {identity.impersonate?.origin === 'gcloud-config' && ' · impersonation from gcloud\'s auth/impersonate_service_account'}
          </Detail>
          {extra !== null && <Detail>{extra}</Detail>}
          {identity.principal.kind === 'account' && identity.principal.account === null && (
            <Detail>Run <Command>{GCLOUD_CLI_LOGIN_COMMAND}</Command> to sign gcloud in.</Detail>
          )}
        </>
      );
    }
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

/** Naming a reader on the provider — the one fix for every impersonation
 *  disagreement: it drives both halves (listing mints it from the user's
 *  sign-in; downloads pass it to gcloud as a flag, beating gcloud's
 *  `auth/impersonate_service_account`). */
function SetReader({ target }: Readonly<{ target: string }>): React.JSX.Element {
  return (
    <>
      set <Command>{`impersonateServiceAccount: ${target}`}</Command> on this provider (the setup wizard&apos;s
      Read-only service account field) — both halves then impersonate it, minted from your own sign-in
    </>
  );
}

const UNSET_GCLOUD_IMPERSONATION = 'gcloud config unset auth/impersonate_service_account';

function SplitAccountsRemedy({ warning }: Readonly<{ warning: Extract<GcpIdentityWarning, { kind: 'split-accounts' }> }>): React.JSX.Element {
  const onProvider = 'on this provider';
  if (warning.downloadAccountFromEnv) {
    return <>gcloud&apos;s account is set by <Command>CLOUDSDK_CORE_ACCOUNT</Command> in CostGoblin&apos;s environment — change or unset it there.</>;
  }
  if (isServiceAccount(warning.listingAccount)) {
    if (warning.sharedTarget !== null) {
      // keyFile and impersonateServiceAccount are exclusive, so the reader
      // can't move onto the key: move listing onto the user's own sign-in.
      return (
        <>
          Listing mints the reader from a service-account key in Application Default Credentials. To mint it from your own
          account, as downloads do,{' '}
          {warning.listingKeyFile?.origin === 'env'
            ? <>unset <Command>GOOGLE_APPLICATION_CREDENTIALS</Command></>
            : <>run <Command>{GCLOUD_ADC_LOGIN_COMMAND}</Command></>}.
        </>
      );
    }
    return warning.listingKeyFile === null
      ? <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key — set <Command>keyFile</Command> {onProvider} so both halves use it.</>
      : <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key: set <Command>{`keyFile: ${warning.listingKeyFile.path}`}</Command> {onProvider} so both halves use it.</>;
  }
  return (
    <>
      To use one account for both, run <Command>{`gcloud config set account ${warning.listingAccount}`}</Command> — and if gcloud has
      never signed in as that account, <Command>{`${GCLOUD_CLI_LOGIN_COMMAND} ${warning.listingAccount}`}</Command> first.
    </>
  );
}

function WarningText({ warning }: Readonly<{ warning: GcpIdentityWarning }>): React.JSX.Element {
  switch (warning.kind) {
    case 'target-mismatch':
      return (
        <>
          Bucket listing impersonates <Principal>{warning.listingTarget}</Principal> through your Application Default
          Credentials, but gcloud is set to impersonate <Principal>{warning.gcloudTarget}</Principal>{' '}
          (<Command>auth/impersonate_service_account</Command>), so downloads run as that instead. To read as one account,{' '}
          <SetReader target={warning.listingTarget} />; or run <Command>{UNSET_GCLOUD_IMPERSONATION}</Command>.
        </>
      );
    case 'listing-not-impersonated':
      return warning.listingFromKeyFile
        ? (
          <>
            gcloud is set to impersonate <Principal>{warning.gcloudTarget}</Principal>{' '}
            (<Command>auth/impersonate_service_account</Command>), so downloads run as that, but bucket listing uses
            this provider&apos;s <Command>keyFile</Command>. If that setting isn&apos;t meant for CostGoblin, run{' '}
            <Command>{UNSET_GCLOUD_IMPERSONATION}</Command>.
          </>
        )
        : (
          <>
            gcloud is set to impersonate <Principal>{warning.gcloudTarget}</Principal>{' '}
            (<Command>auth/impersonate_service_account</Command>), so downloads run as that, but bucket listing
            doesn&apos;t impersonate it. To read as it on both halves, <SetReader target={warning.gcloudTarget} />. If that
            setting isn&apos;t meant for CostGoblin, run <Command>{UNSET_GCLOUD_IMPERSONATION}</Command>.
          </>
        );
    case 'download-not-impersonated':
      return (
        <>
          Bucket listing impersonates <Principal>{warning.listingTarget}</Principal> through your Application Default
          Credentials, but this provider names no read-only service account, so downloads don&apos;t impersonate
          anything — they run as gcloud&apos;s own identity, bypassing it. To read as it on both halves, <SetReader target={warning.listingTarget} />.
        </>
      );
    case 'split-accounts':
      return (
        <>
          Downloads run as <Principal>{warning.downloadAccount}</Principal>, but bucket listing runs as{' '}
          <Principal>{warning.listingAccount}</Principal> — two different accounts,{' '}
          {warning.sharedTarget === null
            ? 'and each needs its own access.'
            : <>and both need Service Account Token Creator on <Principal>{warning.sharedTarget}</Principal>.</>}{' '}
          <SplitAccountsRemedy warning={warning} />
        </>
      );
  }
}

function NoteText({ note }: Readonly<{ note: GcpIdentityNote }>): React.JSX.Element {
  return (
    <>
      Application Default Credentials don&apos;t record which account signed in (an{' '}
      <Command>--impersonate-service-account</Command> sign-in never does), so this can&apos;t be checked: downloads run
      as <Principal>{note.downloadAccount}</Principal>
      {note.downloadTarget === null
        ? ', which should be the account you signed in with.'
        : <>, which should be the account you signed in with — and needs permission to impersonate <Principal>{note.downloadTarget}</Principal> too.</>}
      {' '}Signing in again with <Command>{GCLOUD_ADC_LOGIN_COMMAND}</Command> records it.
    </>
  );
}
