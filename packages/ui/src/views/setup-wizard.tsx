import type { ConfigBundleSummary, GcpProject, GcsFolderKind } from '@costgoblin/core/browser';
import { gcsTiersOverlap, isValidWorkspaceName, parseProviderName } from '@costgoblin/core/browser';
import { useState, useEffect } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import { BundleSummaryCard, ImportConfigDialog } from '../components/config-sharing.js';
import { ProfilePicker } from '../components/profile-picker.js';
import { GcloudLoginButton, SsoLoginButton } from '../components/sso-login-button.js';

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

type WizardStep =
  | { step: 'welcome' }
  | { step: 'start' }
  | { step: 'gcp'; scaffolded: boolean; error: string }
  | { step: 'gcp-project'; projects: readonly GcpProject[]; loading: boolean; selected: string; error: string }
  | { step: 'gcp-bucket'; project: string; source: GcpSource; buckets: readonly { name: string }[]; loading: boolean; selected: string; error: string }
  | { step: 'gcp-browse'; project: string; source: GcpSource; bucket: string; prefix: string; prefixes: readonly string[]; loading: boolean; folder: GcsFolderKind; hasParquet: boolean; error: string; path: string[] }
  | { step: 'profile'; profiles: string[]; loading: boolean; selected: string }
  | { step: 'bucket'; profile: string; source: DataSource; buckets: { name: string; region: string }[]; loading: boolean; selected: string; error: string }
  | { step: 'beacon'; profile: string; source: DataSource; bucket: string; content: string; summary: ConfigBundleSummary; applying: boolean; error: string }
  | { step: 'browse'; profile: string; source: DataSource; bucket: string; prefix: string; prefixes: string[]; loading: boolean; isBillingExport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'cur-legacy' | 'unknown'; missingColumns: string[]; path: string[] }
  | { step: 'confirm'; cloud: 'aws'; profile: string; s3Path: string; hourlyPath: string; costOptPath: string; retentionDays: number }
  | { step: 'confirm'; cloud: 'gcp'; project: string; s3Path: string; hourlyPath: string; costOptPath: string; retentionDays: number };

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

/** Simple geometric marks rather than the vendors' actual logos: those are
 *  trademarks with their own usage rules, and a recognizable silhouette in the
 *  brand colour is all a picker needs. `currentColor` is deliberately NOT used
 *  — the colour IS the recognition cue, and it must survive the disabled tile's
 *  dimming as a wash rather than turning grey. */
function AwsMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
      <path d="M6 19q-1 3 2 4.5T16 25t8-1.5 2-4.5" fill="none" stroke="#FF9900" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M10 8h3l3 8 3-8h3" fill="none" stroke="#FF9900" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GcpMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
      <path d="M16 6a8 8 0 0 1 7.5 5.2A6 6 0 0 1 23 23H11a7 7 0 0 1-1.6-13.8A8 8 0 0 1 16 6z" fill="none" stroke="#4285F4" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M9.4 9.2A8 8 0 0 1 16 6" fill="none" stroke="#EA4335" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M23.5 11.2A6 6 0 0 1 23 23" fill="none" stroke="#FBBC05" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M11 23h6" fill="none" stroke="#34A853" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function AzureMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
      <path d="M13 5 5 24h6l8-19z" fill="none" stroke="#0078D4" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M19 11 27 24H12l5-4" fill="none" stroke="#0078D4" strokeWidth="2.5" strokeLinejoin="round" />
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

/**
 * Step 2b — GCP: the exporter prerequisite, then into browse-and-pick.
 *
 * The prerequisite is real — there is nothing in the bucket until the user's
 * own exporter has run — but it is an ORDERING constraint, not a reason to
 * hand-edit YAML. Once the exporter has run, a GCS bucket browses exactly like
 * an S3 one, so this states the prerequisite and then offers the same
 * pick-from-a-list flow AWS gets. Hand-editing survives as the escape hatch
 * for anyone whose credentials can't list projects (a bare service-account
 * key, say).
 */
