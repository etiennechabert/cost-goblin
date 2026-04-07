import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';
import type { SyncStatus } from '@costgoblin/core/browser';

type WizardStep =
  | { step: 'welcome' }
  | { step: 'config'; profile: string; dailyBucket: string; hourlyBucket: string; connectionStatus: 'idle' | 'testing' | 'success' | 'error'; error: string }
  | { step: 'sync'; syncStatus: 'idle' | 'syncing' | 'done' | 'error' };

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
        Connect your AWS billing data to get started. CostGoblin syncs CUR data from S3, stores it locally, and lets you slice costs by any dimension.
      </p>
      <Button
        onClick={onNext}
        className="bg-accent hover:bg-accent-hover text-white px-8"
      >
        Get Started
      </Button>
    </div>
  );
}

function ConfigStep({ state, onUpdate, onTestConnection, onNext }: {
  state: Extract<WizardStep, { step: 'config' }>;
  onUpdate: (updates: Partial<Extract<WizardStep, { step: 'config' }>>) => void;
  onTestConnection: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">AWS Configuration</h2>
        <p className="text-sm text-text-secondary mt-1">Connect to your CUR data in S3</p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary" htmlFor="setup-profile">
            AWS Profile
          </label>
          <input
            id="setup-profile"
            type="text"
            value={state.profile}
            onChange={(e) => { onUpdate({ profile: e.target.value, connectionStatus: 'idle', error: '' }); }}
            placeholder="default"
            className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary" htmlFor="setup-daily-bucket">
            Daily S3 Bucket Path
          </label>
          <input
            id="setup-daily-bucket"
            type="text"
            value={state.dailyBucket}
            onChange={(e) => { onUpdate({ dailyBucket: e.target.value, connectionStatus: 'idle', error: '' }); }}
            placeholder="s3://my-cur-bucket/daily"
            className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary" htmlFor="setup-hourly-bucket">
            Hourly S3 Bucket Path <span className="text-text-muted">(optional)</span>
          </label>
          <input
            id="setup-hourly-bucket"
            type="text"
            value={state.hourlyBucket}
            onChange={(e) => { onUpdate({ hourlyBucket: e.target.value }); }}
            placeholder="s3://my-cur-bucket/hourly"
            className="h-9 rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={onTestConnection}
          disabled={state.connectionStatus === 'testing' || state.dailyBucket.length === 0}
          variant="outline"
          className="border-border"
        >
          {state.connectionStatus === 'testing' ? 'Testing...' : 'Test Connection'}
        </Button>
        {state.connectionStatus === 'success' && (
          <span className="text-sm text-positive">Connection successful</span>
        )}
        {state.connectionStatus === 'error' && (
          <span className="text-sm text-negative">{state.error}</span>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <Button
          onClick={onNext}
          disabled={state.connectionStatus !== 'success'}
          className="bg-accent hover:bg-accent-hover text-white px-8"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function SyncStep({ state, onStartSync, onSkip, onDone }: {
  state: Extract<WizardStep, { step: 'sync' }>;
  onStartSync: () => void;
  onSkip: () => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Initial Sync</h2>
        <p className="text-sm text-text-secondary mt-1">Download billing data from S3</p>
      </div>

      {state.syncStatus === 'idle' && (
        <div className="flex flex-col items-center gap-4 py-6">
          <p className="text-sm text-text-secondary text-center max-w-md">
            Sync your billing data now, or skip and do it later from the Data tab.
          </p>
          <div className="flex items-center gap-3">
            <Button
              onClick={onStartSync}
              className="bg-accent hover:bg-accent-hover text-white px-8"
            >
              Start Sync
            </Button>
          </div>
          <button
            type="button"
            onClick={onSkip}
            className="text-sm text-text-muted hover:text-text-secondary underline underline-offset-2"
          >
            Skip for now
          </button>
        </div>
      )}

      {state.syncStatus === 'syncing' && (
        <div className="flex flex-col items-center gap-4 py-6">
          <div className="h-1.5 w-full max-w-xs rounded-full bg-bg-tertiary overflow-hidden">
            <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
          <p className="text-sm text-text-secondary">Syncing data...</p>
        </div>
      )}

      {state.syncStatus === 'done' && (
        <div className="flex flex-col items-center gap-4 py-6">
          <span className="text-accent text-lg">Sync complete</span>
          <Button
            onClick={onDone}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            Done
          </Button>
        </div>
      )}

      {state.syncStatus === 'error' && (
        <div className="flex flex-col items-center gap-4 py-6">
          <span className="text-sm text-negative">Sync failed. You can retry later from the Data tab.</span>
          <Button
            onClick={onDone}
            className="bg-accent hover:bg-accent-hover text-white px-8"
          >
            Continue Anyway
          </Button>
        </div>
      )}
    </div>
  );
}

export function SetupWizard({ onComplete }: SetupWizardProps): React.JSX.Element {
  const api = useCostApi();
  const [wizard, setWizard] = useState<WizardStep>({ step: 'welcome' });

  function handleWelcomeNext() {
    setWizard({ step: 'config', profile: 'default', dailyBucket: '', hourlyBucket: '', connectionStatus: 'idle', error: '' });
  }

  function handleConfigUpdate(updates: Partial<Extract<WizardStep, { step: 'config' }>>) {
    setWizard(prev => {
      if (prev.step !== 'config') return prev;
      return { ...prev, ...updates };
    });
  }

  function handleTestConnection() {
    if (wizard.step !== 'config') return;
    const { profile, dailyBucket } = wizard;

    setWizard(prev => {
      if (prev.step !== 'config') return prev;
      return { ...prev, connectionStatus: 'testing', error: '' };
    });

    void api.testConnection({ profile, bucket: dailyBucket }).then(result => {
      setWizard(prev => {
        if (prev.step !== 'config') return prev;
        if (result.ok) {
          return { ...prev, connectionStatus: 'success', error: '' };
        }
        return { ...prev, connectionStatus: 'error', error: result.error ?? 'Connection failed' };
      });
    });
  }

  function handleConfigNext() {
    if (wizard.step !== 'config') return;
    const { profile, dailyBucket, hourlyBucket } = wizard;

    void api.writeConfig({
      providerName: 'aws-main',
      profile,
      dailyBucket,
      ...(hourlyBucket.length > 0 ? { hourlyBucket } : {}),
    }).then(() => {
      setWizard({ step: 'sync', syncStatus: 'idle' });
    });
  }

  function handleStartSync() {
    setWizard({ step: 'sync', syncStatus: 'syncing' });

    void api.triggerSync().then(() => {
      return pollSyncUntilDone();
    });
  }

  function pollSyncUntilDone(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        void api.getSyncStatus().then((status: SyncStatus) => {
          if (status.status === 'completed') {
            setWizard({ step: 'sync', syncStatus: 'done' });
            resolve();
          } else if (status.status === 'failed') {
            setWizard({ step: 'sync', syncStatus: 'error' });
            resolve();
          } else {
            setTimeout(check, 1000);
          }
        });
      };
      setTimeout(check, 1000);
    });
  }

  function handleSkip() {
    onComplete();
  }

  function handleDone() {
    onComplete();
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border bg-bg-secondary">
        <CardContent className="p-8">
          {wizard.step === 'welcome' && <WelcomeStep onNext={handleWelcomeNext} />}
          {wizard.step === 'config' && (
            <ConfigStep
              state={wizard}
              onUpdate={handleConfigUpdate}
              onTestConnection={handleTestConnection}
              onNext={handleConfigNext}
            />
          )}
          {wizard.step === 'sync' && (
            <SyncStep
              state={wizard}
              onStartSync={handleStartSync}
              onSkip={handleSkip}
              onDone={handleDone}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
