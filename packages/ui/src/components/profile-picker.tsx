import { useEffect, useRef, useState } from 'react';

/** Case-insensitive multi-token match: every whitespace-separated token
 *  of the query must appear somewhere in the profile name. "SRE" matches
 *  "sre-emea"; "acc prod" matches "Accounts-Domain-Production-ReadOnly".
 *  Predictable on purpose — no subsequence fuzziness that surfaces
 *  surprising matches in 50-profile SSO setups. */
export function filterProfiles(profiles: readonly string[], query: string): readonly string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return profiles;
  return profiles.filter(p => {
    const lower = p.toLowerCase();
    return tokens.every(t => lower.includes(t));
  });
}

interface ProfilePickerProps {
  readonly profiles: readonly string[];
  readonly selected: string;
  readonly onSelect: (profile: string) => void;
  /** Badge this profile as the one currently in use. */
  readonly currentProfile?: string | undefined;
  /** Focus the filter input on mount (for pickers that ARE the dialog's
   *  main content). */
  readonly autoFocus?: boolean | undefined;
  /** Tailwind max-height class for the scrollable list. */
  readonly listClassName?: string | undefined;
  readonly inputId?: string | undefined;
}

/** The one profile picker used everywhere a user chooses an AWS profile
 *  (setup wizard, import dialog, profile swap). Filter-as-you-type with
 *  Enter selecting the first visible match. */
export function ProfilePicker({ profiles, selected, onSelect, currentProfile, autoFocus, listClassName, inputId }: Readonly<ProfilePickerProps>): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = filterProfiles(profiles, filter);

  useEffect(() => {
    if (autoFocus === true) inputRef.current?.focus();
  }, [autoFocus]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Enter') return;
    const first = filtered[0];
    if (first !== undefined) {
      e.preventDefault();
      onSelect(first);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={filter}
        onChange={(e) => { setFilter(e.target.value); }}
        onKeyDown={handleKeyDown}
        placeholder="Type to filter profiles…"
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
      />
      <div
        className={['flex flex-col gap-1 overflow-y-auto', listClassName ?? 'max-h-48'].join(' ')}
        role="group"
        aria-label="AWS profiles"
      >
        {filtered.map(profile => (
          <button
            key={profile}
            type="button"
            aria-pressed={selected === profile}
            onClick={() => { onSelect(profile); }}
            className={[
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
              selected === profile
                ? 'border-accent bg-accent-muted text-accent'
                : 'border-border bg-bg-tertiary/20 text-text-primary hover:bg-bg-tertiary/40',
            ].join(' ')}
          >
            <span className="font-mono text-xs flex-1 min-w-0 truncate">{profile}</span>
            {profile === currentProfile && (
              <span className="shrink-0 text-[10px] text-text-muted uppercase tracking-wider">Current</span>
            )}
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-text-muted text-center py-3">No profiles match &ldquo;{filter}&rdquo;</p>
        )}
      </div>
    </div>
  );
}