function GcpIntroStep({ state, onBrowse, onScaffold, onDone, onBack }: Readonly<{
  state: { scaffolded: boolean; error: string };
  onBrowse: () => void;
  onScaffold: () => void;
  onDone: () => void;
  onBack: () => void;
}>) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span className="text-2xl font-bold text-accent tracking-wider">Set up from Google Cloud</span>
      <p className="text-text-secondary text-sm max-w-md">
        CostGoblin reads a GCS bucket that your own exporter fills from the FOCUS 1.2 BigQuery
        billing export. It never holds credentials that can reach BigQuery.
      </p>
      <ol className="flex w-full max-w-md flex-col gap-2 text-left text-sm text-text-secondary list-decimal pl-5">
        <li>
          Enable the <span className="text-text-primary">FOCUS usage cost</span> export under
          Billing → Billing export, and deploy the exporter —{' '}
          <a
            href={GCP_EXPORTER_DOCS}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            scripts/gcp-focus-exporter
          </a>{' '}
          has a one-command deploy.
        </li>
        <li>
          Sign in so CostGoblin can read the bucket:{' '}
          <code className="text-text-primary text-xs">gcloud auth application-default login</code>
        </li>
        <li>Pick the exported folder below — CostGoblin writes the config for you.</li>
      </ol>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button onClick={onBrowse} className="bg-accent hover:bg-accent-hover text-white">
          Find my export
        </Button>
        <button
          type="button"
          onClick={onScaffold}
          className="text-xs text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          {state.scaffolded ? 'Open the config folder again' : 'Write the config by hand instead'}
        </button>
        {state.error !== '' && <p className="text-xs text-negative">{state.error}</p>}
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

/** Errors from the project/bucket/browse handlers that a sign-in fixes.
 *  `GCLOUD_CLI_NOT_FOUND` is deliberately excluded — the login button can't
 *  run a CLI that isn't installed, and `GcloudLoginButton` surfaces its own
 *  install prompt for that case. */
function isGcpAuthError(message: string): boolean {
  if (message.length === 0) return false;
  return (
    message.includes('Could not load the default credentials') ||
    message.includes('Could not refresh access token') ||
    message.includes('Unable to detect a Project Id') ||
    message.includes('invalid_grant') ||
    message.includes('Token has been expired or revoked') ||
    message.includes('gcloud auth') ||
    message.includes('do not currently have an active account') ||
    message.includes('Reauthentication failed')
  );
}

/** Error panel shared by the three GCP steps. `GCLOUD_CLI_NOT_FOUND` is a
 *  sentinel the handlers return rather than a message worth showing. */
function GcpError({ message, mode }: Readonly<{ message: string; mode: 'adc' | 'cli' }>) {
  if (message.length === 0) return null;
  const missingCli = message.includes('GCLOUD_CLI_NOT_FOUND');
  return (
    <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3">
      <p className="text-sm text-negative whitespace-pre-wrap">
        {missingCli
          ? 'The Google Cloud CLI (gcloud) is not installed — CostGoblin needs it to list your projects and download the export.'
          : message}
      </p>
      {(missingCli || isGcpAuthError(message)) && <GcloudLoginButton mode={mode} />}
    </div>
  );
}

/** Step 2b-i — which project's buckets to list.
 *
 *  Has no AWS counterpart: S3's ListBuckets is account-wide and takes no
 *  arguments, while `storage.getBuckets()` is project-scoped. */
