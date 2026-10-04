import type { ConfigBundleSummary, GcpProject, GcsDownloadCheckResult, GcsFolderKind, ProviderConfig } from '@costgoblin/core/browser';
import { DEFAULT_READER_ACCOUNT_ID, DEFAULT_RETENTION_DAYS, GCP_PROJECT_ID_RULES, gcsTiersOverlap, isGcpBucketListDeniedMessage, isGcpCredentialError, isGcpImpersonationError, isValidGcpProjectId, isValidWorkspaceName, parseProviderName, resolveReaderInput, SERVICE_ACCOUNT_EMAIL_RULE } from '@costgoblin/core/browser';
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { BundleSummaryCard, ImportConfigDialog } from '../components/config-sharing.js';
import { ProfilePicker } from '../components/profile-picker.js';
import { GcpIdentityPanel } from '../components/gcp-identity-panel.js';
import { GcloudLoginButton, RetryButton, SsoLoginButton } from '../components/sso-login-button.js';

type DataSource = 'daily' | 'hourly' | 'costOptimization';

/** The tiers the GCP exporter can publish. `costOptimization` is absent by
 *  design — GCP has no Cost Optimization Hub analogue, and `validateGcpSync`
 *  rejects the key outright. */
type GcpSource = 'daily' | 'hourly';

const SOURCE_LABELS: Record<DataSource, { title: string; description: string }> = {
  daily: { title: 'Daily FOCUS export', description: 'Main billing data — required' },
  hourly: { title: 'Hourly FOCUS export', description: 'For short-term drill-down and incident analysis' },
  costOptimization: { title: 'Cost Optimization', description: 'RI/SP recommendations and rightsizing suggestions' },
};

/** The project the GCP chain lists buckets in, and how the user supplied it.
 *  Rides on every GCP step so ← Back from the daily bucket step knows where it
 *  came from: a TYPED ID returns to the intro, which holds the typed entry,
 *  rather than starting the `gcloud projects list` the user just skipped. */
interface GcpProjectChoice { readonly id: string; readonly typed: boolean }
// The GCP steps carry `GcpProjectChoice | null`: null is per-tier Configure on
// a GCP provider, which knows its bucket but no project (the config records
// none, and browsing a bucket needs none). Listing buckets does need one.

/** Continue on the GCP intro proves the reader can be read as before moving
 *  on: the project's bucket listing runs as it, and an impersonation refusal
 *  (no such account in the project, or no Token Creator on it) stays on the
 *  intro, beside the field that names it. Keyed by the reader and project it
 *  ran for, so editing either drops a stale verdict. */
type GcpReaderCheck =
  | { readonly status: 'checking' }
  | { readonly status: 'denied'; readonly reader: string; readonly project: string; readonly message: string };

type WizardStep =
  | { step: 'welcome' }
  | { step: 'start' }
  | { step: 'gcp'; scaffolded: boolean; error: string; check?: GcpReaderCheck }
  | { step: 'gcp-project'; projects: readonly GcpProject[]; loading: boolean; selected: string; error: string }
  | { step: 'gcp-bucket'; project: GcpProjectChoice | null; source: GcpSource; buckets: readonly { name: string }[]; loading: boolean; selected: string; error: string }
  | { step: 'gcp-browse'; project: GcpProjectChoice | null; source: GcpSource; bucket: string; prefix: string; prefixes: readonly string[]; loading: boolean; folder: GcsFolderKind; hasParquet: boolean; truncated: boolean; error: string; path: string[] }
  | { step: 'profile'; profiles: string[]; loading: boolean; selected: string }
  | { step: 'bucket'; profile: string; source: DataSource; buckets: { name: string; region: string }[]; loading: boolean; selected: string; error: string }
  | { step: 'beacon'; profile: string; source: DataSource; bucket: string; content: string; summary: ConfigBundleSummary; applying: boolean; error: string }
  | { step: 'browse'; profile: string; source: DataSource; bucket: string; prefix: string; prefixes: string[]; loading: boolean; isBillingExport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'cur-legacy' | 'unknown'; missingColumns: string[]; path: string[]; error: string }
  | { step: 'confirm'; cloud: 'aws'; profile: string; s3Path: string; hourlyPath: string; costOptPath: string }
  | { step: 'confirm'; cloud: 'gcp'; project: GcpProjectChoice | null; reader: string; clearsReader: boolean; s3Path: string; hourlyPath: string; costOptPath: string };

/** One retention window per tier. Each tier needs its own: a year of daily is
 *  small, a year of hourly is ~24x that, so a single shared picker either
 *  over-keeps hourly or under-keeps daily. */
const RETENTION_OPTIONS: Readonly<Record<DataSource, readonly { days: number; label: string }[]>> = {
  daily: [
    { days: 90, label: '3 months' },
    { days: 180, label: '6 months' },
    { days: 365, label: '12 months' },
    { days: 730, label: '2 years' },
  ],
  hourly: [
    { days: 7, label: '7 days' },
    { days: 14, label: '14 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
  ],
  costOptimization: [
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 180, label: '6 months' },
  ],
};

/** No tier collected yet. Shared safely: every writer spreads a copy first. */
const EMPTY_PATHS: { readonly daily: string; readonly hourly: string; readonly costOpt: string } = { daily: '', hourly: '', costOpt: '' };

/** The steps that touch Google credentials, where the "Signed in as" panel
 *  shows. */
function isGcpStep(wizard: WizardStep): boolean {
  return wizard.step === 'gcp' || wizard.step === 'gcp-project' || wizard.step === 'gcp-bucket' || wizard.step === 'gcp-browse';
}

interface SetupWizardProps {
  /** Called when setup finishes. Carries the workspace name the user chose on
   *  the Welcome step when it differs from the initial one (first run only). */
  onComplete: (result?: { workspaceName?: string }) => void;
  source?: DataSource | undefined;
  profile?: string | undefined;
  /** The provider being reconfigured (source mode). writeConfig is an UPSERT
   *  by name, so per-tier Configure must target the provider it came from —
   *  the name renders read-only. Omitted in source mode, the first
   *  configured provider is targeted. */
  providerName?: string | undefined;
  /** Source mode for a GCP provider: the bucket holding its exports and the
   *  folder to open (the daily export's parent, where the exporter writes
   *  `hourly/` beside `daily/`). The GCP config records no project and
   *  browsing a bucket needs none, so the wizard opens straight in it —
   *  the same per-tier Configure the AWS tiers get. `profile` is not used. */
  /** `impersonateServiceAccount`: the provider's reader, so a per-tier
   *  Configure browses — and keeps writing — the identity the sync uses. */
  gcpSource?: { readonly bucket: string; readonly prefix: string; readonly impersonateServiceAccount?: string | undefined } | undefined;
  /** 'add' opens the wizard to create an ADDITIONAL provider: the name field
   *  starts empty, is required, and must not collide with an existing
   *  provider (the upsert would silently overwrite it). Default: first-run
   *  behavior (name prefilled with 'aws-main', editable). */
  mode?: 'add' | undefined;
  /** Present only on the true first run of a fresh install: shows the naming
   *  step first (prefilled with the current name) before the get-started hub. */
  workspaceNaming?: { initialName: string } | undefined;
  /** Active workspace name shown on the get-started hub when the workspace was
   *  already named before this boot (e.g. created via Settings → New workspace).
   *  Ignored when `workspaceNaming` is present — the typed name shows instead. */
  workspaceLabel?: string | undefined;
  /** Other configured workspaces the user can jump back into instead of
   *  setting this one up (switch & restart). */
  otherWorkspaces?: readonly string[] | undefined;
}

interface WelcomeNaming {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

interface JumpBackProps {
  readonly names: readonly string[];
  readonly onSwitch: (name: string) => void;
  readonly switchingTo: string | null;
  readonly error: string;
}

/** "Jump back into an existing workspace" section — an escape hatch out of the
 *  wizard when this boot landed in an unconfigured workspace but configured
 *  ones exist. Switching restarts the app. */
function JumpBackList({ jumpBack }: Readonly<{ jumpBack: JumpBackProps | undefined }>) {
  if (jumpBack === undefined || jumpBack.names.length === 0) return null;
  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span className="h-px flex-1 bg-border" />
        <span>or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <p className="text-text-muted text-xs">Jump back into an existing workspace:</p>
      <div className="flex flex-wrap justify-center gap-2">
        {jumpBack.names.map((name) => (
          <Button
            key={name}
            variant="outline"
            size="sm"
            disabled={jumpBack.switchingTo !== null}
            onClick={() => { jumpBack.onSwitch(name); }}
          >
            {jumpBack.switchingTo === name ? 'Switching…' : name}
          </Button>
        ))}
      </div>
      {jumpBack.error !== '' && <p className="text-xs text-negative">{jumpBack.error}</p>}
    </div>
  );
}

/** Step 1 (first run only): name the workspace before choosing a path. */
function WelcomeStep({ onNext, naming, jumpBack }: Readonly<{ onNext: () => void; naming: WelcomeNaming; jumpBack: JumpBackProps | undefined }>) {
  const nameInvalid = !isValidWorkspaceName(naming.value);
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="text-4xl font-bold text-accent tracking-wider">CostGoblin</span>
        <p className="text-text-secondary text-lg">Cloud cost visibility for your team</p>
      </div>
      <p className="text-text-muted text-sm max-w-md">
        Your costs live in a workspace — config, data, and preferences bundled together. Give this one a name to get going.
      </p>
      <div className="flex w-full max-w-xs flex-col gap-1 text-left">
        <label htmlFor="workspace-name" className="text-xs font-medium text-text-secondary">Workspace name</label>
        <input
          id="workspace-name"
          value={naming.value}
          onChange={(e) => { naming.onChange(e.target.value); }}
          spellCheck={false}
          className="rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {nameInvalid ? (
          <p className="text-xs text-negative">Use letters, digits, - or _, starting with a letter or digit (64 characters max).</p>
        ) : (
          <p className="text-xs text-text-muted">Keep &quot;default&quot;, or name it after a client or environment — more workspaces can be added later.</p>
        )}
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button
          onClick={onNext}
          disabled={nameInvalid}
          className="bg-accent hover:bg-accent-hover text-white"
        >
          Continue
        </Button>
      </div>
      <JumpBackList jumpBack={jumpBack} />
    </div>
  );
}

/** The vendors' own marks, taken from their published SVGs — AWS's is
 *  Apache-2.0 artwork, Google Cloud's and Azure's are PD-textlogo on Wikimedia
 *  Commons — and used unmodified. Nominative use: they identify whose billing
 *  data CostGoblin reads, not an endorsement.
 *
 *  Icon forms rather than the full wordmark lockups. Those run 1.67:1, 6.5:1
 *  and 1:1 respectively, which cannot be optically balanced in one row, and the
 *  tile already carries the provider's name in text beneath.
 *
 *  The previous marks were hand-drawn approximations. The AWS one in
 *  particular — a stroked arc beside a "W" that rendered as a bare V — read as
 *  two unrelated squiggles rather than a logo.
 */
function AwsMark(): React.JSX.Element {
  // The smile is a wide swoosh; a square box would shrink it to a hairline
  // beside the other two, so it is matched on width instead of height.
  return (
    <svg viewBox="0 116 304 66" className="h-6 w-11" aria-hidden="true">
      <path fill="#FF9900" d="M273.5,143.7c-32.9,24.3-80.7,37.2-121.8,37.2c-57.6,0-109.5-21.3-148.7-56.7c-3.1-2.8-0.3-6.6,3.4-4.4c42.4,24.6,94.7,39.5,148.8,39.5c36.5,0,76.6-7.6,113.5-23.2C274.2,133.6,278.9,139.7,273.5,143.7z" />
      <path fill="#FF9900" d="M287.2,128.1c-4.2-5.4-27.8-2.6-38.5-1.3c-3.2,0.4-3.7-2.4-0.8-4.5c18.8-13.2,49.7-9.4,53.3-5c3.6,4.5-1,35.4-18.6,50.2c-2.7,2.3-5.3,1.1-4.1-1.9C282.5,155.7,291.4,133.4,287.2,128.1z" />
    </svg>
  );
}

function GcpMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 34 30" className="h-8 w-8" aria-hidden="true">
      <path fill="#EA4335" d="M21.85,7.41l1,0,2.85-2.85.14-1.21A12.81,12.81,0,0,0,5,9.6a1.55,1.55,0,0,1,1-.06l5.7-.94s.29-.48.44-.45a7.11,7.11,0,0,1,9.73-.74Z" />
      <path fill="#4285F4" d="M29.76,9.6a12.84,12.84,0,0,0-3.87-6.24l-4,4A7.11,7.11,0,0,1,24.5,13v.71a3.56,3.56,0,1,1,0,7.12H17.38l-.71.72v4.27l.71.71H24.5A9.26,9.26,0,0,0,29.76,9.6Z" />
      <path fill="#34A853" d="M10.25,26.49h7.12v-5.7H10.25a3.54,3.54,0,0,1-1.47-.32l-1,.31L4.91,23.63l-.25,1A9.21,9.21,0,0,0,10.25,26.49Z" />
      <path fill="#FBBC05" d="M10.25,8A9.26,9.26,0,0,0,4.66,24.6l4.13-4.13a3.56,3.56,0,1,1,4.71-4.71l4.13-4.13A9.25,9.25,0,0,0,10.25,8Z" />
    </svg>
  );
}

function AzureMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 96 96" className="h-8 w-8" aria-hidden="true">
      <defs>
        {/* Ids are namespaced: this component can render beside other inlined
            SVGs, and a bare "a"/"b"/"c" would collide across documents. */}
        <linearGradient id="cg-azure-body" x1="-1032.172" x2="-1059.213" y1="145.312" y2="65.426" gradientTransform="matrix(1 0 0 -1 1075 158)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#114a8b" />
          <stop offset="1" stopColor="#0669bc" />
        </linearGradient>
        <linearGradient id="cg-azure-shade" x1="-1023.725" x2="-1029.98" y1="108.083" y2="105.968" gradientTransform="matrix(1 0 0 -1 1075 158)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopOpacity=".3" />
          <stop offset=".071" stopOpacity=".2" />
          <stop offset=".321" stopOpacity=".1" />
          <stop offset=".623" stopOpacity=".05" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cg-azure-fold" x1="-1027.165" x2="-997.482" y1="147.642" y2="68.561" gradientTransform="matrix(1 0 0 -1 1075 158)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3ccbf4" />
          <stop offset="1" stopColor="#2892df" />
        </linearGradient>
      </defs>
      <path fill="url(#cg-azure-body)" d="M33.338 6.544h26.038l-27.03 80.087a4.152 4.152 0 0 1-3.933 2.824H8.149a4.145 4.145 0 0 1-3.928-5.47L29.404 9.368a4.152 4.152 0 0 1 3.934-2.825z" />
      <path fill="#0078d4" d="M71.175 60.261h-41.29a1.911 1.911 0 0 0-1.305 3.309l26.532 24.764a4.171 4.171 0 0 0 2.846 1.121h23.38z" />
      <path fill="url(#cg-azure-shade)" d="M33.338 6.544a4.118 4.118 0 0 0-3.943 2.879L4.252 83.917a4.14 4.14 0 0 0 3.908 5.538h20.787a4.443 4.443 0 0 0 3.41-2.9l5.014-14.777 17.91 16.705a4.237 4.237 0 0 0 2.666.972H81.24L71.024 60.261l-29.781.007L59.47 6.544z" />
      <path fill="url(#cg-azure-fold)" d="M66.595 9.364a4.145 4.145 0 0 0-3.928-2.82H33.648a4.146 4.146 0 0 1 3.928 2.82l25.184 74.62a4.146 4.146 0 0 1-3.928 5.472h29.02a4.146 4.146 0 0 0 3.927-5.472z" />
    </svg>
  );
}

/** One cloud in the provider row. Disabled tiles stay visible on purpose —
 *  "Azure is coming" is information; a missing tile just looks like a product
 *  that never considered it. */
function ProviderTile({ label, note, mark, onClick, disabled }: Readonly<{
  label: string;
  note: string;
  mark: React.JSX.Element;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
}>) {
  const isDisabled = disabled === true;
  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      aria-label={`Set up from ${label}`}
      className={[
        'flex flex-1 flex-col items-center gap-2 rounded-lg border px-3 py-4 transition-colors',
        isDisabled
          ? 'cursor-not-allowed border-border/60 opacity-40'
          : 'border-border hover:border-accent hover:bg-bg-secondary cursor-pointer',
      ].join(' ')}
    >
      {mark}
      <span className="text-sm font-medium text-text-primary">{label}</span>
      <span className="text-[11px] leading-tight text-text-muted">{note}</span>
    </button>
  );
}

/** Step 2 — the get-started hub: pick a cloud, or import a teammate's bundle. */
function StartStep({ workspaceLabel, onSetup, onGcp, onImport, onBack, jumpBack }: Readonly<{
  workspaceLabel: string | undefined;
  onSetup: () => void;
  onGcp: () => void;
  onImport: () => void;
  onBack?: (() => void) | undefined;
  jumpBack: JumpBackProps | undefined;
}>) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="text-4xl font-bold text-accent tracking-wider">CostGoblin</span>
        {workspaceLabel !== undefined && (
          <p className="text-text-secondary text-sm">
            Workspace: <span className="font-medium text-text-primary">{workspaceLabel}</span>
          </p>
        )}
      </div>
      <p className="text-text-secondary text-lg">Which cloud are you billing on?</p>
      <div className="flex w-full max-w-md gap-3">
        <ProviderTile
          label="AWS"
          note="FOCUS 1.2 Data Export in S3"
          mark={<AwsMark />}
          onClick={onSetup}
        />
        <ProviderTile
          label="Google Cloud"
          note="FOCUS BigQuery export via GCS"
          mark={<GcpMark />}
          onClick={onGcp}
        />
        <ProviderTile
          label="Azure"
          note="Coming soon"
          mark={<AzureMark />}
          disabled
        />
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button variant="outline" onClick={onImport}>
          Import from a teammate
        </Button>
        <p className="text-text-muted text-xs">
          Pull config and data from a teammate — a bundle file, from S3, or straight over your network. No cloud access needed.
        </p>
      </div>
      <JumpBackList jumpBack={jumpBack} />
      <p className="text-text-muted text-xs">
        {"Don't have an export yet? Create a FOCUS 1.2 Data Export in "}
        <a
          href="https://us-east-1.console.aws.amazon.com/costmanagement/home#/bcm-data-exports"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          Billing and Cost Management &rarr; Data Exports
        </a>
      </p>
      {onBack !== undefined && (
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">
          ← Change workspace name
        </button>
      )}
    </div>
  );
}

const GCP_EXPORTER_DOCS = 'https://github.com/etiennechabert/cost-goblin/tree/main/scripts/gcp-focus-exporter';

/** The website's Google Cloud onboarding guide; the hash opens its modal. */
const GCP_SETUP_GUIDE = 'https://costgoblin.com/#get-started-gcp';

/** The reader field's help line for what was typed. */
function readerHelp(input: ReturnType<typeof resolveReaderInput>): string {
  switch (input.kind) {
    case 'invalid':
      return `Use an account name like ${DEFAULT_READER_ACCOUNT_ID}, or ${SERVICE_ACCOUNT_EMAIL_RULE}.`;
    case 'needs-project':
      return 'Completed with @<the project you pick>.iam.gserviceaccount.com — the account the setup guide creates. Your Google account needs the Service Account Token Creator role on it. Clear it to read as yourself.';
    case 'address':
    case 'none':
      return 'Your Google account needs the Service Account Token Creator role on it. Leave blank to read as yourself.';
  }
}

/** The collapsed reader line: who the browse and the sync will read as, for
 *  what is typed so far. Undefined for an invalid reader, whose field is open
 *  with its error instead. */
function readerSummary(input: ReturnType<typeof resolveReaderInput>): string | undefined {
  switch (input.kind) {
    case 'invalid':
      return undefined;
    case 'none':
      return 'your own Google account';
    case 'needs-project':
      return `${input.accountId} in the project you pick`;
    case 'address':
      return input.address;
  }
}

/**
 * Step 2b — GCP: which project holds the export, then into browse-and-pick.
 *
 * Project first, because everything after it is scoped to one: GCS has no
 * account-wide bucket list, and a bare reader name is completed with the
 * project (`<name>@<project>.iam.gserviceaccount.com`). Typing the ID is the
 * primary path — the documented least-privilege account can't list its own
 * project, and an organisation's thousands of projects make the list slow and
 * useless — with the `gcloud projects list` picker one click away for anyone
 * who would rather choose.
 *
 * The read-only service account almost always stays the default the setup
 * guide creates, so it is one line showing who CostGoblin will read as,
 * resolved live against the typed project, with the field behind "Change".
 * The field starts open when it holds anything but that default (a
 * reconfigured provider's own reader, a cleared one, or an invalid value), and
 * never closes on its own once open — collapsing would hide what is being
 * edited. Hand-editing survives as the escape hatch for setups the wizard
 * can't browse at all.
 */
function GcpIntroStep({ state, reader, onReaderChange, onBrowse, onProjectId, onScaffold, onDone, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp' }>;
  /** The read-only service account to browse and sync as: a full address,
   *  or a bare account name completed with the project; '' for none. */
  reader: string;
  onReaderChange: (reader: string) => void;
  /** Opens the `gcloud projects list` picker. */
  onBrowse: () => void;
  /** Continue with the typed project ID: checks the reader, then its buckets. */
  onProjectId: (projectId: string) => void;
  onScaffold: () => void;
  onDone: () => void;
  onBack: () => void;
}>) {
  const [projectId, setProjectId] = useState('');
  // The rule is shown after a submit attempt or on blur, not while a valid
  // ID is still being typed through invalid prefixes (see `ManualEntry`).
  const [attempted, setAttempted] = useState(false);
  const trimmedProject = projectId.trim();
  const projectValid = isValidGcpProjectId(trimmedProject);
  const projectInvalid = attempted && trimmedProject.length > 0 && !projectValid;

  // Resolved against the project as soon as one is valid, so the line shows
  // the exact address the browse will impersonate.
  const readerInput = resolveReaderInput(reader, projectValid ? trimmedProject : undefined);
  const readerInvalid = readerInput.kind === 'invalid';
  // The picker path resolves later, against the project picked there.
  const readerNameInvalid = resolveReaderInput(reader, undefined).kind === 'invalid';
  const checking = state.check?.status === 'checking';
  const canContinue = projectValid && !readerInvalid && !checking;
  const denial = readerDenialFor(state.check, readerInput, trimmedProject);

  // A latch, adjusted during render: opens for a non-default or invalid value
  // (including one prefilled after mount), and is never cleared here — typing
  // the default back must not collapse the field out from under the cursor.
  const needsReaderField = reader.trim() !== DEFAULT_READER_ACCOUNT_ID || readerInvalid;
  const [readerOpen, setReaderOpen] = useState(needsReaderField);
  if (needsReaderField && !readerOpen) setReaderOpen(true);
  // "Change" disappears once the field opens, so focus moves into the field
  // rather than falling back to the document.
  const [focusReader, setFocusReader] = useState(false);
  const readerFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusReader) return;
    readerFieldRef.current?.focus();
    setFocusReader(false);
  }, [focusReader]);

  const submit = (): void => {
    if (canContinue) onProjectId(trimmedProject);
    else setAttempted(true);
  };
  const summary = readerSummary(readerInput);

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span className="text-2xl font-bold text-accent tracking-wider">Set up from Google Cloud</span>
      {/* The prerequisites (exporter deploy, sign-in, what the credential can
          reach) live in the website guide, which approvers read anyway — the
          wizard stays a picker, short enough for its panels to fit. */}
      <p className="text-text-secondary text-sm max-w-md">
        CostGoblin reads the billing export your exporter writes to Cloud Storage. First time?
        Follow the{' '}
        <a
          href={GCP_SETUP_GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          Google Cloud setup guide
        </a>, then enter the project that holds your export.
      </p>
      <div className="flex w-full max-w-md flex-col gap-1.5 text-left">
        <label htmlFor="gcp-project-id" className="text-sm text-text-secondary">
          Google Cloud project
        </label>
        <input
          id="gcp-project-id"
          value={projectId}
          onChange={(e) => { setProjectId(e.target.value); }}
          onBlur={() => { setAttempted(true); }}
          // `isComposing`: the Enter that commits an IME composition is not a submit.
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }}
          placeholder="my-billing-project"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={projectInvalid}
          aria-describedby={projectInvalid ? 'gcp-project-id-error' : undefined}
          className="h-9 rounded-md border border-border bg-bg-primary px-3 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent aria-invalid:border-negative"
        />
        {projectInvalid && (
          <p id="gcp-project-id-error" className="text-xs text-negative">
            {`${GCP_PROJECT_ID_RULES} — the ID, not the project's display name.`}
          </p>
        )}
        <button
          type="button"
          onClick={onBrowse}
          disabled={readerNameInvalid}
          className="self-start text-xs text-accent underline underline-offset-2 hover:text-accent-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
        >
          Choose from my projects
        </button>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {summary !== undefined && (
            <p className="text-xs text-text-muted break-all">
              Reads as <span className="font-mono text-text-secondary">{summary}</span>
            </p>
          )}
          {!readerOpen && (
            <button
              type="button"
              aria-expanded={false}
              aria-controls="gcp-reader-field"
              onClick={() => { setReaderOpen(true); setFocusReader(true); }}
              className="text-xs text-accent underline underline-offset-2 hover:text-accent-hover"
            >
              Change
            </button>
          )}
        </div>
        {denial !== undefined && <GcpReaderDenied reader={denial.reader} project={denial.project} message={denial.message} />}
        <div id="gcp-reader-field" hidden={!readerOpen} className="flex flex-col gap-1.5">
          <label htmlFor="gcp-reader" className="text-xs text-text-muted">
            Read-only service account
          </label>
          <input
            id="gcp-reader"
            ref={readerFieldRef}
            type="text"
            value={reader}
            onChange={(e) => { onReaderChange(e.target.value); }}
            placeholder="costgoblin-reader or name@project.iam.gserviceaccount.com"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={readerInvalid}
            aria-describedby="gcp-reader-help"
            className="h-9 rounded-md border border-border bg-bg-primary px-3 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <p id="gcp-reader-help" className={readerInvalid ? 'text-xs text-negative' : 'text-xs text-text-muted'}>
            {readerHelp(readerInput)}
          </p>
        </div>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button onClick={submit} disabled={!canContinue} className="bg-accent hover:bg-accent-hover text-white">
          {checking ? 'Checking access…' : 'Continue'}
        </Button>
        <button
          type="button"
          onClick={onScaffold}
          className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          {state.scaffolded ? 'Open the config folder again' : 'Write the config by hand instead'}
        </button>
        {state.error !== '' && <p className="text-xs text-negative break-words">{state.error}</p>}
        {state.scaffolded && (
          <>
            <p className="text-text-muted text-xs">
              Edit <span className="text-text-primary">costgoblin.yaml</span> — set{' '}
              <span className="text-text-primary">sync.daily.bucket</span> to the folder your
              exporter writes to. The config is read at startup, so CostGoblin restarts when you
              continue.
            </p>
            <Button variant="outline" onClick={onDone}>
              I&apos;ve saved it — restart
            </Button>
          </>
        )}
      </div>
      <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">
        ← Back
      </button>
    </div>
  );
}

/** `name@project.iam.gserviceaccount.com` → `name`: the project is on screen
 *  beside it, and the full address wraps the one-line messages. */
function accountName(address: string): string {
  return address.split('@')[0] ?? address;
}

/** The intro's reader refusal, while the field and project still say what it
 *  was checked against — an edit to either makes it stale. */
function readerDenialFor(
  check: GcpReaderCheck | undefined,
  input: ReturnType<typeof resolveReaderInput>,
  project: string,
): Extract<GcpReaderCheck, { status: 'denied' }> | undefined {
  if (check?.status !== 'denied' || input.kind !== 'address') return undefined;
  return check.reader === input.address && check.project === project ? check : undefined;
}

