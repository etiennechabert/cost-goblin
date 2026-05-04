import { useState, useCallback } from 'react';
import { CoinRainLoader } from '@costgoblin/ui';

interface VaultLockScreenProps {
  readonly onUnlocked: () => void;
  readonly onReset: () => void;
}

export function VaultLockScreen({ onUnlocked, onReset }: VaultLockScreenProps): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleSubmit = useCallback(async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (password.length === 0 || unlocking) return;

    setUnlocking(true);
    setError(null);

    const result = await globalThis.costgoblinVault.unlock(password);
    if (result.success) {
      onUnlocked();
    } else {
      setError('Wrong password');
      setUnlocking(false);
    }
  }, [password, unlocking, onUnlocked]);

  const handleReset = useCallback(async () => {
    await globalThis.costgoblinVault.reset();
    onReset();
  }, [onReset]);

  if (confirmReset) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center bg-bg-primary"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="w-80 text-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <h2 className="text-lg font-semibold text-text-primary mb-2">Reset data?</h2>
          <p className="text-sm text-text-secondary mb-6">
            This will delete all local data. You&apos;ll need to set up CostGoblin again and re-sync from S3.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              type="button"
              onClick={() => { setConfirmReset(false); }}
              className="px-4 py-2 text-sm font-medium rounded-md bg-bg-tertiary text-text-primary hover:bg-bg-tertiary/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleReset(); }}
              className="px-4 py-2 text-sm font-medium rounded-md bg-negative text-white hover:bg-negative/80 transition-colors"
            >
              Delete all data
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-bg-primary"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="w-80" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex flex-col items-center mb-8">
          <img src="goblin.png" alt="" className="h-16 w-auto object-contain mb-3" />
          <h1 className="text-xl font-bold text-accent tracking-wider">CostGoblin</h1>
          <p className="text-sm text-text-secondary mt-1">Enter your password to unlock</p>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              autoFocus
              className="w-full px-3 py-2.5 rounded-md bg-bg-secondary border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
            />
            {error !== null && (
              <p className="mt-1.5 text-xs text-negative">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={password.length === 0 || unlocking}
            className="w-full py-2.5 rounded-md bg-accent text-white font-medium text-sm hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {unlocking ? 'Unlocking...' : 'Unlock'}
          </button>
        </form>

        {unlocking && (
          <div className="mt-6">
            <CoinRainLoader height={80} count={4} />
          </div>
        )}

        <button
          type="button"
          onClick={() => { setConfirmReset(true); }}
          className="mt-6 w-full text-center text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          Forgot password?
        </button>
      </div>
    </div>
  );
}
