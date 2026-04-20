import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmModal } from '../components/confirm-modal.js';

/** Any view that edits something registers its dirty state via
 *  `useUnsavedChanges(dirty, label)`. The provider keeps a registry of
 *  currently-dirty keys; any call to `confirmLeave(onProceed)` with at
 *  least one dirty entry pops a confirm modal before running the callback.
 *
 *  Scope is intentionally per-session (not persisted) — if a user reloads
 *  the app mid-edit, their draft is gone anyway; the guard only protects
 *  in-session navigation between views. */
interface UnsavedChangesContextValue {
  readonly hasUnsaved: boolean;
  readonly label: string | null;
  readonly setDirty: (key: string, dirty: boolean, label?: string) => void;
  readonly confirmLeave: (onProceed: () => void) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue>({
  hasUnsaved: false,
  label: null,
  setDirty: () => { /* no-op fallback when provider is missing (tests) */ },
  confirmLeave: (fn) => { fn(); },
});

interface RegistryEntry {
  readonly dirty: boolean;
  readonly label: string | null;
}

export function UnsavedChangesProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [registry, setRegistry] = useState<ReadonlyMap<string, RegistryEntry>>(new Map());
  const [pending, setPending] = useState<(() => void) | null>(null);

  const setDirty = useCallback((key: string, dirty: boolean, label?: string) => {
    setRegistry(prev => {
      const existing = prev.get(key);
      // Skip updates that would no-op the registry — keeps React from
      // kicking off a re-render every keystroke when a dirty state stays
      // dirty, which would otherwise re-fire every view's useEffect that
      // depends on `setDirty`.
      if (dirty && existing !== undefined && existing.dirty === dirty && existing.label === (label ?? null)) {
        return prev;
      }
      if (!dirty && existing === undefined) return prev;
      const next = new Map(prev);
      if (dirty) next.set(key, { dirty, label: label ?? null });
      else next.delete(key);
      return next;
    });
  }, []);

  const label = useMemo(() => {
    for (const entry of registry.values()) {
      if (entry.label !== null) return entry.label;
    }
    return null;
  }, [registry]);
  const hasUnsaved = registry.size > 0;

  // Snapshot `hasUnsaved` at call time via a ref so `confirmLeave` is
  // stable — otherwise the App.tsx navigation handler would change
  // identity on every edit keystroke and its own useEffect deps would
  // thrash.
  const hasUnsavedRef = useRef(hasUnsaved);
  hasUnsavedRef.current = hasUnsaved;

  const confirmLeave = useCallback((onProceed: () => void) => {
    if (!hasUnsavedRef.current) { onProceed(); return; }
    setPending(() => onProceed);
  }, []);

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({ hasUnsaved, label, setDirty, confirmLeave }),
    [hasUnsaved, label, setDirty, confirmLeave],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      {pending !== null && (
        <ConfirmModal
          title={label === null ? 'Discard unsaved changes?' : `Discard changes in ${label}?`}
          message="You have unsaved changes that haven't been saved yet. If you continue, they'll be lost."
          confirmLabel="Discard"
          cancelLabel="Stay"
          destructive
          onConfirm={() => {
            const proceed = pending;
            setPending(null);
            proceed();
          }}
          onCancel={() => { setPending(null); }}
        />
      )}
    </UnsavedChangesContext.Provider>
  );
}

/** Register the current view's dirty state with the guard. Pass a stable
 *  boolean (usually computed from draft-vs-saved) and an optional human
 *  label ("Cost Scope", "Views") that'll appear in the confirm modal. */
export function useUnsavedChanges(isDirty: boolean, label?: string): void {
  const ctx = useContext(UnsavedChangesContext);
  // Stable per-mount key so each mounted view registers independently.
  // Using a ref keeps the key across renders — a new one would cause the
  // cleanup/register pair to churn and leave stale entries behind.
  const keyRef = useRef<string | undefined>(undefined);
  if (keyRef.current === undefined) {
    keyRef.current = `uc-${String(Math.random()).slice(2)}-${String(Date.now())}`;
  }
  const setDirty = ctx.setDirty;
  useEffect(() => {
    const key = keyRef.current;
    if (key === undefined) return;
    setDirty(key, isDirty, label);
    return () => { setDirty(key, false); };
  }, [isDirty, label, setDirty]);
}

/** Wrap a navigation (or any "leaving" action) — runs immediately if no
 *  view is dirty, otherwise prompts before proceeding. */
export function useConfirmLeave(): (onProceed: () => void) => void {
  return useContext(UnsavedChangesContext).confirmLeave;
}