/** The impersonation refusal in one line. IAM answers a missing account and a
 *  missing Token Creator grant identically, so the line names both; the
 *  rewritten message — the grant command and the raw denial — is one click
 *  away. */
function GcpReaderDenied({ reader, project, message }: Readonly<{ reader: string; project: string | undefined; message: string }>) {
  return (
    <div role="alert" className="text-left">
      <p className="text-xs text-negative">
        Can&apos;t read as <code>{accountName(reader)}</code> — it doesn&apos;t exist
        {project === undefined ? '' : <> in <code>{project}</code></>}, or your Google account lacks
        the Token Creator role on it.
      </p>
      <details className="mt-1">
        <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">Details</summary>
        <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{message}</p>
      </details>
    </div>
  );
}

/** Whether a sign-in would fix this error.
 *
 *  Delegates to core's `isGcpCredentialError` — the same predicate the sync
 *  uses — rather than keeping a second message list here. The local copy had
 *  already drifted, missing `invalid_rapt`, "Your credentials are invalid" and
 *  "does not have any valid credentials", so a Workspace user hitting reauth
 *  saw a raw OAuth string and no sign-in button on the one screen that exists
 *  to offer it.
 *
 *  `GCLOUD_CLI_NOT_FOUND` is excluded: the login button cannot run a CLI that
 *  is not installed. So is `GCLOUD_PROJECTS_TIMEOUT`: across thousands of
 *  projects the listing is simply slow, and a sign-in cannot make it faster. */
function isGcpAuthError(message: string): boolean {
  if (message.length === 0 || message.includes('GCLOUD_CLI_NOT_FOUND') || message.includes(GCLOUD_PROJECTS_TIMEOUT)) return false;
  return isGcpCredentialError(new Error(message))
    || message.includes('do not currently have an active account');
}

/** Sentinel the project-listing handler returns when `gcloud projects list`
 *  outlives its ceiling. Mirrors the desktop handler's literal. */
const GCLOUD_PROJECTS_TIMEOUT = 'GCLOUD_PROJECTS_TIMEOUT';

/** Error panel shared by the three GCP steps. `GCLOUD_CLI_NOT_FOUND` is a
 *  sentinel the handlers return rather than a message worth showing. */
function GcpError({ message, mode, onRetry }: Readonly<{
  message: string;
  mode: 'adc' | 'cli';
  /** Re-runs the step's own listing/browse call — each GCP step passes its
   *  loader, since a sign-in that succeeds in the browser leaves this panel
   *  showing a stale error the renderer never learns to drop. */
  onRetry: () => void;
}>) {
  if (message.length === 0) return null;
  const missingCli = message.includes('GCLOUD_CLI_NOT_FOUND');
  const timedOut = message.includes(GCLOUD_PROJECTS_TIMEOUT);
  const retryAction = isGcpAuthError(message) ? (
    <GcloudLoginButton mode={mode} onRetry={onRetry} />
  ) : (
    <div className="mt-2"><RetryButton onRetry={onRetry} /></div>
  );
  return (
    <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3" role="alert">
      {/* `break-words` is load-bearing: GCP appends an IAM Troubleshooter URL
          with no break opportunity in it, and `whitespace-pre-wrap` alone let
          that one token run straight out of the panel and across the window. */}
      <p className="text-sm text-negative whitespace-pre-wrap break-words">
        {missingCli && 'The Google Cloud CLI (gcloud) is not installed — CostGoblin needs it to list your projects and download the export.'}
        {timedOut && (
          <>
            Listing your projects timed out. In an organisation with many projects that is expected —
            enter the project ID instead. If gcloud is waiting to re-authenticate, run{' '}
            <code>gcloud auth login</code> in a terminal, then Retry.
          </>
        )}
        {!missingCli && !timedOut && message}
      </p>
      {/* Every branch gets a way to re-run the step. Gating the retry on the
          sign-in branch alone left the failures a sign-in CANNOT fix — a
          project-level IAM denial, a dropped connection — with no way forward
          but ← Back, which is the dead end this panel exists to remove. */}
      {missingCli ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <a
            href="https://cloud.google.com/sdk/docs/install"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            Install the gcloud CLI
          </a>
          <RetryButton onRetry={onRetry} />
        </div>
      ) : retryAction}
    </div>
  );
}

/** The `storage.buckets.list` denial, explained instead of dumped.
 *
 *  Usually this is the expected outcome of the exporter README's
 *  least-privilege recipe — `objectViewer` on the BUCKET, while enumerating a
 *  project's buckets is a project-level permission. GCP's raw sentence made
 *  that working setup look broken: 400 characters ending in an IAM
 *  Troubleshooter URL, above an empty list, with the remedy one field lower
 *  down, which is exactly where the eye does not go.
 *
 *  What this must NOT do is state that as a diagnosis. The same denial is
 *  returned when the principal has no access to the project at all — live here,
 *  because projects are listed with gcloud's active account and buckets with
 *  ADC, which are routinely different identities. So the copy stays
 *  conditional, and the raw message stays one click away: it names the denied
 *  principal, the only evidence of which identity actually ran.
 *
 *  Retry is kept for the reason `GcpError` states — a project-level IAM denial
 *  is precisely the failure a sign-in cannot fix, and the grant below is
 *  applied in a terminal, so the user needs a way to re-list without losing
 *  the wizard's place. `role="alert"` for the same reason it uses one: this
 *  panel is inserted already-populated, and a polite region added that way is
 *  inconsistently announced. */
function GcpBucketListDenied({ reader, project, message, detailsOpen, onToggleDetails, onRetry }: Readonly<{
  /** The service account that was refused; undefined for the user's own login. */
  reader: string | undefined;
  project: string;
  message: string;
  detailsOpen: boolean;
  onToggleDetails: (open: boolean) => void;
  onRetry: () => void;
}>) {
  return (
    // A status, not an alert: with the recommended read-only service account
    // this denial is the normal path, so it reads as one line pointing at the
    // field below. The raw denial — the only evidence of which principal was
    // refused, since GCP returns the same sentence for "no access at all" —
    // and the grant that fills the dropdown stay one click away.
    // `aria-atomic="false"` so opening Details announces only what it reveals.
    <div role="status" aria-atomic="false">
      <p className="text-xs text-text-secondary">
        {reader === undefined ? 'Your account' : <code className="text-text-secondary">{accountName(reader)}</code>}{' '}
        can&apos;t list the buckets in <code className="text-text-secondary">{project}</code> — enter the bucket name below.
      </p>
      <details
        className="mt-1"
        open={detailsOpen}
        onToggle={(e) => { onToggleDetails(e.currentTarget.open); }}
      >
        <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">Details</summary>
        <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{message}</p>
        <p className="text-xs text-text-muted mt-2">
          To pick from a list instead, grant <code className="text-text-secondary">roles/storage.bucketViewer</code>{' '}
          on <code className="text-text-secondary">{project}</code> to that principal (it then sees every bucket name in
          the project) —{' '}
          <a
            href={GCP_EXPORTER_DOCS}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            command in the exporter README
          </a>{' '}
          — then retry.
        </p>
        <div className="mt-2"><RetryButton onRetry={onRetry} /></div>
      </details>
    </div>
  );
}

/** A typed value with an action button — the bucket steps' "enter it
 *  directly" escape hatch and the GCP project-ID entry.
 *
 *  The value is trimmed when validated and submitted, never as it is typed: a
 *  per-keystroke trim deletes each space while it is still trailing, so a
 *  display name typed as `billing export` silently became the valid-looking
 *  `billingexport`. The rule is shown after a submit attempt or on blur, not
 *  while a valid value is still being typed through invalid prefixes.
 *
 *  `prominent` when it is the way forward (nothing listed yet): then it gets
 *  the primary button and no divider. */
function ManualEntry({ id, label, placeholder, actionLabel, isValid, rules, prominent = false, onSubmit }: Readonly<{
  id: string;
  label: string;
  placeholder: string;
  actionLabel: string;
  isValid: (value: string) => boolean;
  /** Shown, once the user has tried, when `isValid` refuses a non-empty value. */
  rules?: string | undefined;
  prominent?: boolean | undefined;
  onSubmit: (value: string) => void;
}>) {
  const [value, setValue] = useState('');
  const [attempted, setAttempted] = useState(false);
  const trimmed = value.trim();
  const valid = isValid(trimmed);
  const invalid = attempted && trimmed.length > 0 && !valid;
  const submit = (): void => {
    if (valid) onSubmit(trimmed);
    else setAttempted(true);
  };

  return (
    <div className={`flex flex-col gap-1.5${prominent ? '' : ' border-t border-border pt-4'}`}>
      <label htmlFor={id} className={prominent ? 'text-sm text-text-secondary' : 'text-xs text-text-muted'}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          onChange={(e) => { setValue(e.target.value); }}
          onBlur={() => { setAttempted(true); }}
          // `isComposing`: the Enter that commits an IME composition is not a submit.
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          className="h-9 flex-1 rounded-md border border-border bg-bg-primary px-3 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent aria-invalid:border-negative"
        />
        <Button variant={prominent ? 'default' : 'outline'} disabled={!valid} onClick={submit}>
          {actionLabel}
        </Button>
      </div>
      {invalid && rules !== undefined && (
        <p id={`${id}-error`} className="text-xs text-negative">{rules}</p>
      )}
    </div>
  );
}

/** Typed project ID. Two accounts need it: the documented least-privilege
 *  one, which holds only Token Creator on the read-only reader and so is never
 *  shown its project by `gcloud projects list`; and one in an organisation
 *  with thousands of projects, where that listing is slow or times out. */
function GcpProjectIdEntry({ id, label, prominent, onSubmit }: Readonly<{
  id: string;
  label: string;
  prominent?: boolean | undefined;
  onSubmit: (projectId: string) => void;
}>) {
  return (
    <ManualEntry
      id={id}
      label={label}
      placeholder="my-billing-project"
      actionLabel="Continue"
      isValid={isValidGcpProjectId}
      rules={`${GCP_PROJECT_ID_RULES} — the ID, not the project's display name.`}
      prominent={prominent}
      onSubmit={onSubmit}
    />
  );
}

/** Step 2b-i — which project's buckets to list.
 *
 *  Has no AWS counterpart: S3's ListBuckets is account-wide and takes no
 *  arguments, while `storage.getBuckets()` is project-scoped. */
function GcpProjectStep({ state, onSelect, onTyped, onManual, onBack, onRetry }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-project' }>;
  /** A project picked from the listing. */
  onSelect: (projectId: string) => void;
  /** A project ID typed into the entry. */
  onTyped: (projectId: string) => void;
  onManual: () => void;
  onBack: () => void;
  onRetry: () => void;
}>) {
  const [filter, setFilter] = useState('');
  const filtered = state.projects.filter(
    p => filter.length === 0
      || p.name.toLowerCase().includes(filter.toLowerCase())
      || p.projectId.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Google Cloud project</h2>
        <p className="text-sm text-text-secondary mt-1">Which project holds the bucket your exporter writes to?</p>
        <p className="text-xs text-text-muted mt-1">
          Read from <code className="text-text-secondary">gcloud projects list</code>
        </p>
      </div>

      <GcpError message={state.error} mode="cli" onRetry={onRetry} />

      {/* Above the list, and rendered WHILE the listing runs: across thousands
          of projects it is slow, typing the ID abandons it (the step token
          drops its late result), and a list landing above the field would
          shift Continue out from under a pending click. Not prominent after a
          failed listing — the sync downloads with that same gcloud CLI, so the
          panel's own fix stays the primary action. */}
      <GcpProjectIdEntry
        id="gcp-project-manual"
        label="Project not listed? Enter its ID"
        prominent={state.projects.length === 0 && state.error === ''}
        onSubmit={onTyped}
      />

      {state.loading && (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading projects...</span>
        </div>
      )}
      {!state.loading && state.projects.length === 0 && state.error === '' && (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-4 py-4">
          <p className="text-sm text-text-secondary">No Google Cloud projects found</p>
          <p className="text-xs text-text-muted mt-1">
            Expected for a least-privilege account — one whose only grant is Token Creator on the
            read-only reader can&apos;t list the project — so type the project ID above. Otherwise,
            check which account gcloud has active (<code className="text-text-secondary">gcloud auth list</code>).
            Granting your account <code className="text-text-secondary">roles/browser</code> on the
            project would list it here instead.
          </p>
        </div>
      )}
      {!state.loading && state.projects.length > 0 && (
        <>
          {state.projects.length > 5 && (
            <input
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); }}
              placeholder="Filter projects..."
              className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          )}
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {filtered.map(project => (
              <button
                key={project.projectId}
                type="button"
                onClick={() => { onSelect(project.projectId); }}
                className={[
                  'flex flex-col rounded-lg border px-4 py-2.5 text-left transition-colors',
                  state.selected === project.projectId
                    ? 'border-accent bg-accent-muted text-accent'
                    : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
                ].join(' ')}
              >
                <span className="text-sm">{project.name}</span>
                <span className="font-mono text-xs text-text-muted">{project.projectId}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-text-muted text-center py-4">No projects match that filter</p>
            )}
          </div>
        </>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <button
          type="button"
          onClick={onManual}
          className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Write the config by hand instead
        </button>
      </div>
    </div>
  );
}

