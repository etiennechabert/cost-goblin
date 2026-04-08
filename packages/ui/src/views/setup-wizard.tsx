import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';

type DataSource = 'daily' | 'hourly' | 'costOptimization';

const SOURCE_LABELS: Record<DataSource, { title: string; description: string }> = {
  daily: { title: 'Daily CUR', description: 'Main billing data — required' },
  hourly: { title: 'Hourly CUR', description: 'For short-term drill-down and incident analysis' },
  costOptimization: { title: 'Cost Optimization', description: 'RI/SP recommendations and rightsizing suggestions' },
};

type WizardStep =
  | { step: 'welcome' }
  | { step: 'profile'; profiles: string[]; loading: boolean; selected: string }
  | { step: 'bucket'; profile: string; source: DataSource; buckets: { name: string; region: string }[]; loading: boolean; selected: string; error: string }
  | { step: 'browse'; profile: string; source: DataSource; bucket: string; prefix: string; prefixes: string[]; loading: boolean; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[]; path: string[] }
  | { step: 'confirm'; profile: string; s3Path: string; hourlyPath: string; costOptPath: string; retentionDays: number };

interface SetupWizardProps {
  onComplete: () => void;
  source?: DataSource | undefined;
  profile?: string | undefined;
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="text-4xl font-bold text-accent tracking-wider">CostGoblin</span>
        <p className="text-text-secondary text-lg">Cloud cost visibility for your team</p>
      </div>
      <p className="text-text-muted text-sm max-w-md">
        Connect your AWS billing data to get started. CostGoblin syncs CUR (Cost and Usage Report) data from S3, stores it locally, and lets you slice costs by any dimension.
      </p>
      <Button
        onClick={onNext}
        className="bg-accent hover:bg-accent-hover text-white px-8"
      >
        Get Started
      </Button>
      <p className="text-text-muted text-xs">
        {"Don't have a CUR yet? "}
        <a
          href="https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          Learn how to create a CUR v2 report
        </a>
      </p>
    </div>
  );
}

