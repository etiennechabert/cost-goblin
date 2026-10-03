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
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

type PanelContext = 'wizard' | 'provider';

/** "Signed in as" — which Google identities a GCP setup runs as.
 *
 *  A GCP sync authenticates twice, through two stores that different commands
 *  change: bucket listing reads Application Default Credentials (or the
 *  provider's key file), while downloads (and the wizard's project list) run
 *  with gcloud's own credentials. Before this panel the only way to learn
 *  either was an error naming the denied principal. It shows both, and says
 *  in plain words when they disagree in a way that will break (or silently
 *  re-route) a sync. Read-only: every remedy is a command to run, never an
 *  action taken here.
 *
 *  `context` only changes copy: in the wizard the gcloud identity also lists
 *  projects, which is the usual reason someone switches it, and there is no
 *  provider yet to edit. */
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
        <Identities identities={query.data.identities} context={context} />
      )}
    </section>
  );
}

function Identities({ identities, context }: Readonly<{ identities: GcpIdentities; context: PanelContext }>): React.JSX.Element {
  const adcRemedy = { target: adcRemedyTarget(identities), loginPath: identities.adcLoginPath };
  return (
    <>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-text-muted">Bucket listing</dt>
        <dd className="min-w-0"><ListingIdentity identity={identities.listing} remedy={adcRemedy} /></dd>
        <dt className="text-text-muted">{context === 'wizard' ? 'Downloads & projects' : 'Downloads'}</dt>
        <dd className="min-w-0"><DownloadIdentity identity={identities.download} /></dd>
      </dl>
      {identities.warnings.length > 0 && (
        <ul aria-label="Credential warnings" className="mt-2 flex flex-col gap-1.5">
          {identities.warnings.map(warning => (
            <li
              key={warning.kind}
              className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-text-primary break-words"
            >
              <WarningText warning={warning} context={context} />
            </li>
          ))}
        </ul>
      )}
      {identities.notes.length > 0 && (
        <ul aria-label="Credential notes" className="mt-2 flex flex-col gap-1.5">
          {identities.notes.map(note => (
            <li key={note.kind} className="text-text-muted break-words">
              <NoteText note={note} context={context} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The service account a fresh ADC sign-in should impersonate: the one the
 *  downloads use, else the one ADC impersonates today. A bare re-login would
 *  REPLACE an impersonating credential with a plain-user one — the remedy
 *  must never be the thing that bypasses the least-privilege reader. */
function adcRemedyTarget(identities: GcpIdentities): string | null {
  if (identities.download.kind === 'gcloud' && identities.download.impersonate !== null) return identities.download.impersonate.target;
  const { listing } = identities;
  return listing.kind === 'impersonated' ? listing.target : null;
}

function adcLoginCommand(target: string | null): string {
  return target === null ? GCLOUD_ADC_LOGIN_COMMAND : `${GCLOUD_ADC_LOGIN_COMMAND} --impersonate-service-account=${target}`;
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

/** How to get a working ADC file, given which file the SDK reads. */
function AdcRemedy({ file, target, loginPath }: Readonly<{ file: GcpCredentialFile | null; target: string | null; loginPath: string | null }>): React.JSX.Element {
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
        run <Command>{adcLoginCommand(target)}</Command> — but <Command>CLOUDSDK_CONFIG</Command> is set, so gcloud
        writes <Command>{loginPath}</Command>, which CostGoblin doesn&apos;t read: unset{' '}
        <Command>CLOUDSDK_CONFIG</Command>, or point <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> at that file
      </>
    );
  }
  return <>run <Command>{adcLoginCommand(target)}</Command></>;
}

interface AdcRemedyInputs { readonly target: string | null; readonly loginPath: string | null }

function AccountText({ account, file, remedy }: Readonly<{ account: GcpAccountLookup; file: GcpCredentialFile; remedy: AdcRemedyInputs }>): React.JSX.Element {
  if (account.status === 'known') return <Principal>{account.email}</Principal>;
  switch (account.reason) {
    case 'expired':
      return <span className="text-text-secondary">a Google account whose sign-in has expired — <AdcRemedy file={file} {...remedy} /></span>;
    case 'unreachable':
      return <span className="text-text-secondary">a Google account (couldn&apos;t reach Google to check which)</span>;
    case 'not-recorded':
      return <span className="text-text-secondary">your Google account (the credential doesn&apos;t record which)</span>;
  }
}

function SourceText({ source, file, remedy }: Readonly<{ source: GcpImpersonationSource; file: GcpCredentialFile; remedy: AdcRemedyInputs }>): React.JSX.Element {
  if (source.kind === 'user') return <AccountText account={source.account} file={file} remedy={remedy} />;
  if (source.kind === 'service-account') return <Principal>{source.email}</Principal>;
  return <span className="text-text-secondary">an unrecognized credential{source.type === null ? '' : ` (${source.type})`}</span>;
}

function fileDetail(file: GcpCredentialFile): string {
  switch (file.origin) {
    case 'env': return `Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) · ${file.path}`;
    case 'well-known': return `Application Default Credentials · ${file.path}`;
    case 'key-file': return `Provider keyFile · ${file.path}`;
  }
}

function ListingIdentity({ identity, remedy }: Readonly<{ identity: GcpListingIdentity; remedy: AdcRemedyInputs }>): React.JSX.Element {
  switch (identity.kind) {
    case 'not-signed-in':
      return (
        <>
          <span className="text-negative">Not signed in</span> — <AdcRemedy file={identity.file} {...remedy} />
          {identity.file !== null && <Detail>No file at {identity.file.path}</Detail>}
        </>
      );
    case 'unreadable':
      return (
        <>
          <span className="text-negative">Couldn&apos;t read the credential file</span> — <AdcRemedy file={identity.file} {...remedy} />
          <Detail>{identity.file.path}</Detail>
        </>
      );
    case 'user':
      return (
        <>
          <AccountText account={identity.account} file={identity.file} remedy={remedy} />
          <Detail>{fileDetail(identity.file)}</Detail>
        </>
      );
    case 'impersonated':
      return (
        <>
          <SourceText source={identity.source} file={identity.file} remedy={remedy} />
          <Impersonating target={identity.target} />
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

function runsAs(context: PanelContext): string {
  return context === 'wizard' ? 'Downloads and the project list run' : 'Downloads run';
}

function SplitAccountsRemedy({ warning, context }: Readonly<{ warning: Extract<GcpIdentityWarning, { kind: 'split-accounts' }>; context: PanelContext }>): React.JSX.Element {
  const onProvider = context === 'wizard' ? 'on the provider after setup' : 'on this provider';
  if (warning.downloadAccountFromEnv) {
    return <>gcloud&apos;s account is set by <Command>CLOUDSDK_CORE_ACCOUNT</Command> in CostGoblin&apos;s environment — change or unset it there.</>;
  }
  if (warning.listingKeyFile !== null) {
    return <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key: set <Command>{`keyFile: ${warning.listingKeyFile}`}</Command> {onProvider} so both halves use it.</>;
  }
  if (isServiceAccount(warning.listingAccount)) {
    return <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key — set <Command>keyFile</Command> {onProvider} so both halves use it.</>;
  }
  return (
    <>
      {context === 'wizard' && 'If you switched gcloud to another account just to list projects, switch it back before syncing. '}
      To use one account for both, run <Command>{`gcloud config set account ${warning.listingAccount}`}</Command> — and if gcloud has
      never signed in as that account, <Command>{`${GCLOUD_CLI_LOGIN_COMMAND} ${warning.listingAccount}`}</Command> first.
    </>
  );
}

function WarningText({ warning, context }: Readonly<{ warning: GcpIdentityWarning; context: PanelContext }>): React.JSX.Element {
  switch (warning.kind) {
    case 'target-mismatch':
      return warning.download.origin === 'provider'
        ? (
          <>
            Bucket listing impersonates <Principal>{warning.listingTarget}</Principal>, but this provider downloads
            as <Principal>{warning.download.target}</Principal>. Application Default Credentials are machine-wide, so
            they were last set up for a different service account. Run{' '}
            <Command>{adcLoginCommand(warning.download.target)}</Command> — any other provider relying on{' '}
            <Principal>{warning.listingTarget}</Principal> will switch too.
          </>
        )
        : (
          <>
            Bucket listing impersonates <Principal>{warning.listingTarget}</Principal>, but gcloud is set to impersonate{' '}
            <Principal>{warning.download.target}</Principal> (<Command>auth/impersonate_service_account</Command>), so{' '}
            {runsAs(context).toLowerCase()} as that instead. Run <Command>gcloud config unset auth/impersonate_service_account</Command>,
            or set <Command>{`impersonateServiceAccount: ${warning.listingTarget}`}</Command>{' '}
            {context === 'wizard' ? 'on the provider after setup' : 'on this provider'} — it takes precedence.
          </>
        );
    case 'listing-not-impersonated':
      return warning.download.origin === 'provider'
        ? (
          <>
            This provider downloads as <Principal>{warning.download.target}</Principal>, but bucket listing doesn&apos;t
            impersonate it, so listing runs as the signed-in identity itself. Run{' '}
            <Command>{adcLoginCommand(warning.download.target)}</Command>.
          </>
        )
        : (
          <>
            gcloud is set to impersonate <Principal>{warning.download.target}</Principal>{' '}
            (<Command>auth/impersonate_service_account</Command>), so {runsAs(context).toLowerCase()} as that, but bucket
            listing doesn&apos;t impersonate it. If that setting isn&apos;t meant for CostGoblin, run{' '}
            <Command>gcloud config unset auth/impersonate_service_account</Command>.
          </>
        );
    case 'download-not-impersonated':
      return (
        <>
          Bucket listing impersonates <Principal>{warning.listingTarget}</Principal>, but downloads don&apos;t impersonate
          anything — they run as gcloud&apos;s own identity, bypassing that service account.{' '}
          {context === 'wizard'
            ? 'The wizard doesn\'t set this, so after setup add '
            : 'Add '}
          <Command>{`impersonateServiceAccount: ${warning.listingTarget}`}</Command> to the provider in{' '}
          <Command>costgoblin.yaml</Command>.
        </>
      );
    case 'split-accounts':
      return (
        <>
          {runsAs(context)} as <Principal>{warning.downloadAccount}</Principal>, but bucket listing runs as{' '}
          <Principal>{warning.listingAccount}</Principal> — two different accounts, and each needs its own
          access. <SplitAccountsRemedy warning={warning} context={context} />
        </>
      );
  }
}

function NoteText({ note, context }: Readonly<{ note: GcpIdentityNote; context: PanelContext }>): React.JSX.Element {
  return (
    <>
      Google doesn&apos;t record which account signed in to Application Default Credentials, so this can&apos;t be
      checked: {runsAs(context).toLowerCase()} as <Principal>{note.downloadAccount}</Principal>
      {note.downloadTarget === null
        ? ', which should be the account you signed in with.'
        : <>, which should be the account you signed in with — and needs permission to impersonate <Principal>{note.downloadTarget}</Principal> too.</>}
    </>
  );
}
