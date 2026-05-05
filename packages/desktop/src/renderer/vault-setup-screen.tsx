import { useState, useCallback } from 'react';
import { Lock, LockOpen } from 'lucide-react';

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
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Protect your data</h2>
          <p className="text-sm text-text-secondary mt-1">
            Your billing data is always encrypted at rest. Would you like to add a password for extra protection?
          </p>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            onClick={() => { setWantEncryption(true); }}
            className="w-full rounded-lg border border-border bg-bg-tertiary/20 p-4 text-left hover:border-accent/50 hover:bg-bg-tertiary/40 transition-colors flex items-start gap-3"
          >
            <Lock className="size-5 text-accent mt-0.5 shrink-0" />
            <div>
              <span className="text-sm font-medium text-text-primary">Yes, set a password</span>
              <p className="text-xs text-text-muted mt-0.5">Data is encrypted on disk. You&apos;ll enter the password each time you open CostGoblin.</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => { globalThis.costgoblinVault.setup(null).then(onComplete).catch(() => undefined); }}
            className="w-full rounded-lg border border-border bg-bg-tertiary/20 p-4 text-left hover:border-border hover:bg-bg-tertiary/40 transition-colors flex items-start gap-3"
          >
            <LockOpen className="size-5 text-text-muted mt-0.5 shrink-0" />
            <div>
              <span className="text-sm font-medium text-text-primary">No thanks</span>
              <p className="text-xs text-text-muted mt-0.5">Data is stored unencrypted on disk. You can enable encryption later in settings.</p>
            </div>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Set your password</h2>
        <p className="text-sm text-text-secondary mt-1">
          Pick something simple and easy to remember — no need for special characters. If you forget it, you can always re-sync from S3.
        </p>
      </div>

      <form onSubmit={(e) => { handleSubmit(e).catch(() => undefined); }} className="space-y-4">
        <div>
          <label htmlFor="vault-password" className="block text-xs font-medium text-text-secondary mb-1.5">Password</label>
          <input
            id="vault-password"
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
            autoFocus
            className="w-full px-4 py-3 rounded-md bg-bg-primary border border-border text-accent text-2xl tracking-[0.3em] placeholder:text-text-muted placeholder:text-sm placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          />
        </div>
        <div>
          <label htmlFor="vault-confirm-password" className="block text-xs font-medium text-text-secondary mb-1.5">Confirm password</label>
          <input
            id="vault-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
            className="w-full px-4 py-3 rounded-md bg-bg-primary border border-border text-accent text-2xl tracking-[0.3em] placeholder:text-text-muted placeholder:text-sm placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
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
  );
}