/** Step 2b-ii — pick the bucket. Sister of `BucketStep`, against GCS. */
function GcpBucketStep({ state, reader, onSelect, onSkip, onBack, onRetry }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-bucket' }>;
  /** Who the listing ran as — the full address, or undefined for the ADC login. */
  reader: string | undefined;
  onSelect: (bucket: string) => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
  onRetry: () => void;
}>) {
  const [filter, setFilter] = useState('');
  // Survives a re-list along with the rest of this component's state: Retry and
  // the hourly→daily Back both keep `step` at 'gcp-bucket', so React reuses the
  // element. Lifted out of the panel for exactly that reason — the panel itself
  // unmounts whenever `error` clears mid-request, which collapsed the
  // disclosure on every attempt of the retry loop it tells the user to run.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Applied only while its input is on screen. `filter` outlives the input,
  // which renders above 5 buckets — so a filter typed against a long list kept
  // hiding a short one after a re-list, with no box left to clear it.
  const filterVisible = state.buckets.length > 5;
  const filtering = filterVisible && filter.length > 0;
  const filtered = filtering
    ? state.buckets.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
    : state.buckets;
  const sourceLabel = SOURCE_LABELS[state.source];
  // Only a listing can be denied, and only a project can be listed.
  const deniedProject = state.project !== null && isGcpBucketListDeniedMessage(state.error) ? state.project.id : null;
  // The project picker reaches here without the intro's reader check.
  const readerRefused = reader !== undefined && isGcpImpersonationError(new Error(state.error));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">{sourceLabel.description}</p>
        <p className="text-xs text-text-muted mt-0.5">
          {state.project === null
            ? 'Enter the Cloud Storage bucket name'
            : <>Select the Cloud Storage bucket in <code className="text-text-secondary">{state.project.id}</code></>}
        </p>
      </div>

      {deniedProject !== null
        ? (
          <GcpBucketListDenied
            reader={reader}
            project={deniedProject}
            message={state.error}
            detailsOpen={detailsOpen}
            onToggleDetails={setDetailsOpen}
            onRetry={onRetry}
          />
        )
        : readerRefused
          ? <GcpReaderDenied reader={reader} project={state.project?.id} message={state.error} />
          : <GcpError message={state.error} mode="adc" onRetry={onRetry} />}

      {state.loading ? (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading buckets...</span>
        </div>
      ) : (
        <>
          {filterVisible && (
            <input
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); }}
              placeholder="Filter buckets..."
              className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          )}
          {/* Hidden wholesale when the listing was forbidden. "No buckets
              found" reads as "your export is missing" when the listing was
              merely refused, and guarding only that line left this container
              rendered with no children — still a flex item, so it doubled the
              gap between the panel above and the manual-entry field below. */}
          {deniedProject === null && (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {filtered.map(bucket => (
                <button
                  key={bucket.name}
                  type="button"
                  onClick={() => { onSelect(bucket.name); }}
                  className={[
                    'flex items-center rounded-lg border px-4 py-2.5 text-left text-sm transition-colors',
                    state.selected === bucket.name
                      ? 'border-accent bg-accent-muted text-accent'
                      : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
                  ].join(' ')}
                >
                  <span className="font-mono text-xs">{bucket.name}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-sm text-text-muted text-center py-4">
                  {filtering ? 'No buckets match that filter' : 'No buckets found'}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Typing the name skips the enumeration entirely — the escape hatch for
          a reader that can browse objects but not enumerate buckets.
          `GcpBucketListDenied` explains that above whenever it applies, so this
          label stays neutral: the alternative wording diagnosed a permissions
          problem, and it rendered for a dropped connection and for a project
          that genuinely has no buckets just as readily as for a real denial. */}
      <ManualEntry
        id="gcs-bucket-manual"
        label="Or enter a bucket name directly"
        placeholder="my-focus-export"
        actionLabel="Browse"
        isValid={(name) => name.length > 0}
        onSubmit={onSelect}
      />

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        {onSkip !== undefined && (
          <button type="button" onClick={onSkip} className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">Skip</button>
        )}
      </div>
    </div>
  );
}

/** Step 2b-iii — walk the bucket to the tier folder.
 *
 *  The `tier-parent` verdict is the point of this screen. Pointing a provider
 *  at the exporter's PREFIX rather than a tier folder under it makes the daily
 *  tier list the hourly shards too — the sync has a bespoke error for it, and
 *  this refuses the selection before the user can make it. */
function GcpBrowseStep({ state, conflictsWith, onNavigate, onRetry, onConfirm, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-browse' }>;
  /** A tier location already collected in this run that this one must not
   *  overlap — the daily path, while browsing for hourly. */
  conflictsWith?: string | undefined;
  onNavigate: (prefix: string) => void;
  /** Re-browse the current folder after a failure. Separate from
   *  `onNavigate` because a retry — usually right after a sign-in — must
   *  also re-read the "Signed in as" panel, and plain navigation must not. */
  onRetry: () => void;
  onConfirm: () => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}>) {
  const sourceLabel = SOURCE_LABELS[state.source];
  const isExport = state.folder.kind === 'export';
  // `validateGcpSync` rejects overlapping tiers at load time, so allowing the
  // selection here would write a config the app then refuses to start on.
  // Gated on `isExport`, because `gcsTiersOverlap` is symmetric containment:
  // every ANCESTOR of the other tier's path matches it too. Ungated, the
  // browse opened on a red "already used" banner at the bucket root and kept
  // it up — beside the contradictory "go one level deeper" banner — all the
  // way down to the folder the user was being sent to.
  const overlaps = isExport
    && conflictsWith !== undefined
    && conflictsWith.length > 0
    && gcsTiersOverlap(`gs://${state.bucket}/${state.prefix}`, conflictsWith);
  const selectable = isExport && state.hasParquet && !overlaps;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">
          Navigate to the <code className="text-text-primary">{state.source}</code> folder your exporter writes to
        </p>
        <p className="text-xs text-text-muted mt-0.5">{sourceLabel.description}</p>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs font-mono text-text-muted flex-wrap">
        <button type="button" onClick={() => { onNavigate(''); }} className="hover:text-accent transition-colors">
          {state.bucket}
        </button>
        {state.path.map((seg, i) => (
          // Keyed by the full path, not the segment: folder names repeat
          // (focus/focus/daily), and duplicate keys let React swap the two
          // crumbs' click handlers on re-render.
          <span key={state.path.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <span>/</span>
            <button
              type="button"
              onClick={() => { onNavigate(state.path.slice(0, i + 1).join('/') + '/'); }}
              className="hover:text-accent transition-colors"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <GcpError message={state.error} mode="adc" onRetry={onRetry} />

      {state.folder.kind === 'tier-parent' && (
        <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
          <p className="text-sm font-medium text-warning">This is the parent folder — go one level deeper</p>
          <p className="text-xs text-warning mt-0.5">
            It holds {state.folder.tiers.map(t => `${t}/`).join(' and ')}. Pointing a provider here would make
            the {state.source} tier read every tier&apos;s files.{' '}
            {state.folder.tiers.includes(state.source)
              ? <>Open <code className="text-text-primary">{state.source}/</code> to select it.</>
              : <>This exporter publishes no {state.source} tier — deploy it with{' '}
                <code className="text-text-primary">TIERS=daily,hourly</code> if you want one, or skip this tier.</>}
          </p>
        </div>
      )}

      {state.truncated && (
        <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
          <p className="text-sm font-medium text-warning">Showing the first folders only</p>
          <p className="text-xs text-warning mt-0.5">
            This location has more subfolders than CostGoblin lists at once. If the export folder
            isn&apos;t here, write the config by hand instead.
          </p>
        </div>
      )}

      {overlaps && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">Already used by the daily tier</p>
          <p className="text-xs text-text-secondary mt-0.5">
            Each tier needs its own folder — reading one folder as both would sync the same rows
            twice and make the intraday views show daily grain. Pick the exporter&apos;s{' '}
            <code className="text-text-primary">hourly/</code> folder, or skip this tier.
          </p>
        </div>
      )}

      {isExport && !overlaps && !state.hasParquet && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">No Parquet files in this export yet</p>
          <p className="text-xs text-text-secondary mt-0.5">
            The period folders exist but hold no shards — the exporter has been deployed but hasn&apos;t
            finished a run. Wait for it to complete, then come back.
          </p>
        </div>
      )}

      {selectable && state.folder.kind === 'export' && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
          <p className="text-sm font-medium text-accent">FOCUS export detected</p>
          <p className="text-xs text-text-secondary mt-0.5">
            Found {state.folder.periods.length} billing{' '}
            {state.folder.periods.length === 1 ? 'period' : 'periods'} ({state.folder.periods[0]}
            {state.folder.periods.length > 1 ? ` – ${String(state.folder.periods[state.folder.periods.length - 1])}` : ''})
          </p>
        </div>
      )}

      {state.loading ? (
        <div className="flex items-center justify-center py-6">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading...</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {state.prefixes.map(prefix => {
            const isTier = prefix === 'daily' || prefix === 'hourly';
            return (
              <button
                key={prefix}
                type="button"
                onClick={() => { onNavigate(state.prefix + prefix + '/'); }}
                // Explicit name: the folder emoji would otherwise land in the
                // accessible name, and the tier hint above renders the same
                // `daily/` string, so a name of its own is what makes this
                // button unambiguous to a screen reader.
                aria-label={`Open folder ${prefix}`}
                className={[
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-left text-sm transition-colors',
                  isTier
                    ? 'border-accent/30 bg-accent/5 text-accent'
                    : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
                ].join(' ')}
              >
                <span className="text-text-muted" aria-hidden="true">📁</span>
                <span className="font-mono text-xs">{prefix}/</span>
              </button>
            );
          })}
          {state.prefixes.length === 0 && state.error.length === 0 && (
            <p className="text-sm text-text-muted text-center py-4">No subfolders found</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        {/* Shown only once a folder is an export: a disabled placeholder read
            as a step the user was missing, while the fix is to navigate. */}
        <div className="flex items-center gap-3">
          {onSkip !== undefined && (
            <button type="button" onClick={onSkip} className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">Skip</button>
          )}
          {selectable && (
            <Button onClick={onConfirm} className="bg-accent hover:bg-accent-hover text-white px-8">
              Use this location
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function BeaconStep({ state, onApply, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'beacon' }>;
  onApply: () => void;
  onSkip: () => void;
  onBack: () => void;
}>) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Team configuration found</h2>
        <p className="text-sm text-text-secondary mt-1">
          <code className="text-text-primary">{state.bucket}</code> contains a configuration published by your team — dimensions, dashboards and data locations are already set up.
        </p>
      </div>

      <BundleSummaryCard summary={state.summary} />

      {state.error.length > 0 && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm text-negative break-words">{state.error}</p>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onSkip} className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">
            Set up manually instead
          </button>
          <Button
            onClick={onApply}
            disabled={state.applying}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            {state.applying ? 'Applying…' : 'Use this configuration'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProfileStep({ state, onSelect, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'profile' }>;
  onSelect: (profile: string) => void;
  onSkip: () => void;
  onBack: () => void;
}>) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">AWS Profile</h2>
        <p className="text-sm text-text-secondary mt-1">Select the AWS profile to use for accessing your billing data</p>
        <p className="text-xs text-text-muted mt-1">
          Profiles are read from <code className="text-text-secondary">~/.aws/credentials</code> and <code className="text-text-secondary">~/.aws/config</code>
        </p>
      </div>

      {state.loading && (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading profiles...</span>
        </div>
      )}
      {!state.loading && state.profiles.length === 0 && (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-4 py-6 text-center">
          <p className="text-sm text-text-secondary">No AWS profiles found</p>
          <p className="text-xs text-text-muted mt-1">
            Configure credentials in <code className="text-text-secondary">~/.aws/config</code> or <code className="text-text-secondary">~/.aws/credentials</code>
          </p>
        </div>
      )}
      {!state.loading && state.profiles.length > 0 && (
        <ProfilePicker
          profiles={state.profiles}
          selected={state.selected}
          onSelect={onSelect}
          listClassName="max-h-64"
          autoFocus
        />
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <Button
          onClick={() => { onSelect(state.selected); }}
          disabled={state.selected.length === 0}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          Next
        </Button>
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="text-xs text-text-muted hover:text-text-secondary text-center underline underline-offset-2"
      >
        Skip — I'll configure this manually
      </button>
    </div>
  );
}

/** Error panel shared by the AWS bucket and browse steps: an expired SSO token
 *  gets one-click re-auth, every other failure a plain Retry — so a credential
 *  failure is never rendered as a silent empty list. `setup:list-buckets` /
 *  `setup:browse-s3` funnel EVERY failure into `error`, hence the sniff rather
 *  than an exhaustive match. */
function AwsCredentialErrorPanel({ error, profile, onRetry }: Readonly<{
  error: string;
  profile: string;
  onRetry: () => void;
}>) {
  if (error.length === 0) return null;
  return (
    <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3" role="alert">
      <p className="text-sm text-negative break-words">{error}</p>
      {error.includes('aws sso login') ? (
        <SsoLoginButton profile={profile} onRetry={onRetry} />
      ) : (
        <div className="mt-2"><RetryButton onRetry={onRetry} /></div>
      )}
    </div>
  );
}

function BucketStep({ state, onSelect, onSkip, onBack, onRetry }: Readonly<{
  state: Extract<WizardStep, { step: 'bucket' }>;
  onSelect: (bucket: string) => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
  /** Re-lists the buckets. The wizard has no other way back out of an expired-
   *  token error: ← Back returns to the profile picker, and re-picking the same
   *  profile was the only route to a second attempt. */
  onRetry: () => void;
}>) {
  const [filter, setFilter] = useState('');
  const filtered = state.buckets.filter(b => filter.length === 0 || b.name.toLowerCase().includes(filter.toLowerCase()));
  const sourceLabel = SOURCE_LABELS[state.source];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">{sourceLabel.description}</p>
        <p className="text-xs text-text-muted mt-0.5">Select the S3 bucket</p>
      </div>

      <AwsCredentialErrorPanel error={state.error} profile={state.profile} onRetry={onRetry} />

      {state.loading ? (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading buckets...</span>
        </div>
      ) : (
        <>
          {state.buckets.length > 5 && (
            <input
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); }}
              placeholder="Filter buckets..."
              className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          )}
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {filtered.map(bucket => (
              <button
                key={bucket.name}
                type="button"
                onClick={() => { onSelect(bucket.name); }}
                className={[
                  'flex items-center rounded-lg border px-4 py-2.5 text-left text-sm transition-colors',
                  state.selected === bucket.name
                    ? 'border-accent bg-accent-muted text-accent'
                    : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
                ].join(' ')}
              >
                <span className="font-mono text-xs">{bucket.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <div className="flex items-center gap-3">
          {onSkip !== undefined && (
            <button type="button" onClick={onSkip} className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">Skip</button>
          )}
          <Button
            onClick={() => { onSelect(state.selected); }}
            disabled={state.selected.length === 0}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function BrowseStep({ state, onNavigate, onConfirm, onSkip, onBack, onRetry }: Readonly<{
  state: Extract<WizardStep, { step: 'browse' }>;
  onNavigate: (prefix: string) => void;
  onConfirm: () => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
  /** Re-lists the current folder. The browse step can fail on an expired token
   *  or an s3:ListBucket denial that struck between the bucket step and here;
   *  without this the only way on was ← Back. */
  onRetry: () => void;
}>) {
  const sourceLabel = SOURCE_LABELS[state.source];
  const selectableLabel = state.isBillingExport ? 'Use this location' : 'Select an export folder';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">Navigate to the folder containing <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code></p>
        <p className="text-xs text-text-muted mt-0.5">{sourceLabel.description}</p>
      </div>

      <AwsCredentialErrorPanel error={state.error} profile={state.profile} onRetry={onRetry} />

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs font-mono text-text-muted flex-wrap">
        <button
          type="button"
          onClick={() => { onNavigate(''); }}
          className="hover:text-accent transition-colors"
        >
          {state.bucket}
        </button>
        {state.path.map((seg, i) => (
          // Keyed by the full path, not the segment: folder names repeat
          // (focus/focus/daily), and duplicate keys let React swap the two
          // crumbs' click handlers on re-render.
          <span key={state.path.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <span>/</span>
            <button
              type="button"
              onClick={() => { onNavigate(state.path.slice(0, i + 1).join('/') + '/'); }}
              className="hover:text-accent transition-colors"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {state.isBillingExport && state.detectedType === 'cost-optimization' && state.source !== 'costOptimization' && (
        <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
          <p className="text-sm font-medium text-warning">Data type mismatch</p>
          <p className="text-xs text-warning mt-0.5">
            This looks like a Cost Optimization report, not a billing export. Continue anyway?
          </p>
        </div>
      )}
      {state.isBillingExport && state.detectedType !== 'cost-optimization' && state.detectedType !== 'unknown' && state.detectedType !== 'cur-legacy' && state.source === 'costOptimization' && (
        <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
          <p className="text-sm font-medium text-warning">Data type mismatch</p>
          <p className="text-xs text-warning mt-0.5">
            This looks like a billing export, not a Cost Optimization export. Continue anyway?
          </p>
        </div>
      )}
      {state.detectedType === 'cur-legacy' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">This is a CUR 2.0 export — CostGoblin reads FOCUS 1.2</p>
          <p className="text-xs text-text-secondary mt-0.5">
            The manifest here lists CUR 2.0 columns (<code className="text-text-primary">line_item_*</code>).
            CostGoblin&apos;s data schema is FOCUS 1.2, so this export can&apos;t be ingested.
          </p>
          <p className="text-xs text-text-muted mt-1">
            In the AWS console, open <span className="text-text-secondary">Billing and Cost Management → Data Exports → Create export</span>,
            pick the <span className="text-text-secondary">FOCUS 1.2</span> table (not CUR 2.0), export as Parquet to a fresh prefix,
            and point CostGoblin at that prefix instead.
          </p>
        </div>
      )}
      {state.isBillingExport && state.detectedType !== 'cur-legacy' && !(state.detectedType === 'cost-optimization' && state.source !== 'costOptimization') && !(state.detectedType !== 'cost-optimization' && state.detectedType !== 'unknown' && state.source === 'costOptimization') && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
          <p className="text-sm font-medium text-accent">
            {state.detectedType === 'cost-optimization' ? 'Cost Optimization report detected' : 'FOCUS billing export detected'}
          </p>
          <p className="text-xs text-text-secondary mt-0.5">
            Found <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code> folders
          </p>
        </div>
      )}

      {state.isBillingExport && state.missingColumns.length > 0 && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">Missing required columns</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {state.missingColumns.join(', ')}
          </p>
          <p className="text-xs text-text-muted mt-1">
            CostGoblin needs these columns. Check your FOCUS 1.2 Data Export configuration in the AWS Console.
          </p>
        </div>
      )}

      {state.loading ? (
        <div className="flex items-center justify-center py-6">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading...</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {state.prefixes.map(prefix => {
            const isSpecial = prefix === 'data' || prefix === 'metadata';
            return (
              <button
                key={prefix}
                type="button"
                onClick={() => { onNavigate(state.prefix + prefix + '/'); }}
                className={[
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-left text-sm transition-colors',
                  isSpecial
                    ? 'border-accent/30 bg-accent/5 text-accent'
                    : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
                ].join(' ')}
              >
                <span className="text-text-muted">📁</span>
                <span className="font-mono text-xs">{prefix}/</span>
              </button>
            );
          })}
          {state.prefixes.length === 0 && state.error.length === 0 && (
            <p className="text-sm text-text-muted text-center py-4">No subfolders found</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <div className="flex items-center gap-3">
          {onSkip !== undefined && (
            <button type="button" onClick={onSkip} className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2">Skip</button>
          )}
          <Button
            onClick={onConfirm}
            disabled={!state.isBillingExport || state.detectedType === 'cur-legacy'}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            {state.detectedType === 'cur-legacy' ? 'CUR 2.0 not supported' : selectableLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function defaultProviderName(cloud: 'aws' | 'gcp'): string {
  return cloud === 'gcp' ? 'gcp-main' : 'aws-main';
}

/** The cloud's default name, numbered past any provider that already has it
 *  (`gcp-main`, `gcp-main-2`, …). Compared case-insensitively, as the
 *  name check and the loader do. Add mode proposes it instead of an empty
 *  field — and never an `aws-` name for a GCP provider. */
function freeProviderName(cloud: 'aws' | 'gcp', taken: readonly string[]): string {
  const used = new Set(taken.map(n => n.toLowerCase()));
  const base = defaultProviderName(cloud);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${String(n)}`)) n += 1;
  return `${base}-${String(n)}`;
}

/** Validation error for the provider-name field, or null when the name is
 *  usable. `takenNames` is checked case-insensitively only when adding —
 *  reconfiguring an existing provider legitimately reuses its name. */
function providerNameError(name: string, checkTaken: boolean, takenNames: readonly string[]): string | null {
  try {
    parseProviderName(name);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  if (checkTaken && takenNames.some(n => n.toLowerCase() === name.toLowerCase())) {
    return `A provider named "${name}" already exists — pick a different name.`;
  }
  return null;
}

interface ProviderNaming {
  readonly value: string;
  readonly fixed: boolean;
  readonly checkTaken: boolean;
  readonly takenNames: readonly string[];
  readonly onChange: (value: string) => void;
}

/** The Confirm step's retention picks. Held by the wizard, not the step, so
 *  ← Back (to add an optional tier) and forward again keeps them. Only tiers
 *  the user clicked are present: an untouched tier shows, and writes, the
 *  provider's current window. */
interface RetentionChoices {
  readonly picks: Readonly<Partial<Record<DataSource, number>>>;
  readonly onPick: (tier: DataSource, days: number) => void;
}

const OPTIONAL_TIER_ADD_LABEL: Readonly<Record<DataSource, string>> = {
  daily: 'Add daily export',
  hourly: 'Add hourly export',
  costOptimization: 'Add Cost Optimization data',
};

/** A tier this run has not collected, offered on Confirm as an optional add. */
interface OptionalTier {
  readonly tier: DataSource;
  readonly onAdd: () => void;
}

/** The identity the saved GCP provider's DOWNLOADS will run as, mirroring the
 *  config upsert: the reader this run sends; else — unless the user cleared
 *  it — the reader the replaced entry already has; and that entry's key file
 *  only when no reader is left (the validator refuses both at once). */
function gcpDownloadIdentity(
  state: Extract<WizardStep, { step: 'confirm'; cloud: 'gcp' }>,
  existing: ProviderConfig | undefined,
): { readonly reader: string | undefined; readonly keyFileProvider: string | undefined } {
  if (state.reader !== '') return { reader: state.reader, keyFileProvider: undefined };
  const replaced = existing?.type === 'gcp' ? existing : undefined;
  const carried = state.clearsReader ? undefined : replaced?.impersonateServiceAccount;
  if (carried !== undefined) return { reader: carried, keyFileProvider: undefined };
  return { reader: undefined, keyFileProvider: replaced?.keyFile === undefined ? undefined : String(replaced.name) };
}

/** Whether the collected GCP folders can be DOWNLOADED, not just browsed:
 *  browsing runs through the Cloud Storage SDK, downloading through `gcloud
 *  storage rsync` as gcloud's own active account — two identities that
 *  routinely differ, so a folder the wizard listed can still 403 on
 *  `storage.objects.get` once the sync runs. Not run for AWS. */
type DownloadCheck =
  | { readonly status: 'not-needed' }
  | { readonly status: 'checking' }
  | { readonly status: 'ok' }
  | { readonly status: 'failed'; readonly tier: DataSource; readonly error: string };

const CHECKED_TIER_LABELS: Readonly<Record<DataSource, string>> = {
  daily: 'daily export',
  hourly: 'hourly export',
  costOptimization: 'Cost Optimization data',
};

/** The Confirm step's Google Cloud card: the project, the reader and the
 *  download check as rows of one card, so the three facts about one identity
 *  read together. The check's failure renders through `GcpError` in gcloud-CLI
 *  mode — the download's own credential — so a signed-out gcloud gets its
 *  sign-in button and anything else a Retry. */
function GcpAccessCard({ project, reader, check, readsAs, onRecheck }: Readonly<{
  project: string | undefined;
  /** '' when the download runs as the gcloud account or a key file. */
  reader: string;
  check: DownloadCheck;
  /** Who the check ran as; named in its row only when no Reads as row does. */
  readsAs: string;
  onRecheck: () => void;
}>) {
  const as = reader === '' ? ` as ${readsAs}` : '';
  const label = 'text-xs text-text-muted uppercase tracking-wider whitespace-nowrap';
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
        {project !== undefined && (
          <>
            <dt className={label}>Google Cloud project</dt>
            <dd className="m-0 text-sm font-mono text-text-primary break-all">{project}</dd>
          </>
        )}
        {reader !== '' && (
          <>
            <dt className={label}>Reads as</dt>
            <dd className="m-0 text-sm font-mono text-text-primary break-all">{reader}</dd>
          </>
        )}
        {check.status !== 'not-needed' && (
          <>
            <dt className={label}>Download check</dt>
            <dd className="m-0 flex items-center gap-1.5 text-sm" aria-live="polite">
              {check.status === 'checking' && (
                <>
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-text-muted" />
                  <span className="text-text-secondary break-words">Checking that gcloud can download the export{as}…</span>
                </>
              )}
              {check.status === 'ok' && (
                <>
                  <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="text-text-primary break-words">gcloud can download the export{as}</span>
                  <button
                    type="button"
                    onClick={onRecheck}
                    className="ml-auto shrink-0 text-xs text-text-muted underline underline-offset-2 hover:text-text-secondary"
                  >
                    Check again
                  </button>
                </>
              )}
              {check.status === 'failed' && (
                <>
                  <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-negative" />
                  <span className="text-text-secondary break-words">
                    gcloud can&apos;t download the {CHECKED_TIER_LABELS[check.tier]}{as}, so syncing it would fail
                  </span>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {check.status === 'failed' && (
        <div className="mt-2"><GcpError message={check.error} mode="cli" onRetry={onRecheck} /></div>
      )}
    </div>
  );
}

function ConfirmStep({ state, providerNaming, existing, retention, optionalTiers, onComplete, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'confirm' }>;
  providerNaming: ProviderNaming;
  /** The configured provider this run will replace (same name and cloud),
   *  whose retention windows seed the pickers. */
  existing: ProviderConfig | undefined;
  retention: RetentionChoices;
  /** Empty in per-tier Configure, which came for one tier. */
  optionalTiers: readonly OptionalTier[];
  onComplete: () => void;
  onBack: () => void;
}>) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const api = useCostApi();

  const nameError = providerNaming.fixed
    ? null
    : providerNameError(providerNaming.value, providerNaming.checkTaken, providerNaming.takenNames);

  // What each tier will keep: the user's pick, else what the provider being
  // replaced already has (a re-run must not quietly reset a tuned window),
  // else the shared default the prune paths also use.
  function tierRetention(tier: DataSource): number {
    return retention.picks[tier] ?? existing?.sync[tier]?.retentionDays ?? DEFAULT_RETENTION_DAYS[tier];
  }

  const reader = state.cloud === 'gcp' ? state.reader : '';

  // Primitives, so the check below re-runs only when what it checks changes.
  const identity = state.cloud === 'gcp' ? gcpDownloadIdentity(state, existing) : null;
  const checkReader = identity?.reader;
  const checkKeyFileProvider = identity?.keyFileProvider;
  const checksDownload = state.cloud === 'gcp';
  const dailyPath = state.s3Path;
  const hourlyPath = state.hourlyPath;
  const readsAs = checkReader ?? (checkKeyFileProvider === undefined ? 'your gcloud account' : 'the provider\u2019s service account key');
  const [check, setCheck] = useState<DownloadCheck>(() => checksDownload ? { status: 'checking' } : { status: 'not-needed' });
  const [checkRun, setCheckRun] = useState(0);
  // Token-guarded like the wizard's step loaders: a gcloud answer for an
  // earlier identity or path — or one landing after ← Back — must not
  // overwrite the current check.
  const checkTokenRef = useRef(0);
  useEffect(() => {
    if (!checksDownload) return;
    const token = ++checkTokenRef.current;
    setCheck({ status: 'checking' });
    const targets: { tier: DataSource; path: string }[] = [];
    if (dailyPath.length > 0) targets.push({ tier: 'daily', path: dailyPath });
    if (hourlyPath.length > 0) targets.push({ tier: 'hourly', path: hourlyPath });
    // One tier at a time, stopping at the first refusal: each is a gcloud
    // spawn, and one failure already blocks the save.
    const run = async (): Promise<DownloadCheck> => {
      for (const { tier, path } of targets) {
        let result: GcsDownloadCheckResult;
        try {
          result = await api.verifyGcsDownload({
            bucketPath: path,
            ...(checkReader === undefined ? {} : { impersonateServiceAccount: checkReader }),
            ...(checkKeyFileProvider === undefined ? {} : { keyFileProvider: checkKeyFileProvider }),
          });
        } catch (err: unknown) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (!result.ok) return { status: 'failed', tier, error: result.error };
      }
      return { status: 'ok' };
    };
    void run().then(next => {
      if (checkTokenRef.current === token) setCheck(next);
    });
    return () => { checkTokenRef.current += 1; };
  }, [api, checksDownload, dailyPath, hourlyPath, checkReader, checkKeyFileProvider, checkRun]);
  const checkBlocksSave = check.status === 'checking' || check.status === 'failed';

  function handleSave() {
    if (nameError !== null || saving) return;
    setSaving(true);
    setSaveError(null);
    api.writeConfig({
      providerName: providerNaming.value,
      type: state.cloud,
      // GCP authenticates through Application Default Credentials, which the
      // config expresses by omitting a credential field entirely. The empty
      // string keeps the payload's shape while the gcp arm of
      // `upsertWizardProvider` ignores it.
      profile: state.cloud === 'gcp' ? '' : state.profile,
      // The reader the GCP chain browsed as becomes the provider's
      // `impersonateServiceAccount`. '' (clear) only when the user emptied a
      // reader the wizard showed them; otherwise blank is omitted, so an
      // existing entry's reader is carried (see `goToGcpConfirm`).
      ...(state.cloud === 'gcp' && (reader !== '' || state.clearsReader) ? { impersonateServiceAccount: reader } : {}),
      dailyBucket: state.s3Path,
      // Each collected tier with the retention its card shows.
      ...(state.s3Path.length > 0 ? { retentionDays: tierRetention('daily') } : {}),
      ...(state.hourlyPath.length > 0 ? { hourlyBucket: state.hourlyPath, hourlyRetentionDays: tierRetention('hourly') } : {}),
      // GCP has no Cost Optimization Hub analogue and `validateGcpSync`
      // rejects the key, so it is never collected — but never sent, either.
      ...(state.cloud !== 'gcp' && state.costOptPath.length > 0
        ? { costOptBucket: state.costOptPath, costOptRetentionDays: tierRetention('costOptimization') }
        : {}),
    }).then(() => {
      onComplete();
    }).catch((err: unknown) => {
      // Surface the failure instead of silently resetting the button — a
      // writeConfig error (e.g. an invalid provider name reaching the YAML
      // upsert, or a disk/permission failure) otherwise left the user pressing
      // Complete Setup with nothing happening and no path forward.
      setSaving(false);
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }

  const paths: { value: string; tier: DataSource }[] = [];
  if (state.s3Path.length > 0) paths.push({ value: state.s3Path, tier: 'daily' });
  if (state.hourlyPath.length > 0) paths.push({ value: state.hourlyPath, tier: 'hourly' });
  if (state.costOptPath.length > 0) paths.push({ value: state.costOptPath, tier: 'costOptimization' });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Confirm Setup</h2>
        <p className="text-sm text-text-secondary mt-1">Review your configuration</p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <p className="text-xs text-text-muted uppercase tracking-wider">Provider name</p>
          {providerNaming.fixed ? (
            <p className="text-sm font-mono text-text-primary mt-0.5">{providerNaming.value}</p>
          ) : (
            <>
              <input
                id="provider-name"
                aria-label="Provider name"
                value={providerNaming.value}
                onChange={(e) => { providerNaming.onChange(e.target.value); }}
                placeholder={`e.g. ${defaultProviderName(state.cloud)}`}
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {nameError !== null && providerNaming.value.length > 0 ? (
                <p className="text-xs text-negative mt-1">{nameError}</p>
              ) : (
                <p className="text-xs text-text-muted mt-1">Names this billing source — it becomes the data folder and the Provider dimension value.</p>
              )}
            </>
          )}
        </div>

        {state.cloud === 'aws' ? (
          <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
            <p className="text-xs text-text-muted uppercase tracking-wider">AWS Profile</p>
            <p className="text-sm font-mono text-text-primary mt-0.5">{state.profile}</p>
          </div>
        ) : (
          <GcpAccessCard
            project={state.project?.id}
            reader={reader}
            check={check}
            readsAs={readsAs}
            onRecheck={() => { setCheckRun(n => n + 1); }}
          />
        )}

        {paths.map(({ value, tier }) => {
          const label = SOURCE_LABELS[tier].title;
          const selected = tierRetention(tier);
          // A hand-tuned window that isn't one of the presets still shows,
          // pressed, so keeping it is the default rather than impossible.
          const options = RETENTION_OPTIONS[tier].some(opt => opt.days === selected)
            ? RETENTION_OPTIONS[tier]
            : [...RETENTION_OPTIONS[tier], { days: selected, label: `${String(selected)} days` }].sort((x, y) => x.days - y.days);
          return (
          <div key={tier} className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-2.5">
            <p className="text-xs text-text-muted uppercase tracking-wider">{label}</p>
            <p className="text-sm font-mono text-text-primary mt-0.5 break-all">{value}</p>
            <fieldset aria-label={`${label} retention`} className="m-0 min-w-0 border-0 p-0 flex flex-wrap items-center gap-1.5 mt-2">
              <span aria-hidden="true" className="mr-1 text-xs text-text-muted">Keep</span>
              {options.map(opt => (
                <button
                  key={opt.days}
                  type="button"
                  aria-pressed={selected === opt.days}
                  onClick={() => { retention.onPick(tier, opt.days); }}
                  className={[
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    selected === opt.days
                      ? 'bg-accent text-bg-primary'
                      : 'bg-bg-tertiary/50 text-text-secondary hover:text-text-primary',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </fieldset>
          </div>
          );
        })}

        {optionalTiers.map(({ tier, onAdd }) => {
          const { title, description } = SOURCE_LABELS[tier];
          // A tier this run did not touch but the provider already has: the
          // writer keeps it, so say so rather than inviting a duplicate add.
          const kept = existing?.sync[tier]?.bucket;
          return (
            <div key={tier} className="rounded-lg border border-dashed border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="text-xs text-text-muted uppercase tracking-wider">{title}</p>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">Optional</span>
              </div>
              {kept === undefined
                ? <p className="text-xs text-text-muted mt-1">{description}. Skip it now and add it any time from Data &amp; Sync.</p>
                : <p className="text-xs text-text-muted mt-1">Kept as configured: <span className="font-mono text-text-secondary">{String(kept)}</span></p>}
              <Button variant="outline" size="sm" onClick={onAdd} className="mt-2.5">
                {kept === undefined ? OPTIONAL_TIER_ADD_LABEL[tier] : 'Change'}
              </Button>
            </div>
          );
        })}
      </div>

      {saveError !== null && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3" role="alert">
          <p className="text-sm font-medium text-negative">Couldn&apos;t save your configuration</p>
          <p className="text-xs text-text-secondary mt-0.5 break-words">{saveError}</p>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <div className="flex items-center gap-3">
          {/* Only after a refusal, and deliberately small: for a setup that is
              genuinely offline now, or a check that misreads a working grant. */}
          {check.status === 'failed' && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || nameError !== null}
              className="text-xs text-text-muted underline underline-offset-2 hover:text-text-secondary disabled:opacity-50"
            >
              Save anyway
            </button>
          )}
          <Button
            onClick={handleSave}
            disabled={saving || nameError !== null || checkBlocksSave}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            {saving ? 'Saving...' : 'Complete Setup'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** How per-tier Configure from Data & Sync opened the wizard, if it did: a
 *  GCP provider on its own bucket (no cost-optimization tier there), an AWS
 *  one on its profile. Null for every other run. */
type SourceMode =
  | { readonly kind: 'gcp'; readonly tier: GcpSource; readonly bucket: string; readonly prefix: string }
  | { readonly kind: 'aws'; readonly tier: DataSource; readonly profile: string }
  | null;

function resolveSourceMode(
  source: DataSource | undefined,
  profile: string | undefined,
  gcpSource: SetupWizardProps['gcpSource'],
): SourceMode {
  if (source === undefined) return null;
  if (gcpSource !== undefined) {
    return source === 'costOptimization' ? null : { kind: 'gcp', tier: source, bucket: gcpSource.bucket, prefix: gcpSource.prefix };
  }
  return profile === undefined ? null : { kind: 'aws', tier: source, profile };
}

function initialWizardStep(sourceMode: SourceMode, firstRun: boolean): WizardStep {
  if (sourceMode?.kind === 'gcp') {
    const { tier, bucket, prefix } = sourceMode;
    return { step: 'gcp-browse', project: null, source: tier, bucket, prefix, prefixes: [], loading: true, folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: '', path: prefix.split('/').filter(s => s.length > 0) };
  }
  if (sourceMode?.kind === 'aws') {
    return { step: 'bucket', profile: sourceMode.profile, source: sourceMode.tier, buckets: [], loading: true, selected: '', error: '' };
  }
  // Naming comes first on a true first run; otherwise (workspace already
  // named, e.g. created via Settings → New workspace) start at the hub.
  return firstRun ? { step: 'welcome' } : { step: 'start' };
}

/** The cloud a step belongs to. Steps before a cloud is chosen count as AWS,
 *  the wizard's historical default. */
function wizardCloudOf(wizard: WizardStep): 'aws' | 'gcp' {
  if (wizard.step === 'confirm') return wizard.cloud;
  return isGcpStep(wizard) ? 'gcp' : 'aws';
}

/** The name this run writes under until the user types one: the cloud's
 *  default, or in add mode the first one no provider has yet. */
function derivedProviderName(cloud: 'aws' | 'gcp', addMode: boolean, taken: readonly string[]): string {
  return addMode ? freeProviderName(cloud, taken) : defaultProviderName(cloud);
}

/** The optional tiers a Confirm step offers to add: those this run has not
 *  collected. GCP has hourly only — no Cost Optimization Hub analogue. */
function optionalTiersFor(
  state: Extract<WizardStep, { step: 'confirm' }>,
  add: { readonly gcpHourly: (project: GcpProjectChoice | null) => void; readonly awsTier: (profile: string, tier: DataSource) => void },
): OptionalTier[] {
  if (state.cloud === 'gcp') {
    const { project } = state;
    return state.hourlyPath.length === 0 ? [{ tier: 'hourly', onAdd: () => { add.gcpHourly(project); } }] : [];
  }
  const { profile } = state;
  const missing: DataSource[] = [];
  if (state.hourlyPath.length === 0) missing.push('hourly');
  if (state.costOptPath.length === 0) missing.push('costOptimization');
  return missing.map(tier => ({ tier, onAdd: () => { add.awsTier(profile, tier); } }));
}

export function SetupWizard({ onComplete, source: initialSource, profile: initialProfile, providerName: initialProviderName, gcpSource, mode, workspaceNaming, workspaceLabel, otherWorkspaces }: Readonly<SetupWizardProps>): React.JSX.Element {
  const api = useCostApi();
  // Resolved once: the props that set it do not change for the wizard's
  // lifetime, and a stable object keeps the start effect from re-running
  // whenever the parent passes a fresh `gcpSource`.
  const [sourceMode] = useState(() => resolveSourceMode(initialSource, initialProfile, gcpSource));
  const gcpSourceMode = sourceMode?.kind === 'gcp' ? sourceMode : undefined;
  const isSourceMode = sourceMode !== null;
  const [workspaceName, setWorkspaceName] = useState(workspaceNaming?.initialName ?? '');
  // Provider identity: fixed when reconfiguring an existing provider (source
  // mode), free-text when adding one, prefilled 'aws-main' on first run.
  const [providerName, setProviderName] = useState(initialProviderName ?? (mode === 'add' ? '' : 'aws-main'));
  // The configured providers: their names guard add mode, and the one this
  // run replaces seeds the Confirm step's retention windows.
  const [existingConfigs, setExistingConfigs] = useState<readonly ProviderConfig[]>([]);
  const existingProviders = existingConfigs.map(p => String(p.name));
  // Confirm-step retention picks. Wizard-level, like `providerName`, so ← Back
  // and forward again keeps them; cleared when a cloud chain starts over.
  const [retentionPicks, setRetentionPicks] = useState<Partial<Record<DataSource, number>>>({});
  // Each configured GCP provider's reader, to prefill the field when the run
  // reconfigures that provider — so it browses as what the sync will use.
  const existingGcpReaders = useMemo<ReadonlyMap<string, string>>(() => new Map(existingConfigs.flatMap(p =>
    p.type === 'gcp' && p.impersonateServiceAccount !== undefined ? [[String(p.name), p.impersonateServiceAccount]] : [])), [existingConfigs]);
  // Whether the user has typed a name. Until they do, the default is DERIVED
  // from the cloud they picked rather than written into state on entry — a
  // one-way `setProviderName('gcp-main')` survived backing out of the GCP
  // chain and named an AWS provider "gcp-main".
  const [providerNameEdited, setProviderNameEdited] = useState(false);
  // Re-reads the "Signed in as" panel when a GCP step's Retry runs.
  const [gcpIdentityRefresh, setGcpIdentityRefresh] = useState(0);
  useEffect(() => {
    api.getConfig().then(config => {
      const names = config.providers.map(p => String(p.name));
      setExistingConfigs(config.providers);
      // Source mode without an explicit target: writeConfig upserts by name,
      // so per-tier Configure must land on the provider it came from — the
      // first configured one, matching the page that opened us.
      if (initialProviderName === undefined && isSourceMode && names[0] !== undefined) {
        setProviderName(names[0]);
      }
    }).catch(() => { /* onboarding: no config yet */ });
  }, [api, initialProviderName, isSourceMode]);
  const providerNameFixed = initialProviderName !== undefined || isSourceMode;
  // `workspaceNaming` can arrive AFTER mount (the host learns the workspace
  // mode from an IPC round-trip that races the setup check) — the useState
  // initializer above won't re-run, so seed the field when the prop appears.
  // Only an untouched (empty) field is seeded; user input is never clobbered.
  const initialWorkspaceName = workspaceNaming?.initialName;
  useEffect(() => {
    if (initialWorkspaceName !== undefined) {
      setWorkspaceName((current) => (current === '' ? initialWorkspaceName : current));
    }
  }, [initialWorkspaceName]);
  const [wizard, setWizard] = useState<WizardStep>(() => initialWizardStep(sourceMode, workspaceNaming !== undefined));
  const [collectedPaths, setCollectedPaths] = useState(EMPTY_PATHS);
  // The GCP chain's optional reader, as typed: a full address, or a bare
  // account name (the default, `costgoblin-reader`) completed with the project
  // the user picks — see `gcpReaderFor`. Every bucket listing and browse below
  // runs as it, and it is written as the provider's `impersonateServiceAccount`
  // — so the wizard sees exactly what the sync will. '' means the ADC login.
  // Seeded from a per-tier Configure's provider, which never passes the intro.
  const [gcpReader, setGcpReader] = useState(gcpSource?.impersonateServiceAccount ?? '');
  // The reader the field was prefilled with, so emptying it reads as a
  // decision to clear rather than "nothing known".
  const [gcpReaderSeed, setGcpReaderSeed] = useState(gcpSource?.impersonateServiceAccount ?? '');
  /** The reader's full address once `project` completes a bare name; undefined
   *  for none (the ADC login). A per-tier Configure (no project) is seeded
   *  with the provider's full address, so it resolves without one. */
  function gcpReaderFor(project: GcpProjectChoice | null): string | undefined {
    const resolved = resolveReaderInput(gcpReader, project?.id);
    return resolved.kind === 'address' ? resolved.address : undefined;
  }
  // Monotonic token for every step loader, AWS and GCP alike. Each resolver
  // rebuilds a whole step object from captured args, so without this a slow
  // response (a cold ADC token refresh, gcloud sitting on a re-auth prompt
  // until the 20s timeout, or the AWS SDK retrying against a dead SSO session)
  // would land AFTER the user navigated away and teleport them back.
  // `handleBeaconApply` already guards the same way via a functional update.
  const stepRequestRef = useRef(0);
  const [sourceStarted, setSourceStarted] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState('');

  function handleJumpBack(name: string) {
    setSwitchingTo(name);
    setSwitchError('');
    // Switching relaunches the app into the chosen workspace — on success
    // this process quits, so there is no follow-up state to manage.
    api.switchWorkspace(name).catch((err: unknown) => {
      setSwitchingTo(null);
      setSwitchError(err instanceof Error ? err.message : String(err));
    });
  }

  const jumpBack: JumpBackProps | undefined =
    otherWorkspaces !== undefined && otherWorkspaces.length > 0
      ? { names: otherWorkspaces, onSwitch: handleJumpBack, switchingTo, error: switchError }
      : undefined;

  // Single completion funnel: every finish path reports the chosen workspace
  // name (when the user changed it to something valid) so the host can claim
  // it as part of the completion relaunch.
  function finish(): void {
    if (workspaceNaming !== undefined && workspaceName !== workspaceNaming.initialName && isValidWorkspaceName(workspaceName)) {
      onComplete({ workspaceName });
      return;
    }
    onComplete();
  }

  /** Write the GCP-shaped template (only where the file is absent) and reveal
   *  the folder. Re-runnable: the button becomes "open the folder again", and
   *  a second press must not clobber a config the user has already edited —
   *  the handler only writes files that do not exist. */
  function handleGcpScaffold(): void {
    const token = ++stepRequestRef.current;
    api.scaffoldConfig('gcp').then(() => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp', scaffolded: true, error: '' });
    }).catch((err: unknown) => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp', scaffolded: false, error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Back to the GCP intro from inside the chain. Bumps the step token like
   *  `handleBack` does: a `gcloud projects list` still running against
   *  thousands of projects would otherwise land later and drag the user back
   *  to the project step, discarding whatever they had started on the intro. */
  function goToGcpIntro(): void {
    ++stepRequestRef.current;
    setWizard({ step: 'gcp', scaffolded: false, error: '' });
  }

  /** Enter the GCP browse flow through the project listing. */
  function goToGcpProjectStep(): void {
    // See `goToProfileStep`: the two chains share `collectedPaths`.
    setCollectedPaths(EMPTY_PATHS);
    setRetentionPicks({});
    reloadGcpProjects();
  }

  /** Enter the GCP browse flow with a typed project ID, never running
   *  `gcloud projects list`. The bucket listing runs while the intro is still
   *  on screen, so a reader that can't be read as is reported there — beside
   *  the field to fix — instead of one step later. Any other outcome (buckets,
   *  a listing denial, a sign-in) is the bucket step's to show. */
  function startGcpFromTypedProject(projectId: string): void {
    setCollectedPaths(EMPTY_PATHS);
    const project: GcpProjectChoice = { id: projectId, typed: true };
    const reader = gcpReaderFor(project);
    const token = ++stepRequestRef.current;
    const toBucketStep = (buckets: readonly { name: string }[], error: string): void => {
      setWizard({ step: 'gcp-bucket', project, source: 'daily', buckets, loading: false, selected: '', error });
    };
    setWizard(prev => prev.step === 'gcp' ? { ...prev, check: { status: 'checking' } } : prev);
    api.listGcsBuckets(projectId, reader).then(result => {
      if (stepRequestRef.current !== token) return;
      const error = result.error ?? '';
      if (reader !== undefined && isGcpImpersonationError(new Error(error))) {
        setWizard(prev => prev.step === 'gcp'
          ? { ...prev, check: { status: 'denied', reader, project: projectId, message: error } }
          : prev);
        return;
      }
      toBucketStep(result.buckets, error);
    }).catch((err: unknown) => {
      if (stepRequestRef.current !== token) return;
      toBucketStep([], err instanceof Error ? err.message : String(err));
    });
  }

  /** The listing half of `goToGcpProjectStep`, without the `collectedPaths`
   *  reset — so the step's own Retry re-runs `gcloud projects list` after a
   *  sign-in without discarding anything the user has already picked. */
  function reloadGcpProjects(): void {
    const token = ++stepRequestRef.current;
    setWizard({ step: 'gcp-project', projects: [], loading: true, selected: '', error: '' });
    api.listGcpProjects().then(result => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-project', projects: result.projects, loading: false, selected: '', error: result.error ?? '' });
    }).catch((err: unknown) => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-project', projects: [], loading: false, selected: '', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function startGcpBucketStep(project: GcpProjectChoice | null, source: GcpSource): void {
    const token = ++stepRequestRef.current;
    // Per-tier Configure knows the bucket but not the project, and listing
    // buckets needs one: offer the typed entry instead of an error.
    if (project === null) {
      setWizard({ step: 'gcp-bucket', project, source, buckets: [], loading: false, selected: '', error: '' });
      return;
    }
    setWizard({ step: 'gcp-bucket', project, source, buckets: [], loading: true, selected: '', error: '' });
    api.listGcsBuckets(project.id, gcpReaderFor(project)).then(result => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-bucket', project, source, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    }).catch((err: unknown) => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-bucket', project, source, buckets: [], loading: false, selected: '', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function gcpBrowseTo(project: GcpProjectChoice | null, source: GcpSource, bucket: string, prefix: string): void {
    const path = prefix.split('/').filter(s => s.length > 0);
    const token = ++stepRequestRef.current;
    setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: [], loading: true, folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: '', path });
    // Listing a bucket's objects needs no project; '' leaves the SDK to skip it.
    api.browseGcs({ projectId: project?.id ?? '', bucket, prefix, impersonateServiceAccount: gcpReaderFor(project) }).then(result => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: result.prefixes, loading: false, folder: result.folder, hasParquet: result.hasParquet, truncated: result.truncated, error: result.error ?? '', path });
    }).catch((err: unknown) => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: [], loading: false, folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: err instanceof Error ? err.message : String(err), path });
    });
  }

  function handleGcpBrowseConfirm(): void {
    if (wizard.step !== 'gcp-browse') return;
    const { project, source, bucket, prefix } = wizard;
    const gcsPath = `gs://${bucket}/${prefix}`;
    const updated = { ...collectedPaths };

    // Daily straight to Confirm, exactly as the AWS chain does: hourly is
    // optional (the exporter publishes it only when deployed with
    // TIERS=daily,hourly), so it sits one ← Back away on Confirm rather than
    // being a step every user has to skip.
    if (source === 'daily') {
      updated.daily = gcsPath;
    } else {
      updated.hourly = gcsPath;
    }
    setCollectedPaths(updated);
    goToGcpConfirm(project, updated);
  }

  /** Leave the GCP browse chain for the Confirm screen, keeping whatever
   *  tiers were collected so far. */
  function handleGcpSkip(): void {
    if (wizard.step !== 'gcp-browse' && wizard.step !== 'gcp-bucket') return;
    goToGcpConfirm(wizard.project);
  }

  function goToGcpConfirm(project: GcpProjectChoice | null, paths?: { daily: string; hourly: string; costOpt: string }): void {
    // Skip is offered while the hourly bucket step is still loading; without
    // this its late listing would pull the user back from Confirm.
    ++stepRequestRef.current;
    const p = paths ?? collectedPaths;
    setWizard({
      step: 'confirm',
      cloud: 'gcp',
      project,
      // The full address, completed with the chosen project — what the
      // sync will read as, and what Confirm shows and verifies.
      reader: gcpReaderFor(project) ?? '',
      // Clearing is only ever sent for a reader the user saw and removed. A
      // blank field with nothing prefilled is ambiguous — config not loaded
      // yet, or a rename at Confirm onto an existing provider — so the
      // upsert carries that entry's reader instead of dropping it.
      clearsReader: gcpReader.trim() === '' && gcpReaderSeed !== '',
      s3Path: p.daily,
      hourlyPath: p.hourly,
      // GCP never collects a cost-optimization path; carrying one here would
      // put a key in the config that `validateGcpSync` refuses to load.
      costOptPath: '',
    });
  }


  // Goes through `startBucketStep` rather than repeating its body, so the
  // token guard and the error path stay in one place.
  useEffect(() => {
    if (sourceStarted || sourceMode === null) return;
    setSourceStarted(true);
    if (sourceMode.kind === 'gcp') {
      gcpBrowseTo(null, sourceMode.tier, sourceMode.bucket, sourceMode.prefix);
    } else {
      startBucketStep(sourceMode.profile, sourceMode.tier);
    }
  }, [sourceStarted, api, sourceMode]);

  function goToProfileStep() {
    // `collectedPaths` is shared by both chains, so entering one must clear
    // what the other collected. Without this, an s3:// hourly path picked on
    // the AWS leg survived a ← Back to the hub and was written into a gcp
    // provider, whose loader then refuses the config on the next launch.
    setCollectedPaths(EMPTY_PATHS);
    setRetentionPicks({});
    // Token-guarded like the other step loaders: a slow profile listing landing
    // after the user navigated on would otherwise teleport them back here.
    const token = ++stepRequestRef.current;
    setWizard({ step: 'profile', profiles: [], loading: true, selected: '' });
    api.listAwsProfiles().then(profiles => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'profile', profiles, loading: false, selected: '' });
    }).catch(() => {
      if (stepRequestRef.current !== token) return;
      // Leave the spinner-free empty picker rather than hanging on "loading".
      setWizard({ step: 'profile', profiles: [], loading: false, selected: '' });
    });
  }

  function handleWelcomeNext() {
    setWizard({ step: 'start' });
  }

  function handleReturnToStart() {
    // Invalidate any in-flight step loader: the ✕ is reachable from a bucket/
    // browse/beacon/project step whose loader is mid-flight, and its late
    // response would otherwise teleport the user back into that step.
    stepRequestRef.current += 1;
    setCollectedPaths(EMPTY_PATHS);
    // The ✕ abandons the whole configuration, so the typed name goes with the
    // collected paths. Left set, a name entered for an abandoned GCP provider
    // prefilled the next AWS run — the same wrong-cloud-name failure the
    // derived default exists to prevent, just reached by a different route.
    //
    // Deliberately NOT reset in `goToProfileStep` / `goToGcpProjectStep`:
    // those are also reached by ← Back mid-flow, where clearing a name the
    // user has already typed would be the more surprising behaviour.
    setProviderNameEdited(false);
    setGcpReader(DEFAULT_READER_ACCOUNT_ID);
    setGcpReaderSeed(DEFAULT_READER_ACCOUNT_ID);
    setWizard({ step: 'start' });
  }

  /** Enter the GCP chain, seeding the reader from the provider this run would
   *  write — its fixed or typed name, else the GCP default. A provider that
   *  already exists keeps its own reader, or its lack of one (re-running setup
   *  must not quietly switch who it downloads as); a new one starts on the
   *  account the setup guide creates, completed with the project picked next. */
  function enterGcp(): void {
    const name = providerNameFixed || providerNameEdited || mode === 'add' ? providerName : defaultProviderName('gcp');
    const existingGcp = existingConfigs.some(p => p.type === 'gcp' && String(p.name) === name);
    const seed = existingGcp ? existingGcpReaders.get(name) ?? '' : DEFAULT_READER_ACCOUNT_ID;
    setGcpReader(seed);
    setGcpReaderSeed(seed);
    setWizard({ step: 'gcp', scaffolded: false, error: '' });
  }

  function handleProfileSelect(profile: string) {
    startBucketStep(profile, 'daily');
  }

  function startBucketStep(profile: string, source: DataSource) {
    // Token-guarded like the GCP loaders (see `stepRequestRef`): the Retry
    // button makes a slow listing routine — the user leaves for a browser —
    // so a response landing after ← Back would teleport them into this step.
    const token = ++stepRequestRef.current;
    setWizard({ step: 'bucket', profile, source, buckets: [], loading: true, selected: '', error: '' });
    api.listS3Buckets(profile).then(result => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'bucket', profile, source, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    }).catch((err: unknown) => {
      // Surfaced rather than swallowed. The empty catch pinned the step on
      // "Loading buckets…" forever — no message, and (since the panel is what
      // hosts them) no sign-in and no Retry.
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'bucket', profile, source, buckets: [], loading: false, selected: '', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function handleBucketSelect(bucket: string) {
    if (wizard.step !== 'bucket') return;
    const { profile, source } = wizard;
    // On the first pass of initial setup, look for a team configuration
    // published at the bucket's beacon key before walking prefixes by hand.
    // Skipped in source mode (adding hourly/cost-opt to an existing setup).
    if (source === 'daily' && !isSourceMode) {
      // Token-guarded: the beacon probe is an S3 GetObject that can sit in SDK
      // retries for seconds on a dying SSO session. Without the guard a late
      // 'found' response yanked the user out of a step they had since left
      // (including out of the GCP flow) into an AWS beacon screen.
      const token = ++stepRequestRef.current;
      setWizard({ ...wizard, selected: bucket, loading: true });
      api.checkConfigBeacon({ profile, bucket }).then(result => {
        if (stepRequestRef.current !== token) return;
        if (result.status === 'found') {
          setWizard({ step: 'beacon', profile, source, bucket, content: result.content, summary: result.summary, applying: false, error: '' });
        } else {
          browseTo(profile, source, bucket, '');
        }
      }).catch(() => {
        if (stepRequestRef.current !== token) return;
        browseTo(profile, source, bucket, '');
      });
      return;
    }
    browseTo(profile, source, bucket, '');
  }

  function handleBeaconApply() {
    if (wizard.step !== 'beacon') return;
    const { content, profile } = wizard;
    setWizard({ ...wizard, applying: true, error: '' });
    api.applyConfigBundle({ content, credentialsProfile: profile }).then(result => {
      if (result.status === 'applied') {
        finish();
      } else {
        setWizard(prev => prev.step === 'beacon' ? { ...prev, applying: false, error: result.message } : prev);
      }
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setWizard(prev => prev.step === 'beacon' ? { ...prev, applying: false, error: message } : prev);
    });
  }

  function browseTo(profile: string, source: DataSource, bucket: string, prefix: string) {
    const path = prefix.split('/').filter(s => s.length > 0);
    // Token-guarded like the GCP browse leg: a slow ListObjects response (a
    // dying SSO session sits in SDK retries for seconds) must not land after
    // the user navigated away and overwrite the current step.
    const token = ++stepRequestRef.current;
    setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: [], loading: true, isBillingExport: false, detectedType: 'unknown', missingColumns: [], path, error: '' });
    api.browseS3({ profile, bucket, prefix }).then(result => {
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: result.prefixes, loading: false, isBillingExport: result.isBillingExport, detectedType: result.detectedType, missingColumns: result.missingColumns, path, error: result.error ?? '' });
    }).catch((err: unknown) => {
      // Surfaced rather than swallowed. The empty catch (and the handler's
      // swallow-to-empty) rendered an expired token / AccessDenied as "No
      // subfolders found" — the browse-step dead end #539/#542 exist to remove.
      if (stepRequestRef.current !== token) return;
      setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: [], loading: false, isBillingExport: false, detectedType: 'unknown', missingColumns: [], path, error: err instanceof Error ? err.message : String(err) });
    });
  }

  function handleNavigate(prefix: string) {
    if (wizard.step !== 'browse') return;
    browseTo(wizard.profile, wizard.source, wizard.bucket, prefix);
  }

  function handleBrowseConfirm() {
    if (wizard.step !== 'browse') return;
    const s3Path = `s3://${wizard.bucket}/${wizard.prefix}`;
    const profile = wizard.profile;
    const source = wizard.source;

    const updated = { ...collectedPaths };
    if (source === 'daily') {
      updated.daily = s3Path;
    } else if (source === 'hourly') {
      updated.hourly = s3Path;
    } else {
      updated.costOpt = s3Path;
    }
    setCollectedPaths(updated);
    goToConfirm(profile, updated);
  }

  function handleBrowseSkip() {
    if (wizard.step !== 'browse' && wizard.step !== 'bucket') return;
    // Optional tiers are offered one by one on Confirm, so skipping one goes
    // back there rather than on to the next tier.
    goToConfirm(wizard.profile);
  }



  function goToConfirm(profile: string, paths?: { daily: string; hourly: string; costOpt: string }) {
    // See `goToGcpConfirm`: Skip can leave a loader in flight.
    ++stepRequestRef.current;
    const p = paths ?? collectedPaths;
    setWizard({
      step: 'confirm',
      cloud: 'aws',
      profile,
      s3Path: p.daily,
      hourlyPath: p.hourly,
      costOptPath: p.costOpt,
    });
  }

  function handleBack() {
    // Invalidate any in-flight loader before navigating away. Branches that
    // re-enter a guarded loader (startBucketStep, goToProfileStep, browseTo…)
    // bump the token again, so this only affects the direct setWizard exits.
    stepRequestRef.current += 1;
    if (wizard.step === 'profile') {
      setWizard({ step: 'start' });
    } else if (wizard.step === 'beacon') {
      startBucketStep(wizard.profile, wizard.source);
    } else if (wizard.step === 'bucket') {
      if (wizard.source === 'daily') {
        goToProfileStep();
      } else if (wizard.source === 'hourly') {
        startBucketStep(wizard.profile, 'daily');
      } else {
        startBucketStep(wizard.profile, 'hourly');
      }
    } else if (wizard.step === 'browse') {
      startBucketStep(wizard.profile, wizard.source);
    } else if (wizard.step === 'gcp-project') {
      setWizard({ step: 'gcp', scaffolded: false, error: '' });
    } else if (wizard.step === 'gcp-bucket') {
      if (wizard.source === 'daily') {
        // A typed ID returns to the intro, which holds the typed entry; only a
        // project picked from the listing goes back to the listing. No project
        // (per-tier Configure) has no listing to return to either.
        if (wizard.project === null || wizard.project.typed) {
          setWizard({ step: 'gcp', scaffolded: false, error: '' });
        } else {
          goToGcpProjectStep();
        }
      } else {
        startGcpBucketStep(wizard.project, 'daily');
      }
    } else if (wizard.step === 'gcp-browse') {
      startGcpBucketStep(wizard.project, wizard.source);
    } else if (wizard.step === 'confirm') {
      if (wizard.cloud === 'gcp' && gcpSourceMode !== undefined) {
        // Per-tier Configure: back to the folder it opened on, not a bucket
        // step that cannot list without a project.
        gcpBrowseTo(wizard.project, gcpSourceMode.tier, gcpSourceMode.bucket, gcpSourceMode.prefix);
      } else if (wizard.cloud === 'gcp') {
        startGcpBucketStep(wizard.project, 'hourly');
      } else {
        startBucketStep(wizard.profile, 'costOptimization');
      }
    }
  }

  // The name this run will write under, and so the configured provider it
  // replaces: that provider's other tier guards the overlap check, and its
  // windows seed the Confirm step's retention pickers.
  const wizardCloud = wizardCloudOf(wizard);
  const targetProviderName = providerNameFixed || providerNameEdited
    ? providerName
    : derivedProviderName(wizardCloud, mode === 'add', existingProviders);
  const targetProvider = existingConfigs.find(c => String(c.name) === targetProviderName && c.type === wizardCloud);

  // Standalone onboarding renders without the app header — the window's only
  // macOS drag region (titleBarStyle: hiddenInset means no native title bar) —
  // so the backdrop doubles as one and the card opts back out to stay
  // clickable. Skipped in source mode, where the wizard sits in a modal over
  // the normal app chrome. (#317)
  return (
    <div className={`min-h-screen bg-bg-primary flex items-center justify-center p-4${isSourceMode ? '' : ' [-webkit-app-region:drag]'}`}>
      <Card className="relative w-full max-w-lg border-border bg-bg-secondary [-webkit-app-region:no-drag]">
        {!isSourceMode && wizard.step !== 'welcome' && wizard.step !== 'start' && (
          <button
            type="button"
            onClick={handleReturnToStart}
            className="absolute right-3 top-3 z-10 rounded-md px-2 py-1 text-sm text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="Back to start"
          >
            ✕
          </button>
        )}
        <CardContent className="p-8">
          <div className="flex justify-center mb-6">
            <img src="goblin.png" alt="CostGoblin" className="h-16 w-auto" />
          </div>
          {wizard.step === 'welcome' && workspaceNaming !== undefined && (
            <WelcomeStep
              onNext={handleWelcomeNext}
              naming={{ value: workspaceName, onChange: setWorkspaceName }}
              jumpBack={jumpBack}
            />
          )}
          {wizard.step === 'start' && (
            <StartStep
              workspaceLabel={workspaceNaming !== undefined ? workspaceName : workspaceLabel}
              onSetup={goToProfileStep}
              onGcp={enterGcp}
              onImport={() => { setImportOpen(true); }}
              onBack={workspaceNaming !== undefined ? () => { setWizard({ step: 'welcome' }); } : undefined}
              jumpBack={jumpBack}
            />
          )}
          {wizard.step === 'gcp' && (
            <GcpIntroStep
              state={wizard}
              reader={gcpReader}
              onReaderChange={setGcpReader}
              onBrowse={goToGcpProjectStep}
              onProjectId={startGcpFromTypedProject}
              onScaffold={handleGcpScaffold}
              onDone={finish}
              onBack={() => { ++stepRequestRef.current; setWizard({ step: 'start' }); }}
            />
          )}
          {wizard.step === 'gcp-project' && (
            <GcpProjectStep
              state={wizard}
              onSelect={(projectId) => { startGcpBucketStep({ id: projectId, typed: false }, 'daily'); }}
              onTyped={(projectId) => { startGcpBucketStep({ id: projectId, typed: true }, 'daily'); }}
              onManual={goToGcpIntro}
              onBack={handleBack}
              onRetry={() => { setGcpIdentityRefresh(n => n + 1); reloadGcpProjects(); }}
            />
          )}
          {wizard.step === 'gcp-bucket' && (
            <GcpBucketStep
              state={wizard}
              reader={gcpReaderFor(wizard.project)}
              onSelect={(bucket) => { gcpBrowseTo(wizard.project, wizard.source, bucket, ''); }}
              // Per-tier Configure came for this one tier; ✕ is the way out.
              onSkip={wizard.source === 'daily' || gcpSourceMode !== undefined ? undefined : handleGcpSkip}
              onBack={handleBack}
              onRetry={() => { setGcpIdentityRefresh(n => n + 1); startGcpBucketStep(wizard.project, wizard.source); }}
            />
          )}
          {wizard.step === 'gcp-browse' && (
            <GcpBrowseStep
              state={wizard}
              // Both legs: Back-navigation lets the user re-pick daily after
              // hourly is already collected, and validateGcpSync rejects the
              // overlap in either direction.
              conflictsWith={(wizard.source === 'hourly' ? collectedPaths.daily : collectedPaths.hourly)
                || (targetProvider?.sync[wizard.source === 'hourly' ? 'daily' : 'hourly']?.bucket ?? '')}
              onNavigate={(prefix) => { gcpBrowseTo(wizard.project, wizard.source, wizard.bucket, prefix); }}
              onRetry={() => { setGcpIdentityRefresh(n => n + 1); gcpBrowseTo(wizard.project, wizard.source, wizard.bucket, wizard.prefix); }}
              onConfirm={handleGcpBrowseConfirm}
              // Per-tier Configure came for this one tier; ✕ is the way out.
              onSkip={wizard.source === 'daily' || gcpSourceMode !== undefined ? undefined : handleGcpSkip}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'profile' && <ProfileStep state={wizard} onSelect={handleProfileSelect} onSkip={finish} onBack={handleBack} />}
          {wizard.step === 'beacon' && (
            <BeaconStep
              state={wizard}
              onApply={handleBeaconApply}
              onSkip={() => { browseTo(wizard.profile, wizard.source, wizard.bucket, ''); }}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'bucket' && (
            <BucketStep
              state={wizard}
              onSelect={handleBucketSelect}
              onSkip={wizard.source === 'daily' ? undefined : handleBrowseSkip}
              onBack={handleBack}
              onRetry={() => { startBucketStep(wizard.profile, wizard.source); }}
            />
          )}
          {wizard.step === 'browse' && (
            <BrowseStep
              state={wizard}
              onNavigate={handleNavigate}
              onConfirm={handleBrowseConfirm}
              onSkip={wizard.source === 'daily' ? undefined : handleBrowseSkip}
              onBack={handleBack}
              onRetry={() => { browseTo(wizard.profile, wizard.source, wizard.bucket, wizard.prefix); }}
            />
          )}
          {wizard.step === 'confirm' && (
            <ConfirmStep
              state={wizard}
              providerNaming={{
                value: targetProviderName,
                fixed: providerNameFixed,
                checkTaken: mode === 'add',
                takenNames: existingProviders,
                onChange: (value) => { setProviderNameEdited(true); setProviderName(value); },
              }}
              // Only a same-cloud entry: a different-cloud one is refused by
              // the writer, so its values must not seed anything.
              existing={targetProvider}
              retention={{
                picks: retentionPicks,
                onPick: (tier, days) => { setRetentionPicks(prev => ({ ...prev, [tier]: days })); },
              }}
              optionalTiers={isSourceMode ? [] : optionalTiersFor(wizard, {
                gcpHourly: (project) => { startGcpBucketStep(project, 'hourly'); },
                awsTier: startBucketStep,
              })}
              onComplete={finish}
              onBack={handleBack}
            />
          )}
          {/* One panel for the whole GCP chain, in a fixed slot so it survives
              step changes instead of re-running gcloud on every click. The
              steps' Retry buttons bump it: the usual reason to retry is a
              sign-in that just changed who these identities are.
              Per-tier Configure names its provider, whose
              `impersonateServiceAccount` decides who downloads; any other GCP
              run creates or replaces one by a name not yet final, so it asks
              without one. */}
          {isGcpStep(wizard) && (
            <div className="mt-5">
              <GcpIdentityPanel context="wizard" refreshKey={gcpIdentityRefresh} providerName={gcpSourceMode === undefined ? undefined : initialProviderName} />
            </div>
          )}
        </CardContent>
      </Card>
      {importOpen && (
        <ImportConfigDialog
          onClose={() => { setImportOpen(false); }}
          onApplied={finish}
        />
      )}
    </div>
  );
}
