import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';

/**
 * The renderer's view of the updater. It pulls a snapshot on mount
 * (`update:get-status`) and tracks pushes (`update:status-changed`); `source`
 * records which one the current status came from, because a check error
 * pulled on mount is treated differently from one pushed live (see
 * {@link shouldAutoOpenUpdateModal}).
 */
export interface UpdateView {
  readonly status: UpdateStatus;
  readonly source: 'initial' | 'pull' | 'push';
  /** A check has run this session — sticky once true. */
  readonly checked: boolean;
}

export const INITIAL_UPDATE_VIEW: UpdateView = { status: { state: 'idle' }, source: 'initial', checked: false };

/** Apply a live status push. Any non-idle status implies a check ran. */
export function applyPushedStatus(prev: UpdateView, status: UpdateStatus): UpdateView {
  return { status, source: 'push', checked: prev.checked || status.state !== 'idle' };
}

/**
 * Apply the snapshot pulled on mount. The renderer subscribes before it pulls,
 * and IPC messages arrive in order, so a push that landed before the pull
 * resolved is at least as new as the snapshot: keep its status and merge only
 * the check flag. Otherwise (nothing pushed yet) the snapshot is the only way
 * to learn about a status set before the window subscribed.
 */
export function applyPulledSnapshot(prev: UpdateView, snapshot: UpdateSnapshot): UpdateView {
  const checked = prev.checked || snapshot.checkedThisSession || snapshot.status.state !== 'idle';
  if (prev.source === 'push') {
    return checked === prev.checked ? prev : { ...prev, checked };
  }
  return { status: snapshot.status, source: 'pull', checked };
}

/**
 * Whether the update modal should open by itself (once setup is done).
 * - Errors always surface, except a check-stage error pulled on mount: the
 *   launch check failed before the window existed (typically offline, or
 *   github.com blocked), which used to be dropped silently; Settings → General
 *   still shows "Retry update check".
 * - An available or downloaded update opens it once per session, whether it
 *   was pushed or pulled (a launch check that finished before the renderer
 *   subscribed must still prompt).
 */
export function shouldAutoOpenUpdateModal(view: UpdateView, alreadyAutoOpened: boolean): boolean {
  const { status } = view;
  if (status.state === 'error') return !(view.source === 'pull' && status.stage === 'check');
  if (alreadyAutoOpened) return false;
  return status.state === 'available' || status.state === 'downloaded';
}
