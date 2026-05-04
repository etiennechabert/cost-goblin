import { useState, useCallback } from 'react';

interface VaultSetupScreenProps {
  readonly onComplete: () => void;
}

export function VaultSetupScreen({ onComplete }: VaultSetupScreenProps): React.JSX.Element {
  const [wantEncryption, setWantEncryption] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (password.length < 4) {
      setError('Password must be at least 4 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSaving(true);
    await globalThis.costgoblinVault.setup(password);
    onComplete();
  }, [password, confirmPassword, onComplete]);

  if (wantEncryption === null) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="flex flex-col items-center gap-2 mb-8">
            <img src="goblin.png" alt="" className="h-14 w-auto object-contain" />
            <h2 className="text-xl font-semibold text-text-primary">Protect your data</h2>
            <p className="text-sm text-text-secondary max-w-sm">
              Your billing data contains sensitive information. Would you like to encrypt it at rest with a password?
            </p>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => { setWantEncryption(true); }}
              className="w-full rounded-lg border border-border bg-bg-secondary p-4 text-left hover:border-accent/50 hover:bg-bg-tertiary/30 transition-colors"
            >
              <span className="text-sm font-medium text-text-primary">Yes, set a password</span>
              <p className="text-xs text-text-muted mt-0.5">Data is encrypted on disk. You&apos;ll enter the password each time you open CostGoblin.</p>
            </button>
            <button
              type="button"
              onClick={onComplete}
              className="w-full rounded-lg border border-border bg-bg-secondary p-4 text-left hover:border-border hover:bg-bg-tertiary/30 transition-colors"
            >
              <span className="text-sm font-medium text-text-primary">No, skip</span>
              <p className="text-xs text-text-muted mt-0.5">Data is stored as plain files. You can enable encryption later in settings.</p>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 mb-8">
          <img src="goblin.png" alt="" className="h-14 w-auto object-contain" />
          <h2 className="text-xl font-semibold text-text-primary">Set your password</h2>
          <p className="text-sm text-text-secondary text-center">
            This password encrypts your billing data. If you forget it, you&apos;ll need to re-sync from S3.
          </p>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              autoFocus
              className="w-full px-3 py-2.5 rounded-md bg-bg-secondary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
              className="w-full px-3 py-2.5 rounded-md bg-bg-secondary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
            />
          </div>

          {error !== null && (
            <p className="text-xs text-negative">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => { setWantEncryption(null); }}
              className="flex-1 py-2.5 rounded-md bg-bg-tertiary text-text-primary font-medium text-sm hover:bg-bg-tertiary/80 transition-colors"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={saving || password.length === 0}
              className="flex-1 py-2.5 rounded-md bg-accent text-white font-medium text-sm hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Encrypting...' : 'Enable encryption'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
