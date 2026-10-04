import { useState } from 'react';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND, isServiceAccountEmail } from '@costgoblin/core/browser';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpGcloudImpersonation,
  GcpIdentities,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
  GcpListingImpersonationVia,
  GcpReaderAdvice,
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
 *  list) run with gcloud's own credentials. Before this panel the only way to
 *  learn either was an error naming the denied principal. It shows both, and
 *  says in plain words when they disagree in a way that will break (or
 *  silently re-route) a sync. Read-only: every remedy is a command to run or
 *  a config edit, never an action taken here.
 *
 *  `context: 'wizard'` renders the compact form: just the account gcloud is
 *  signed in as (it lists the projects the wizard offers), plus one line when
 *  something would stop the setup. The wizard always creates a new provider,
 *  whose reader is the wizard's own field rather than anything to report
 *  here, so it says nothing about impersonation. `context: 'provider'` (Data
 *  Management) shows both paths in full, with that provider's
 *  `impersonateServiceAccount` / `keyFile` applied. */
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

/** What every sign-in remedy needs to know, computed once per panel so all
 *  of them go through `AdcRemedy` and agree. */
interface AdcContext {
  /** Where a sign-in writes when that is not what the SDK reads. */
  readonly loginPath: string | null;
  /** The plain sign-in, as it must be typed: a terminal's
   *  `application-default login` honours gcloud's own
   *  `auth/impersonate_service_account`, so when that is set it is blanked. */
  readonly loginCommand: string;
  /** A provider without a reader that lists through a legacy impersonated
   *  ADC reads as this account only because of that sign-in. A plain one
   *  would widen it to the user's own access, so every re-sign-in remedy
   *  first has the user name it as the provider's reader. */
  readonly keepTarget: string | null;
}

const ADC_LOGIN_IGNORING_GCLOUD_IMPERSONATION = `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT= ${GCLOUD_ADC_LOGIN_COMMAND}`;

function adcContext(identities: GcpIdentities): AdcContext {
  const { listing } = identities;
  return {
    loginPath: identities.adcLoginPath,
    loginCommand: identities.gcloudImpersonation === null ? GCLOUD_ADC_LOGIN_COMMAND : ADC_LOGIN_IGNORING_GCLOUD_IMPERSONATION,
    keepTarget: listing.kind === 'impersonated' && listing.via.kind === 'credential' && listing.file.origin !== 'key-file'
      ? listing.target
      : null,
  };
}

const isExpired = (account: GcpAccountLookup): boolean => account.status === 'unknown' && account.reason === 'expired';

/** Nothing to act on: both halves resolved, nobody signed out or expired, no
 *  warning. Then the panel is one line — who signs in and who it reads as —
 *  with the full breakdown behind Details; anything less shows it open. */
function isHealthy({ listing, download, warnings }: GcpIdentities): boolean {
  if (warnings.length > 0) return false;
  if (download.kind !== 'gcloud') return false;
  if (download.principal.kind === 'account' && download.principal.account === null) return false;
  switch (listing.kind) {
    case 'user': return !isExpired(listing.account);
    case 'impersonated': return listing.source.kind !== 'user' || !isExpired(listing.source.account);
    case 'service-account':
    case 'external':
      return true;
    case 'not-signed-in':
    case 'unreadable':
    case 'unrecognized':
      return false;
  }
}

/** The healthy panel's line: the account gcloud runs as, and the reader both
 *  halves impersonate when there is one (with no warning, they agree). */
