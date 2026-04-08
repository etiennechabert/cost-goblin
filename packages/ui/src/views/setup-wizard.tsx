import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';

type WizardStep =
  | { step: 'welcome' }
  | { step: 'profile'; profiles: string[]; loading: boolean; selected: string }
  | { step: 'bucket'; profile: string; buckets: { name: string; region: string }[]; loading: boolean; selected: string }
  | { step: 'browse'; profile: string; bucket: string; prefix: string; prefixes: string[]; loading: boolean; isCurReport: boolean; path: string[] }
  | { step: 'confirm'; profile: string; s3Path: string };

interface SetupWizardProps {
  onComplete: () => void;
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

function ProfileStep({ state, onSelect, onBack }: {
  state: Extract<WizardStep, { step: 'profile' }>;
  onSelect: (profile: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">AWS Profile</h2>
        <p className="text-sm text-text-secondary mt-1">Select the AWS profile to use for accessing your billing data</p>
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
    </div>
  );
}

function BucketStep({ state, onSelect, onBack }: {
  state: Extract<WizardStep, { step: 'bucket' }>;
  onSelect: (bucket: string) => void;
  onBack: () => void;
}) {
  const [filter, setFilter] = useState('');
  const filtered = state.buckets.filter(b => filter.length === 0 || b.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">S3 Bucket</h2>
        <p className="text-sm text-text-secondary mt-1">
          Select the bucket containing your CUR data
          <span className="text-text-muted"> (profile: {state.profile})</span>
        </p>
      </div>

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
        <Button
          onClick={() => { onSelect(state.selected); }}
          disabled={state.selected.length === 0}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function BrowseStep({ state, onNavigate, onConfirm, onBack }: {
  state: Extract<WizardStep, { step: 'browse' }>;
  onNavigate: (prefix: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Locate CUR Report</h2>
        <p className="text-sm text-text-secondary mt-1">Navigate to the folder containing <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code></p>
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

      {state.isCurReport && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
          <p className="text-sm font-medium text-accent">CUR report detected</p>
          <p className="text-xs text-text-secondary mt-0.5">
            Found <code className="text-text-primary">data/</code> and <code className="text-text-primary">metadata/</code> folders at this location
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
        <Button
          onClick={onConfirm}
          disabled={!state.isCurReport}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          {state.isCurReport ? 'Use this location' : 'Select a CUR folder'}
        </Button>
      </div>
    </div>
  );
}

function ConfirmStep({ state, onComplete, onBack }: {
  state: Extract<WizardStep, { step: 'confirm' }>;
  onComplete: () => void;
  onBack: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const api = useCostApi();

  function handleSave() {
    setSaving(true);
    void api.writeConfig({
      providerName: 'aws-main',
      profile: state.profile,
      dailyBucket: state.s3Path,
    }).then(() => {
      onComplete();
    });
  }

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
        <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3">
          <p className="text-xs text-text-muted uppercase tracking-wider">CUR Location</p>
          <p className="text-sm font-mono text-text-primary mt-0.5">{state.s3Path}</p>
        </div>
      </div>

      <p className="text-xs text-text-muted">
        After setup, go to the <strong className="text-text-secondary">Data</strong> tab to download billing periods.
      </p>

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

export function SetupWizard({ onComplete }: SetupWizardProps): React.JSX.Element {
  const api = useCostApi();
  const [wizard, setWizard] = useState<WizardStep>({ step: 'welcome' });

  function handleWelcomeNext() {
    setWizard({ step: 'profile', profiles: [], loading: true, selected: '' });
    void api.listAwsProfiles().then(profiles => {
      setWizard({ step: 'profile', profiles, loading: false, selected: '' });
    });
  }

  function handleProfileSelect(profile: string) {
    setWizard({ step: 'bucket', profile, buckets: [], loading: true, selected: '' });
    void api.listS3Buckets(profile).then(buckets => {
      setWizard({ step: 'bucket', profile, buckets, loading: false, selected: '' });
    });
  }

  function handleBucketSelect(bucket: string) {
    browseTo(wizard.step === 'bucket' ? wizard.profile : '', bucket, '');
  }

  function browseTo(profile: string, bucket: string, prefix: string) {
    const path = prefix.split('/').filter(s => s.length > 0);
    setWizard({ step: 'browse', profile, bucket, prefix, prefixes: [], loading: true, isCurReport: false, path });
    void api.browseS3({ profile, bucket, prefix }).then(result => {
      setWizard({ step: 'browse', profile, bucket, prefix, prefixes: result.prefixes, loading: false, isCurReport: result.isCurReport, path });
    });
  }

  function handleNavigate(prefix: string) {
    if (wizard.step !== 'browse') return;
    browseTo(wizard.profile, wizard.bucket, prefix);
  }

  function handleBrowseConfirm() {
    if (wizard.step !== 'browse') return;
    const s3Path = `s3://${wizard.bucket}/${wizard.prefix}`;
    setWizard({ step: 'confirm', profile: wizard.profile, s3Path });
  }

  function handleBack() {
    if (wizard.step === 'profile') {
      setWizard({ step: 'welcome' });
    } else if (wizard.step === 'bucket') {
      handleWelcomeNext();
    } else if (wizard.step === 'browse') {
      handleProfileSelect(wizard.profile);
    } else if (wizard.step === 'confirm') {
      const profile = wizard.profile;
      const parsed = wizard.s3Path.replace(/^s3:\/\//, '');
      const slashIdx = parsed.indexOf('/');
      const bucket = slashIdx > 0 ? parsed.slice(0, slashIdx) : parsed;
      const prefix = slashIdx > 0 ? parsed.slice(slashIdx + 1) : '';
      browseTo(profile, bucket, prefix);
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border bg-bg-secondary">
        <CardContent className="p-8">
          {wizard.step === 'welcome' && <WelcomeStep onNext={handleWelcomeNext} />}
          {wizard.step === 'profile' && <ProfileStep state={wizard} onSelect={handleProfileSelect} onBack={handleBack} />}
          {wizard.step === 'bucket' && <BucketStep state={wizard} onSelect={handleBucketSelect} onBack={handleBack} />}
          {wizard.step === 'browse' && <BrowseStep state={wizard} onNavigate={handleNavigate} onConfirm={handleBrowseConfirm} onBack={handleBack} />}
          {wizard.step === 'confirm' && <ConfirmStep state={wizard} onComplete={onComplete} onBack={handleBack} />}
        </CardContent>
      </Card>
    </div>
  );
}