function ProfileStep({ state, onSelect, onSkip, onBack }: {
  state: Extract<WizardStep, { step: 'profile' }>;
  onSelect: (profile: string) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">AWS Profile</h2>
        <p className="text-sm text-text-secondary mt-1">Select the AWS profile to use for accessing your billing data</p>
        <p className="text-xs text-text-muted mt-1">
          Profiles are read from <code className="text-text-secondary">~/.aws/credentials</code> and <code className="text-text-secondary">~/.aws/config</code>
        </p>
      </div>

      {state.loading ? (
        <div className="flex items-center justify-center py-8">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
          <span className="ml-2 text-sm text-text-secondary">Loading profiles...</span>
        </div>
      ) : state.profiles.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-4 py-6 text-center">
          <p className="text-sm text-text-secondary">No AWS profiles found</p>
          <p className="text-xs text-text-muted mt-1">
            Configure credentials in <code className="text-text-secondary">~/.aws/config</code> or <code className="text-text-secondary">~/.aws/credentials</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {state.profiles.map(profile => (
            <button
              key={profile}
              type="button"
              onClick={() => { onSelect(profile); }}
              className={[
                'flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
                state.selected === profile
                  ? 'border-accent bg-accent-muted text-accent'
                  : 'border-border bg-bg-tertiary/20 text-text-primary hover:border-border hover:bg-bg-tertiary/40',
              ].join(' ')}
            >
              <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">{profile}</span>
            </button>
          ))}
        </div>
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

function BucketStep({ state, onSelect, onSkip, onBack }: {
  state: Extract<WizardStep, { step: 'bucket' }>;
  onSelect: (bucket: string) => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}) {
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
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {state.error}
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

function BrowseStep({ state, onNavigate, onConfirm, onSkip, onBack }: {
  state: Extract<WizardStep, { step: 'browse' }>;
  onNavigate: (prefix: string) => void;
  onConfirm: () => void;
  onSkip?: (() => void) | undefined;
  onBack: () => void;
}) {
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

      {state.isCurReport && (() => {
        const detected = state.detectedType;
        const isCostOptMismatch = detected === 'cost-optimization' && state.source !== 'costOptimization';
        const isCurForCostOpt = detected !== 'cost-optimization' && detected !== 'unknown' && state.source === 'costOptimization';

        if (isCostOptMismatch || isCurForCostOpt) {
          return (
            <div className="rounded-lg border border-warning/50 bg-warning-muted px-4 py-3">
              <p className="text-sm font-medium text-warning">Data type mismatch</p>
              <p className="text-xs text-warning mt-0.5">
                {isCostOptMismatch
                  ? 'This looks like a Cost Optimization report, not a CUR.'
                  : 'This looks like a CUR report, not a Cost Optimization export.'}
                {' '}Continue anyway?
              </p>
            </div>
          );
        }

        return (
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
            <p className="text-sm font-medium text-accent">
              {detected === 'cost-optimization' ? 'Cost Optimization report detected' : 'CUR report detected'}
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              Found <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code> folders
            </p>
          </div>
        );
      })()}

      {state.isCurReport && state.missingColumns.length > 0 && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">Missing required columns</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {state.missingColumns.join(', ')}
          </p>
          <p className="text-xs text-text-muted mt-1">
            CostGoblin needs these columns. Check your CUR report configuration in the AWS Console.
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
            disabled={!state.isCurReport}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            {state.isCurReport ? 'Use this location' : 'Select a CUR folder'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmStep({ state, onRetentionChange, onComplete, onBack }: {
  state: Extract<WizardStep, { step: 'confirm' }>;
  onRetentionChange: (days: number) => void;
  onComplete: () => void;
  onBack: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const api = useCostApi();

  const isDaily = state.s3Path.length > 0;
  const isHourlyOnly = !isDaily && state.hourlyPath.length > 0;

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
    setSaving(true);
    void api.writeConfig({
      providerName: 'aws-main',
      profile: state.profile,
      dailyBucket: state.s3Path,
      retentionDays: isDaily ? state.retentionDays : undefined,
      ...(state.hourlyPath.length > 0 ? { hourlyBucket: state.hourlyPath } : {}),
      ...(state.costOptPath.length > 0 ? { costOptBucket: state.costOptPath } : {}),
    }).then(() => {
      onComplete();
    });
  }

  const paths: { label: string; value: string }[] = [];
  if (state.s3Path.length > 0) paths.push({ label: 'Daily CUR', value: state.s3Path });
  if (state.hourlyPath.length > 0) paths.push({ label: 'Hourly CUR', value: state.hourlyPath });
  if (state.costOptPath.length > 0) paths.push({ label: 'Cost Optimization', value: state.costOptPath });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Confirm Setup</h2>
        <p className="text-sm text-text-secondary mt-1">Review your configuration</p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <p className="text-xs text-text-muted uppercase tracking-wider">AWS Profile</p>
          <p className="text-sm font-mono text-text-primary mt-0.5">{state.profile}</p>
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
          disabled={saving}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          {saving ? 'Saving...' : 'Complete Setup'}
        </Button>
      </div>
    </div>
  );
}

export function SetupWizard({ onComplete, source: initialSource, profile: initialProfile }: SetupWizardProps): React.JSX.Element {
  const api = useCostApi();
  const isSourceMode = initialSource !== undefined && initialProfile !== undefined;
  const [wizard, setWizard] = useState<WizardStep>(
    isSourceMode
      ? { step: 'bucket', profile: initialProfile, source: initialSource, buckets: [], loading: true, selected: '', error: '' }
      : { step: 'welcome' },
  );
  const [collectedPaths, setCollectedPaths] = useState({ daily: '', hourly: '', costOpt: '' });
  const [bucketsLoaded, setBucketsLoaded] = useState(false);

  if (isSourceMode && !bucketsLoaded) {
    setBucketsLoaded(true);
    void api.listS3Buckets(initialProfile).then(result => {
      setWizard({ step: 'bucket', profile: initialProfile, source: initialSource, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    });
  }

  function handleWelcomeNext() {
    setWizard({ step: 'profile', profiles: [], loading: true, selected: '' });
    void api.listAwsProfiles().then(profiles => {
      setWizard({ step: 'profile', profiles, loading: false, selected: '' });
    });
  }

  function handleProfileSelect(profile: string) {
    startBucketStep(profile, 'daily');
  }

  function startBucketStep(profile: string, source: DataSource) {
    setWizard({ step: 'bucket', profile, source, buckets: [], loading: true, selected: '', error: '' });
    void api.listS3Buckets(profile).then(result => {
      setWizard({ step: 'bucket', profile, source, buckets: result.buckets, loading: false, selected: '', error: result.error ?? '' });
    });
  }

  function handleBucketSelect(bucket: string) {
    if (wizard.step !== 'bucket') return;
    browseTo(wizard.profile, wizard.source, bucket, '');
  }

  function browseTo(profile: string, source: DataSource, bucket: string, prefix: string) {
    const path = prefix.split('/').filter(s => s.length > 0);
    setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: [], loading: true, isCurReport: false, detectedType: 'unknown', missingColumns: [], path });
    void api.browseS3({ profile, bucket, prefix }).then(result => {
      setWizard({ step: 'browse', profile, source, bucket, prefix, prefixes: result.prefixes, loading: false, isCurReport: result.isCurReport, detectedType: result.detectedType, missingColumns: result.missingColumns, path });
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
    let defaultRetention = 365;
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
    const source = wizard.step === 'browse' ? wizard.source : wizard.source;

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
      profile,
      s3Path: p.daily,
      hourlyPath: p.hourly,
      costOptPath: p.costOpt,
      retentionDays: retention ?? 365,
    });
  }

  function handleBack() {
    if (wizard.step === 'profile') {
      setWizard({ step: 'welcome' });
    } else if (wizard.step === 'bucket') {
      if (wizard.source === 'daily') {
        handleWelcomeNext();
      } else if (wizard.source === 'hourly') {
        startBucketStep(wizard.profile, 'daily');
      } else {
        startBucketStep(wizard.profile, 'hourly');
      }
    } else if (wizard.step === 'browse') {
      startBucketStep(wizard.profile, wizard.source);
    } else if (wizard.step === 'confirm') {
      startBucketStep(wizard.profile, 'costOptimization');
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border bg-bg-secondary">
        <CardContent className="p-8">
          <div className="flex justify-center mb-6">
            <img src="goblin.png" alt="CostGoblin" className="h-16 w-auto" />
          </div>
          {wizard.step === 'welcome' && <WelcomeStep onNext={handleWelcomeNext} />}
          {wizard.step === 'profile' && <ProfileStep state={wizard} onSelect={handleProfileSelect} onSkip={onComplete} onBack={handleBack} />}
          {wizard.step === 'bucket' && (
            <BucketStep
              state={wizard}
              onSelect={handleBucketSelect}
              onSkip={wizard.source !== 'daily' ? handleBrowseSkip : undefined}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'browse' && (
            <BrowseStep
              state={wizard}
              onNavigate={handleNavigate}
              onConfirm={handleBrowseConfirm}
              onSkip={wizard.source !== 'daily' ? handleBrowseSkip : undefined}
              onBack={handleBack}
            />
          )}
          {wizard.step === 'confirm' && (
            <ConfirmStep
              state={wizard}
              onRetentionChange={(days) => { setWizard(prev => prev.step === 'confirm' ? { ...prev, retentionDays: days } : prev); }}
              onComplete={onComplete}
              onBack={handleBack}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
