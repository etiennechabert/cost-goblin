import { useState, useCallback, useEffect } from 'react';

const SPLASH_IMAGES = ['splash-1.png', 'splash-2.png', 'splash-3.png', 'splash-4.png', 'splash-5.png', 'splash-6.png', 'splash-7.png', 'splash-8.png', 'splash-9.png', 'splash-10.png'];
const SPLASH_INTERVAL = 500;

function shuffled<T>(arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

function RotatingGoblin(): React.JSX.Element {
  const [order] = useState(() => shuffled(SPLASH_IMAGES));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex(prev => (prev + 1) % SPLASH_IMAGES.length);
    }, SPLASH_INTERVAL);
    return () => { clearInterval(timer); };
  }, []);

  return (
    <div className="relative h-24 w-24">
      {order.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-contain drop-shadow-lg transition-opacity duration-200"
          style={{ opacity: i === index ? 1 : 0 }}
        />
      ))}
    </div>
  );
}

function KeyUnlockAnimation(): React.JSX.Element {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className="text-accent">
      {/* Lock body */}
      <rect x="16" y="28" width="32" height="24" rx="4" stroke="currentColor" strokeWidth="2.5" opacity="0.6" />
      {/* Keyhole */}
      <circle cx="32" cy="38" r="3" fill="currentColor" opacity="0.6" />
      <rect x="30.5" y="38" width="3" height="6" rx="1" fill="currentColor" opacity="0.6" />
      {/* Shackle — animates open */}
      <path
        d="M22 28V22a10 10 0 0 1 20 0v6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="origin-[42px_28px]"
        style={{
          animation: 'shackle-open 1.2s ease-in-out forwards',
        }}
      />
      {/* Key — slides in from right, then turns */}
      <g style={{ animation: 'key-enter 0.6s ease-out forwards, key-turn 0.5s ease-in-out 0.6s forwards' }}>
        {/* Key head (ring) */}
        <circle cx="52" cy="40" r="4" stroke="currentColor" strokeWidth="2" fill="none" />
        {/* Key shaft */}
        <line x1="48" y1="40" x2="38" y2="40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        {/* Key teeth */}
        <line x1="42" y1="40" x2="42" y2="43" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="39" y1="40" x2="39" y2="42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </g>
      <style>{`
        @keyframes shackle-open {
          0%, 50% { transform: rotate(0deg) translateY(0); opacity: 1; }
          100% { transform: rotate(-30deg) translateY(-4px); opacity: 0.4; }
        }
        @keyframes key-enter {
          0% { transform: translateX(20px); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
        @keyframes key-turn {
          0% { transform: rotate(0deg); transform-origin: 38px 40px; }
          100% { transform: rotate(-45deg); transform-origin: 38px 40px; }
        }
      `}</style>
    </svg>
  );
}

interface VaultLockScreenProps {
  readonly onUnlocked: () => void;
  readonly onReset: () => void;
}

export function VaultLockScreen({ onUnlocked, onReset }: VaultLockScreenProps): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [decryptProgress, setDecryptProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!unlocking) return;
    return globalThis.costgoblinVault.onDecryptProgress((done, total) => {
      setDecryptProgress({ done, total });
    });
  }, [unlocking]);

  const handleSubmit = useCallback(async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (password.length === 0 || unlocking) return;

    setUnlocking(true);
    setError(null);
    setDecryptProgress(null);

    const result = await globalThis.costgoblinVault.unlock(password);
    if (result.success) {
      onUnlocked();
    } else {
      setError('Wrong password');
      setUnlocking(false);
      setDecryptProgress(null);
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
              onClick={() => { handleReset().catch(() => undefined); }}
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
          <RotatingGoblin />
          <h1 className="text-xl font-bold text-accent tracking-wider mt-3">CostGoblin</h1>
          <p className="text-sm text-text-secondary mt-1">Enter your password to unlock</p>
        </div>

        <form onSubmit={(e) => { handleSubmit(e).catch(() => undefined); }} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              autoFocus
              className="w-full px-4 py-3 rounded-md bg-bg-secondary border border-border text-accent text-2xl tracking-[0.3em] placeholder:text-text-muted placeholder:text-sm placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
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
          <div className="mt-6 flex flex-col items-center gap-3">
            <KeyUnlockAnimation />
            {decryptProgress !== null && decryptProgress.total > 0 && (
              <div className="w-full space-y-1.5">
                <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-150 ease-out"
                    style={{ width: `${String(Math.round((decryptProgress.done / decryptProgress.total) * 100))}%` }}
                  />
                </div>
                <p className="text-xs text-text-muted text-center">
                  Decrypting {String(decryptProgress.done)}/{String(decryptProgress.total)} files
                </p>
              </div>
            )}
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