function Summary({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element | null {
  const { listing, download } = identities;
  if (download.kind !== 'gcloud') return null;
  const target = download.impersonate?.target ?? (listing.kind === 'impersonated' ? listing.target : null);
  return (
    <p className="min-w-0 break-words">
      <DownloadPrincipalText principal={download.principal} />
      {target !== null && <><span className="text-text-muted"> · reads as </span><Principal>{target}</Principal></>}
    </p>
  );
}

function Identities({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  if (!isHealthy(identities)) return <IdentityBreakdown identities={identities} />;
  return (
    <div className="mt-1">
      <Summary identities={identities} />
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text-secondary">Details</summary>
        <IdentityBreakdown identities={identities} />
      </details>
    </div>
  );
}

function IdentityBreakdown({ identities }: Readonly<{ identities: GcpIdentities }>): React.JSX.Element {
  const adc = adcContext(identities);
  return (
    <>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-text-muted">Bucket listing</dt>
        <dd className="min-w-0"><ListingIdentity identity={identities.listing} adc={adc} /></dd>
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
              <WarningText warning={warning} adc={adc} />
            </li>
          ))}
        </ul>
      )}
      {identities.notes.length > 0 && (
        <ul aria-label="Credential notes" className="mt-2 flex flex-col gap-1.5">
          {identities.notes.map(note => (
            <li key={note.kind} className="text-text-muted break-words">
              <NoteText note={note} listing={identities.listing} adc={adc} />
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
          Bucket access isn&apos;t signed in — <AdcRemedy file={adcFile} adc={adcContext(identities)} />
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

/** Workload or workforce identity federation, the same words for ADC as the
 *  listing credential and as the source a reader is minted from. */
function Federation({ target }: Readonly<{ target: string | null }>): React.JSX.Element {
  return (
    <>
      <span className="text-text-secondary">Workload or workforce identity federation</span>
      {target !== null && <Impersonating target={target} />}
    </>
  );
}

/** Unsetting a variable in CostGoblin's environment — what a gcloud setting
 *  from `CLOUDSDK_*` needs, since `gcloud config unset` cannot beat it. */
function UnsetEnv({ name }: Readonly<{ name: string }>): React.JSX.Element {
  return <>unset <Command>{name}</Command> in CostGoblin&apos;s environment</>;
}

/** How to get a working ADC file — the one place every sign-in remedy comes
 *  from. It depends on which file the SDK reads (a sign-in rewrites only the
 *  well-known one), where gcloud would write it, whether gcloud's own
 *  impersonation setting must be blanked for the sign-in to be plain, and
 *  whether a reader-less provider depends on the current sign-in's
 *  impersonation. */
function AdcRemedy({ file, adc }: Readonly<{ file: GcpCredentialFile | null; adc: AdcContext }>): React.JSX.Element {
  if (file?.origin === 'env') {
    return (
      <>
        fix or unset <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> — it names this file, and signing in
        again writes a different one
      </>
    );
  }
  if (file?.origin === 'key-file') return <>check the provider&apos;s <Command>keyFile</Command></>;
  const signIn = adc.loginPath === null
    ? <>run <Command>{adc.loginCommand}</Command></>
    : (
      <>
        run <Command>{adc.loginCommand}</Command> — but <Command>CLOUDSDK_CONFIG</Command> is set, so gcloud
        writes <Command>{adc.loginPath}</Command>, which CostGoblin doesn&apos;t read: unset{' '}
        <Command>CLOUDSDK_CONFIG</Command>, or point <Command>GOOGLE_APPLICATION_CREDENTIALS</Command> at that file
      </>
    );
  if (adc.keepTarget === null) return signIn;
  if (!isServiceAccountEmail(adc.keepTarget)) {
    return (
      <>
        don&apos;t sign in plainly: this provider reads as <Principal>{adc.keepTarget}</Principal> only through the current
        sign-in, and that isn&apos;t a service-account address it can name as its own reader — signing in plainly would widen
        it to your own access
      </>
    );
  }
  return (
    <>
      first add <Command>{`impersonateServiceAccount: ${adc.keepTarget}`}</Command> to this provider in{' '}
      <Command>costgoblin.yaml</Command> — it reads as that account only through the current sign-in, and a plain one would
      widen it to your own access; then {signIn}
    </>
  );
}

function AccountText({ account }: Readonly<{ account: GcpAccountLookup }>): React.JSX.Element {
  if (account.status === 'known') return <Principal>{account.email}</Principal>;
  switch (account.reason) {
    case 'expired':
      return <span className="text-text-secondary">a Google account whose sign-in has expired</span>;
    case 'unreachable':
      return <span className="text-text-secondary">a Google account (couldn&apos;t reach Google to check which)</span>;
    case 'not-recorded':
      return <span className="text-text-secondary">your Google account (the credential doesn&apos;t record which)</span>;
  }
}

/** The remedy for an expired sign-in, on its own line — never run on into
 *  the "impersonating …" that follows the account. */
function ExpiredRemedy({ account, file, adc }: Readonly<{ account: GcpAccountLookup; file: GcpCredentialFile; adc: AdcContext }>): React.JSX.Element | null {
  if (account.status !== 'unknown' || account.reason !== 'expired') return null;
  return <Detail>To sign in again, <AdcRemedy file={file} adc={adc} />.</Detail>;
}

function SourceText({ source }: Readonly<{ source: GcpImpersonationSource }>): React.JSX.Element {
  switch (source.kind) {
    case 'user': return <AccountText account={source.account} />;
    case 'service-account': return <Principal>{source.email}</Principal>;
    case 'federated': return <Federation target={source.target} />;
    case 'other':
      return <span className="text-text-secondary">an unrecognized credential{source.type === null ? '' : ` (${source.type})`}</span>;
  }
}

/** Where listing's impersonation comes from: the provider's read-only
 *  service account, or (no reader) a legacy impersonated ADC file itself. */
function ImpersonationDetail({ via, target }: Readonly<{ via: GcpListingImpersonationVia; target: string }>): React.JSX.Element {
  if (via.kind === 'credential') {
    return <Detail>Impersonated by the credential itself (an <Command>--impersonate-service-account</Command> sign-in) — this provider names no read-only service account</Detail>;
  }
  return (
    <>
      <Detail>This provider&apos;s read-only service account (<Command>impersonateServiceAccount</Command>), minted from your sign-in</Detail>
      {via.adcTarget !== null && (
        via.adcTarget.toLowerCase() === target.toLowerCase()
          ? (
            <Detail>
              Your Application Default Credentials impersonate this same account themselves; this provider mints it from
              the sign-in underneath rather than through them
            </Detail>
          )
          : (
            <Detail>
              Your Application Default Credentials impersonate <Principal>{via.adcTarget}</Principal> themselves; this provider
              doesn&apos;t use that — it mints its reader from the sign-in underneath
            </Detail>
          )
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

function ListingIdentity({ identity, adc }: Readonly<{ identity: GcpListingIdentity; adc: AdcContext }>): React.JSX.Element {
  switch (identity.kind) {
    case 'not-signed-in':
      return (
        <>
          <span className="text-negative">Not signed in</span> — <AdcRemedy file={identity.file} adc={adc} />
          {identity.file !== null && <Detail>No file at {identity.file.path}</Detail>}
        </>
      );
    case 'unreadable':
      return (
        <>
          <span className="text-negative">Couldn&apos;t read the credential file</span> — <AdcRemedy file={identity.file} adc={adc} />
          <Detail>{identity.file.path}</Detail>
        </>
      );
    case 'user':
      return (
        <>
          <AccountText account={identity.account} />
          <Detail>{fileDetail(identity.file)}</Detail>
          <ExpiredRemedy account={identity.account} file={identity.file} adc={adc} />
        </>
      );
    case 'impersonated':
      return (
        <>
          <SourceText source={identity.source} />
          <Impersonating target={identity.target} />
          <ImpersonationDetail via={identity.via} target={identity.target} />
          <Detail>{fileDetail(identity.file)}</Detail>
          {identity.source.kind === 'user' && <ExpiredRemedy account={identity.source.account} file={identity.file} adc={adc} />}
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
          <Federation target={identity.target} />
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
        ? <span className="text-text-secondary">a credential file it can&apos;t name</span>
        : <Principal>{principal.email}</Principal>;
    case 'access-token-file':
    case 'access-token':
      return <span className="text-text-secondary">a pre-minted access token (gcloud doesn&apos;t say whose)</span>;
  }
}

function keyFileDetail(path: string, origin: Extract<GcpDownloadPrincipal, { kind: 'key-file' }>['origin']): string {
  switch (origin) {
    case 'provider': return `Provider keyFile · ${path}`;
    case 'gcloud-config': return `gcloud's auth/credential_file_override · ${path}`;
    case 'env': return `gcloud's auth/credential_file_override · ${path} · set by CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`;
  }
}

function principalDetail(principal: GcpDownloadPrincipal): string | null {
  switch (principal.kind) {
    case 'account': return principal.fromEnv ? 'account set by CLOUDSDK_CORE_ACCOUNT' : null;
    case 'key-file': return keyFileDetail(principal.path, principal.origin);
    case 'access-token-file':
      return `gcloud's auth/access_token_file · ${principal.path}${principal.origin === 'env' ? ' · set by CLOUDSDK_AUTH_ACCESS_TOKEN_FILE' : ''}`;
    case 'access-token': return 'CLOUDSDK_AUTH_ACCESS_TOKEN in CostGoblin\'s environment';
  }
}

function impersonationOriginDetail(impersonate: GcpDownloadImpersonation | null): string {
  switch (impersonate?.origin) {
    case undefined:
    case 'provider':
      return '';
    case 'gcloud-config': return ' · impersonation from gcloud\'s auth/impersonate_service_account';
    case 'env': return ' · impersonation from CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT';
    case 'credential-file': return ' · impersonation built into the credential file';
  }
}

/** A delegation chain gcloud walks to its target, written out. */
function chainText(delegates: readonly string[], target: string): string {
  return [...delegates, target].join(' → ');
}

function DownloadIdentity({ identity }: Readonly<{ identity: GcpDownloadIdentity }>): React.JSX.Element {
  switch (identity.kind) {
    case 'gcloud': {
      const { principal, impersonate } = identity;
      const extra = principalDetail(principal);
      return (
        <>
          <DownloadPrincipalText principal={principal} />
          {impersonate !== null && <Impersonating target={impersonate.target} />}
          <Detail>
            gcloud CLI · configuration &quot;{identity.configuration}&quot;{impersonationOriginDetail(impersonate)}
          </Detail>
          {impersonate !== null && impersonate.origin !== 'provider' && impersonate.origin !== 'credential-file' && impersonate.delegates.length > 0 && (
            <Detail>Through the delegation chain {chainText(impersonate.delegates, impersonate.target)}</Detail>
          )}
          {extra !== null && <Detail>{extra}</Detail>}
          {principal.kind === 'account' && principal.account === null && (
            principal.fromEnv
              ? <Detail><Command>CLOUDSDK_CORE_ACCOUNT</Command> is set but empty — <UnsetEnv name="CLOUDSDK_CORE_ACCOUNT" />.</Detail>
              : <Detail>Run <Command>{GCLOUD_CLI_LOGIN_COMMAND}</Command> to sign gcloud in.</Detail>
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

/** Naming a reader on the provider — the fix for most impersonation
 *  disagreements: it drives both halves (listing mints it from the user's
 *  sign-in; downloads pass it to gcloud as a flag, beating gcloud's own
 *  setting). Only in the config file: the wizard creates providers, it does
 *  not edit an existing one. */
function SetReader({ target }: Readonly<{ target: string }>): React.JSX.Element {
  return (
    <>
      add <Command>{`impersonateServiceAccount: ${target}`}</Command> to this provider in{' '}
      <Command>costgoblin.yaml</Command> — both halves then impersonate it, minted from your own sign-in
    </>
  );
}

/** What makes downloads impersonate `gcloud`'s target, in a clause:
 *  "gcloud is set to impersonate … (…)". */
function GcloudImpersonationClause({ gcloud }: Readonly<{ gcloud: GcpGcloudImpersonation }>): React.JSX.Element {
  switch (gcloud.origin) {
    case 'gcloud-config':
    case 'env':
      return (
        <>
          gcloud is set to impersonate <Principal>{gcloud.target}</Principal>{' '}
          (<Command>auth/impersonate_service_account</Command>
          {gcloud.origin === 'env' && <>, from <Command>CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT</Command> in CostGoblin&apos;s environment</>}
          {gcloud.delegates.length > 0 && <>, through the delegation chain {chainText(gcloud.delegates, gcloud.target)}</>})
        </>
      );
    case 'credential-file':
      return (
        <>
          the credential file gcloud is given impersonates <Principal>{gcloud.target}</Principal> by itself (
          {gcloud.fileOrigin === 'provider' && <>this provider&apos;s <Command>keyFile</Command></>}
          {gcloud.fileOrigin === 'gcloud-config' && <Command>auth/credential_file_override</Command>}
          {gcloud.fileOrigin === 'env' && <><Command>CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE</Command> in CostGoblin&apos;s environment</>})
        </>
      );
  }
}

/** How to take away the impersonation the provider did not ask for. */
function UndoGcloudImpersonation({ gcloud }: Readonly<{ gcloud: GcpGcloudImpersonation }>): React.JSX.Element {
  switch (gcloud.origin) {
    case 'gcloud-config': return <>run <Command>gcloud config unset auth/impersonate_service_account</Command></>;
    case 'env': return <UnsetEnv name="CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT" />;
    case 'credential-file': return <UndoCredentialFile origin={gcloud.fileOrigin} />;
  }
}

function UndoCredentialFile({ origin }: Readonly<{ origin: Extract<GcpGcloudImpersonation, { origin: 'credential-file' }>['fileOrigin'] }>): React.JSX.Element {
  switch (origin) {
    case 'gcloud-config': return <>run <Command>gcloud config unset auth/credential_file_override</Command></>;
    case 'env': return <UnsetEnv name="CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE" />;
    case 'provider': return <>point this provider&apos;s <Command>keyFile</Command> at a key that doesn&apos;t impersonate</>;
  }
}

/** Why a reader is not the fix, when it is not. Null for `set-reader` and
 *  `key-file-provider`, which each warning words itself. */
function NoReaderReason({ advice }: Readonly<{ advice: GcpReaderAdvice }>): React.JSX.Element | null {
  switch (advice.kind) {
    case 'set-reader':
    case 'key-file-provider':
      return null;
    case 'not-a-reader':
      return <><Principal>{advice.target}</Principal> isn&apos;t a service-account address a provider can name as its read-only service account.{' '}</>;
    case 'delegation-chain':
      return (
        <>
          gcloud reaches <Principal>{advice.target}</Principal> through a delegation chain
          ({chainText(advice.delegates, advice.target)}), and a provider names a single read-only service account — naming
          the last hop alone would skip the others.{' '}
        </>
      );
    case 'download-is-target':
      return <>gcloud already authenticates as <Principal>{advice.target}</Principal> itself, so naming it would have downloads impersonate the account they already are.{' '}</>;
  }
}

function SplitAccountsRemedy({ warning, adc }: Readonly<{ warning: Extract<GcpIdentityWarning, { kind: 'split-accounts' }>; adc: AdcContext }>): React.JSX.Element {
  const onProvider = 'on this provider';
  if (isServiceAccount(warning.listingAccount)) {
    if (warning.sharedTarget !== null) {
      // keyFile and impersonateServiceAccount are exclusive, so the reader
      // can't move onto the key: move listing onto the user's own sign-in.
      return (
        <>
          Listing mints the reader from a service-account key in Application Default Credentials. To mint it from your own
          account, as downloads do, <AdcRemedy file={warning.listingKeyFile} adc={adc} />.
        </>
      );
    }
    // A provider keyFile beats every gcloud credential below a token, so it
    // puts downloads on the same key whatever gcloud is signed in as.
    return warning.listingKeyFile === null
      ? <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key — set <Command>keyFile</Command> {onProvider} so both halves use it.</>
      : <>gcloud can only act as <Principal>{warning.listingAccount}</Principal> through its key: set <Command>{`keyFile: ${warning.listingKeyFile.path}`}</Command> {onProvider} so both halves use it.</>;
  }
  return <DownloadSideRemedy principal={warning.downloadPrincipal} listingAccount={warning.listingAccount} />;
}

/** Moving downloads onto listing's account, by what gcloud authenticates
 *  with — following gcloud's own precedence, so the remedy undoes the
 *  setting that actually wins. */
function DownloadSideRemedy({ principal, listingAccount }: Readonly<{ principal: GcpDownloadPrincipal; listingAccount: string }>): React.JSX.Element {
  switch (principal.kind) {
    case 'key-file':
      return <KeyFileOverrideRemedy origin={principal.origin} />;
    case 'account':
      if (principal.fromEnv) {
        return <>gcloud&apos;s account is set by <Command>CLOUDSDK_CORE_ACCOUNT</Command> in CostGoblin&apos;s environment — change or unset it there.</>;
      }
      return (
        <>
          To use one account for both, run <Command>{`gcloud config set account ${listingAccount}`}</Command> — and if gcloud has
          never signed in as that account, <Command>{`${GCLOUD_CLI_LOGIN_COMMAND} ${listingAccount}`}</Command> first.
        </>
      );
    case 'access-token-file':
    case 'access-token':
      // A token never names an account, so no split is reported for one.
      return <>gcloud authenticates with a pre-minted token instead of an account.</>;
  }
}

function KeyFileOverrideRemedy({ origin }: Readonly<{ origin: Extract<GcpDownloadPrincipal, { kind: 'key-file' }>['origin'] }>): React.JSX.Element {
  switch (origin) {
    case 'gcloud-config':
      return <>gcloud authenticates with the credential file in <Command>auth/credential_file_override</Command> rather than its signed-in account — run <Command>gcloud config unset auth/credential_file_override</Command>.</>;
    case 'env':
      return <>gcloud authenticates with the credential file in <Command>CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE</Command> rather than its signed-in account — <UnsetEnv name="CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE" />.</>;
    case 'provider':
      return <>Both halves should use this provider&apos;s <Command>keyFile</Command> — check that it names the key you expect.</>;
  }
}

function listingThrough(advice: GcpReaderAdvice): React.JSX.Element {
  return advice.kind === 'key-file-provider'
    ? <>this provider&apos;s <Command>keyFile</Command></>
    : <>your Application Default Credentials</>;
}

function WarningText({ warning, adc }: Readonly<{ warning: GcpIdentityWarning; adc: AdcContext }>): React.JSX.Element {
  switch (warning.kind) {
    case 'target-mismatch':
      return (
        <>
          Bucket listing impersonates <Principal>{warning.listingTarget}</Principal> through {listingThrough(warning.advice)}, but{' '}
          <GcloudImpersonationClause gcloud={warning.gcloud} />, so downloads run as that instead.{' '}
          <NoReaderReason advice={warning.advice} />
          {warning.advice.kind === 'set-reader'
            ? <>To read as one account, <SetReader target={warning.advice.target} />.</>
            // Undoing gcloud's side alone leaves downloads impersonating
            // nothing — fine only where listing's impersonation is the key
            // file's own, which the download then shares.
            : warning.advice.kind === 'key-file-provider'
              ? <>To read as one account, <UndoGcloudImpersonation gcloud={warning.gcloud} />.</>
              : <>To read as one account, <UndoGcloudImpersonation gcloud={warning.gcloud} /> — downloads then run as gcloud&apos;s own identity.</>}
        </>
      );
    case 'listing-not-impersonated':
      return (
        <>
          <GcloudImpersonationClause gcloud={warning.gcloud} />, so downloads run as that, but bucket listing{' '}
          {warning.advice.kind === 'key-file-provider'
            ? <>uses this provider&apos;s <Command>keyFile</Command>.</>
            : <>doesn&apos;t impersonate it.</>}{' '}
          <NoReaderReason advice={warning.advice} />
          {warning.advice.kind === 'set-reader' && <>To read as it on both halves, <SetReader target={warning.advice.target} />. </>}
          If that setting isn&apos;t meant for CostGoblin, <UndoGcloudImpersonation gcloud={warning.gcloud} />.
        </>
      );
    case 'download-not-impersonated':
      return (
        <>
          Bucket listing impersonates <Principal>{warning.listingTarget}</Principal> through {listingThrough(warning.advice)}, but
          this provider names no read-only service account, so downloads don&apos;t impersonate anything — they run as
          gcloud&apos;s own identity, bypassing it.{' '}
          <NoReaderReason advice={warning.advice} />
          {warning.advice.kind === 'set-reader' && <>To read as it on both halves, <SetReader target={warning.advice.target} />.</>}
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
          <SplitAccountsRemedy warning={warning} adc={adc} />
        </>
      );
  }
}

function NoteText({ note, listing, adc }: Readonly<{ note: GcpIdentityNote; listing: GcpListingIdentity; adc: AdcContext }>): React.JSX.Element {
  const file = listing.file;
  return (
    <>
      Application Default Credentials don&apos;t record which account signed in (an{' '}
      <Command>--impersonate-service-account</Command> sign-in never does), so this can&apos;t be checked: downloads run
      as <Principal>{note.downloadAccount}</Principal>
      {note.downloadTarget === null
        ? ', which should be the account you signed in with.'
        : <>, which should be the account you signed in with — and needs permission to impersonate <Principal>{note.downloadTarget}</Principal> too.</>}
      {/* A key file records whatever it records; there is no sign-in to redo. */}
      {file?.origin !== 'key-file' && <>{' '}To record it, <AdcRemedy file={file} adc={adc} />.</>}
    </>
  );
}