function GcpProjectStep({ state, onSelect, onManual, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-project' }>;
  onSelect: (projectId: string) => void;
  onManual: () => void;
  onBack: () => void;
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

      <GcpError message={state.error} mode="cli" />

      {state.loading && (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading projects...</span>
        </div>
      )}
      {!state.loading && state.projects.length === 0 && state.error === '' && (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-4 py-6 text-center">
          <p className="text-sm text-text-secondary">No Google Cloud projects found</p>
          <p className="text-xs text-text-muted mt-1">The signed-in account can&apos;t see any active projects.</p>
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
function GcpBucketStep({ state, onSelect, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-bucket' }>;
  onSelect: (bucket: string) => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}>) {
  const [filter, setFilter] = useState('');
  const filtered = state.buckets.filter(b => filter.length === 0 || b.name.toLowerCase().includes(filter.toLowerCase()));
  const sourceLabel = SOURCE_LABELS[state.source];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">{sourceLabel.description}</p>
        <p className="text-xs text-text-muted mt-0.5">
          Select the Cloud Storage bucket in <code className="text-text-secondary">{state.project}</code>
        </p>
      </div>

      <GcpError message={state.error} mode="adc" />

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
            {filtered.length === 0 && (
              <p className="text-sm text-text-muted text-center py-4">No buckets found</p>
            )}
          </div>
        </>
      )}

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
function GcpBrowseStep({ state, conflictsWith, onNavigate, onConfirm, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'gcp-browse' }>;
  /** A tier location already collected in this run that this one must not
   *  overlap — the daily path, while browsing for hourly. */
  conflictsWith?: string | undefined;
  onNavigate: (prefix: string) => void;
  onConfirm: () => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}>) {
  const sourceLabel = SOURCE_LABELS[state.source];
  const isExport = state.folder.kind === 'export';
  // `validateGcpSync` rejects overlapping tiers at load time, so allowing the
  // selection here would write a config the app then refuses to start on.
  const overlaps = conflictsWith !== undefined
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
          <span key={seg} className="flex items-center gap-1">
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

      <GcpError message={state.error} mode="adc" />

      {state.folder.kind === 'tier-parent' && (
        <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
          <p className="text-sm font-medium text-warning">This is the parent folder — go one level deeper</p>
          <p className="text-xs text-warning mt-0.5">
            It holds {state.folder.tiers.map(t => `${t}/`).join(' and ')}. Pointing a provider here would make the{' '}
            {state.source} tier read every tier&apos;s files. Open{' '}
            <code className="text-text-primary">{state.source}/</code> to select it.
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
          {state.prefixes.length === 0 && (
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
            disabled={!selectable}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            {selectable ? 'Use this location' : 'Select an export folder'}
          </Button>
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
          <p className="text-sm text-negative">{state.error}</p>
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

function BucketStep({ state, onSelect, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'bucket' }>;
  onSelect: (bucket: string) => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
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

      {state.error.length > 0 && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3">
          <p className="text-sm text-negative">{state.error}</p>
          {state.error.includes('aws sso login') && (
            <SsoLoginButton profile={state.profile} />
          )}
        </div>
      )}

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

function BrowseStep({ state, onNavigate, onConfirm, onSkip, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'browse' }>;
  onNavigate: (prefix: string) => void;
  onConfirm: () => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}>) {
  const sourceLabel = SOURCE_LABELS[state.source];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{sourceLabel.title}</h2>
        <p className="text-sm text-text-secondary mt-1">Navigate to the folder containing <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code></p>
        <p className="text-xs text-text-muted mt-0.5">{sourceLabel.description}</p>
      </div>

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
          <span key={seg} className="flex items-center gap-1">
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
          {state.prefixes.length === 0 && (
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
            {state.detectedType === 'cur-legacy' ? 'CUR 2.0 not supported' : state.isBillingExport ? 'Use this location' : 'Select an export folder'}
          </Button>
        </div>
      </div>
    </div>
  );
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

function ConfirmStep({ state, providerNaming, onRetentionChange, onComplete, onBack }: Readonly<{
  state: Extract<WizardStep, { step: 'confirm' }>;
  providerNaming: ProviderNaming;
  onRetentionChange: (days: number) => void;
  onComplete: () => void;
  onBack: () => void;
}>) {
  const [saving, setSaving] = useState(false);
  const api = useCostApi();

  const nameError = providerNaming.fixed
    ? null
    : providerNameError(providerNaming.value, providerNaming.checkTaken, providerNaming.takenNames);

  const isDaily = state.s3Path.length > 0;
  const isHourlyOnly = !isDaily && state.hourlyPath.length > 0;

  // The credential card names whichever store this provider authenticates
  // through. Hardcoding "AWS Profile" here was fine while the wizard only
  // built AWS providers; a GCP run has no profile at all.
  const credential = state.cloud === 'gcp'
    ? { label: 'Google Cloud project', value: state.project }
    : { label: 'AWS Profile', value: state.profile };

  const retentionOptions = isHourlyOnly
    ? [
        { days: 7, label: '7 days' },
        { days: 14, label: '14 days' },
        { days: 30, label: '30 days' },
        { days: 90, label: '90 days' },
      ]
    : [
        { days: 90, label: '3 months' },
        { days: 180, label: '6 months' },
        { days: 365, label: '12 months' },
        { days: 730, label: '2 years' },
      ];

  function handleSave() {
    if (nameError !== null) return;
    setSaving(true);
    api.writeConfig({
      providerName: providerNaming.value,
      type: state.cloud,
      // GCP authenticates through Application Default Credentials, which the
      // config expresses by omitting a credential field entirely. The empty
      // string keeps the payload's shape while the gcp arm of
      // `upsertWizardProvider` ignores it.
      profile: state.cloud === 'gcp' ? '' : state.profile,
      dailyBucket: state.s3Path,
      retentionDays: isDaily ? state.retentionDays : undefined,
      ...(state.hourlyPath.length > 0 ? { hourlyBucket: state.hourlyPath } : {}),
      // GCP has no Cost Optimization Hub analogue and `validateGcpSync`
      // rejects the key, so it is never collected — but never sent, either.
      ...(state.cloud !== 'gcp' && state.costOptPath.length > 0 ? { costOptBucket: state.costOptPath } : {}),
    }).then(() => {
      onComplete();
    }).catch(() => { setSaving(false); });
  }

  const paths: { label: string; value: string }[] = [];
  if (state.s3Path.length > 0) paths.push({ label: 'Daily FOCUS export', value: state.s3Path });
  if (state.hourlyPath.length > 0) paths.push({ label: 'Hourly FOCUS export', value: state.hourlyPath });
  if (state.costOptPath.length > 0) paths.push({ label: 'Cost Optimization', value: state.costOptPath });

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
                placeholder="e.g. aws-main"
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

        <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <p className="text-xs text-text-muted uppercase tracking-wider">{credential.label}</p>
          <p className="text-sm font-mono text-text-primary mt-0.5">{credential.value}</p>
        </div>

        {paths.map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
            <p className="text-xs text-text-muted uppercase tracking-wider">{label}</p>
            <p className="text-sm font-mono text-text-primary mt-0.5">{value}</p>
          </div>
        ))}

        <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <p className="text-xs text-text-muted uppercase tracking-wider mb-2">Data Retention</p>
          <div className="flex gap-2">
            {retentionOptions.map(opt => (
              <button
                key={opt.days}
                type="button"
                onClick={() => { onRetentionChange(opt.days); }}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  state.retentionDays === opt.days
                    ? 'bg-accent text-bg-primary'
                    : 'bg-bg-tertiary/50 text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted mt-1.5">How far back to download billing data</p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} className="text-sm text-text-muted hover:text-text-secondary">← Back</button>
        <Button
          onClick={handleSave}
          disabled={saving || nameError !== null}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          {saving ? 'Saving...' : 'Complete Setup'}
        </Button>
      </div>
    </div>
  );
}

export function SetupWizard({ onComplete, source: initialSource, profile: initialProfile, providerName: initialProviderName, mode, workspaceNaming, workspaceLabel, otherWorkspaces }: Readonly<SetupWizardProps>): React.JSX.Element {
  const api = useCostApi();
  const isSourceMode = initialSource !== undefined && initialProfile !== undefined;
  const [workspaceName, setWorkspaceName] = useState(workspaceNaming?.initialName ?? '');
  // Provider identity: fixed when reconfiguring an existing provider (source
  // mode), free-text when adding one, prefilled 'aws-main' on first run.
  const [providerName, setProviderName] = useState(initialProviderName ?? (mode === 'add' ? '' : 'aws-main'));
  const [existingProviders, setExistingProviders] = useState<readonly string[]>([]);
  useEffect(() => {
    api.getConfig().then(config => {
      const names = config.providers.map(p => String(p.name));
      setExistingProviders(names);
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
  const [wizard, setWizard] = useState<WizardStep>(() => {
    if (isSourceMode) {
      return { step: 'bucket', profile: initialProfile, source: initialSource, buckets: [], loading: true, selected: '', error: '' };
    }
    // Naming comes first on a true first run; otherwise (workspace already
    // named, e.g. created via Settings → New workspace) start at the hub.
    return workspaceNaming !== undefined ? { step: 'welcome' } : { step: 'start' };
  });
  const [collectedPaths, setCollectedPaths] = useState({ daily: '', hourly: '', costOpt: '' });
  const [bucketsLoaded, setBucketsLoaded] = useState(false);
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
    api.scaffoldConfig('gcp').then(() => {
      setWizard({ step: 'gcp', scaffolded: true, error: '' });
    }).catch((err: unknown) => {
      setWizard({ step: 'gcp', scaffolded: false, error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Enter the GCP browse flow. Retargets the default provider name to the
   *  GCP arm, but only while it is still the untouched AWS default — a name
   *  the user typed, or one fixed by source/add mode, is never rewritten. */
  function goToGcpProjectStep(): void {
    if (!providerNameFixed && mode !== 'add' && providerName === 'aws-main') {
      setProviderName('gcp-main');
    }
    setWizard({ step: 'gcp-project', projects: [], loading: true, selected: '', error: '' });
    api.listGcpProjects().then(result => {
      setWizard({ step: 'gcp-project', projects: result.projects, loading: false, selected: '', error: result.error ?? '' });
    }).catch((err: unknown) => {
      setWizard({ step: 'gcp-project', projects: [], loading: false, selected: '', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function startGcpBucketStep(project: string, source: GcpSource): void {
    setWizard({ step: 'gcp-bucket', project, source, buckets: [], loading: true, selected: '', error: '' });
    api.listGcsBuckets(project).then(result => {
      setWizard({ step: 'gcp-bucket', project, source, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    }).catch((err: unknown) => {
      setWizard({ step: 'gcp-bucket', project, source, buckets: [], loading: false, selected: '', error: err instanceof Error ? err.message : String(err) });
    });
  }

  function gcpBrowseTo(project: string, source: GcpSource, bucket: string, prefix: string): void {
    const path = prefix.split('/').filter(s => s.length > 0);
    setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: [], loading: true, folder: { kind: 'unknown' }, hasParquet: false, error: '', path });
    api.browseGcs({ projectId: project, bucket, prefix }).then(result => {
      setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: result.prefixes, loading: false, folder: result.folder, hasParquet: result.hasParquet, error: result.error ?? '', path });
    }).catch((err: unknown) => {
      setWizard({ step: 'gcp-browse', project, source, bucket, prefix, prefixes: [], loading: false, folder: { kind: 'unknown' }, hasParquet: false, error: err instanceof Error ? err.message : String(err), path });
    });
  }

  function handleGcpBrowseConfirm(): void {
    if (wizard.step !== 'gcp-browse') return;
    const { project, source, bucket, prefix } = wizard;
    const gcsPath = `gs://${bucket}/${prefix}`;
    const updated = { ...collectedPaths };

    if (source === 'daily') {
      updated.daily = gcsPath;
      setCollectedPaths(updated);
      // Offer the hourly tier next, exactly as the AWS chain does. Skipping
      // it lands on Confirm — the exporter publishes hourly only when it was
      // deployed with TIERS=daily,hourly.
      startGcpBucketStep(project, 'hourly');
      return;
    }

    updated.hourly = gcsPath;
    setCollectedPaths(updated);
    goToGcpConfirm(project, updated, 365);
  }

  /** Leave the GCP browse chain for the Confirm screen, keeping whatever
   *  tiers were collected so far. */
  function handleGcpSkip(): void {
    if (wizard.step !== 'gcp-browse' && wizard.step !== 'gcp-bucket') return;
    goToGcpConfirm(wizard.project);
  }

  function goToGcpConfirm(project: string, paths?: { daily: string; hourly: string; costOpt: string }, retention?: number): void {
    const p = paths ?? collectedPaths;
    setWizard({
      step: 'confirm',
      cloud: 'gcp',
      project,
      s3Path: p.daily,
      hourlyPath: p.hourly,
      // GCP never collects a cost-optimization path; carrying one here would
      // put a key in the config that `validateGcpSync` refuses to load.
      costOptPath: '',
      retentionDays: retention ?? 365,
    });
  }

  useEffect(() => {
    if (isSourceMode && !bucketsLoaded) {
      setBucketsLoaded(true);
      api.listS3Buckets(initialProfile).then(result => {
        setWizard({ step: 'bucket', profile: initialProfile, source: initialSource, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
      }).catch(() => undefined);
    }
  }, [isSourceMode, bucketsLoaded, api, initialProfile, initialSource]);

  function goToProfileStep() {
    setWizard({ step: 'profile', profiles: [], loading: true, selected: '' });
    api.listAwsProfiles().then(profiles => {
      setWizard({ step: 'profile', profiles, loading: false, selected: '' });
    }).catch(() => undefined);
  }

  function handleWelcomeNext() {
    setWizard({ step: 'start' });
  }

  function handleReturnToStart() {
    setCollectedPaths({ daily: '', hourly: '', costOpt: '' });
    setWizard({ step: 'start' });
  }

  function handleProfileSelect(profile: string) {
    startBucketStep(profile, 'daily');
  }

  function startBucketStep(profile: string, source: DataSource) {
    setWizard({ step: 'bucket', profile, source, buckets: [], loading: true, selected: '', error: '' });
    api.listS3Buckets(profile).then(result => {
      setWizard({ step: 'bucket', profile, source, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    }).catch(() => undefined);
  }

  function handleBucketSelect(bucket: string) {
    if (wizard.step !== 'bucket') return;
    const { profile, source } = wizard;
    // On the first pass of initial setup, look for a team configuration
    // published at the bucket's beacon key before walking prefixes by hand.
    // Skipped in source mode (adding hourly/cost-opt to an existing setup).
    if (source === 'daily' && !isSourceMode) {
      setWizard({ ...wizard, selected: bucket, loading: true });
      api.checkConfigBeacon({ profile, bucket }).then(result => {
        if (result.status === 'found') {
          setWizard({ step: 'beacon', profile, source, bucket, content: result.content, summary: result.summary, applying: false, error: '' });
        } else {
          browseTo(profile, source, bucket, '');
        }
      }).catch(() => { browseTo(profile, source, bucket, ''); });
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
    setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: [], loading: true, isBillingExport: false, detectedType: 'unknown', missingColumns: [], path });
    api.browseS3({ profile, bucket, prefix }).then(result => {
      setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: result.prefixes, loading: false, isBillingExport: result.isBillingExport, detectedType: result.detectedType, missingColumns: result.missingColumns, path });
    }).catch(() => undefined);
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
    let defaultRetention: number;
    if (source === 'daily') {
      updated.daily = s3Path;
      defaultRetention = 365;
    } else if (source === 'hourly') {
      updated.hourly = s3Path;
      defaultRetention = 30;
    } else {
      updated.costOpt = s3Path;
      defaultRetention = 90;
    }
    setCollectedPaths(updated);
    goToConfirm(profile, updated, defaultRetention);
  }

  function handleBrowseSkip() {
    if (wizard.step !== 'browse' && wizard.step !== 'bucket') return;
    const profile = wizard.profile;
    const source = wizard.source;

    if (source === 'hourly') {
      startBucketStep(profile, 'costOptimization');
    } else {
      goToConfirm(profile);
    }
  }

  function goToConfirm(profile: string, paths?: { daily: string; hourly: string; costOpt: string }, retention?: number) {
    const p = paths ?? collectedPaths;
    setWizard({
      step: 'confirm',
      cloud: 'aws',
      profile,
      s3Path: p.daily,
      hourlyPath: p.hourly,
      costOptPath: p.costOpt,
      retentionDays: retention ?? 365,
    });
  }

  function handleBack() {
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
        goToGcpProjectStep();
      } else {
        startGcpBucketStep(wizard.project, 'daily');
      }
    } else if (wizard.step === 'gcp-browse') {
      startGcpBucketStep(wizard.project, wizard.source);
    } else if (wizard.step === 'confirm') {
      if (wizard.cloud === 'gcp') {
        startGcpBucketStep(wizard.project, 'hourly');
      } else {
        startBucketStep(wizard.profile, 'costOptimization');
      }
    }
  }

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
              onGcp={() => { setWizard({ step: 'gcp', scaffolded: false, error: '' }); }}
              onImport={() => { setImportOpen(true); }}
              onBack={workspaceNaming !== undefined ? () => { setWizard({ step: 'welcome' }); } : undefined}
              jumpBack={jumpBack}
            />
          )}
          {wizard.step === 'gcp' && (
            <GcpIntroStep
              state={wizard}
              onBrowse={goToGcpProjectStep}
              onScaffold={handleGcpScaffold}
              onDone={finish}
              onBack={() => { setWizard({ step: 'start' }); }}
            />
          )}
          {wizard.step === 'gcp-project' && (
            <GcpProjectStep
              state={wizard}
              onSelect={(projectId) => { startGcpBucketStep(projectId, 'daily'); }}
              onManual={() => { setWizard({ step: 'gcp', scaffolded: false, error: '' }); }}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'gcp-bucket' && (
            <GcpBucketStep
              state={wizard}
              onSelect={(bucket) => { gcpBrowseTo(wizard.project, wizard.source, bucket, ''); }}
              onSkip={wizard.source === 'daily' ? undefined : handleGcpSkip}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'gcp-browse' && (
            <GcpBrowseStep
              state={wizard}
              conflictsWith={wizard.source === 'hourly' ? collectedPaths.daily : undefined}
              onNavigate={(prefix) => { gcpBrowseTo(wizard.project, wizard.source, wizard.bucket, prefix); }}
              onConfirm={handleGcpBrowseConfirm}
              onSkip={wizard.source === 'daily' ? undefined : handleGcpSkip}
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
            />
          )}
          {wizard.step === 'browse' && (
            <BrowseStep
              state={wizard}
              onNavigate={handleNavigate}
              onConfirm={handleBrowseConfirm}
              onSkip={wizard.source === 'daily' ? undefined : handleBrowseSkip}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'confirm' && (
            <ConfirmStep
              state={wizard}
              providerNaming={{
                value: providerName,
                fixed: providerNameFixed,
                checkTaken: mode === 'add',
                takenNames: existingProviders,
                onChange: setProviderName,
              }}
              onRetentionChange={(days) => { setWizard(prev => prev.step === 'confirm' ? { ...prev, retentionDays: days } : prev); }}
              onComplete={finish}
              onBack={handleBack}
            />
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
