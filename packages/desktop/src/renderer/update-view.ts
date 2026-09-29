import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';

/**
 * The renderer's view of the updater. It pulls a snapshot on mount
 * (`update:get-status`) and tracks pushes (`update:status-changed`); `source`
 * records which one the current status came from, because a check error
 * pulled on mount is treated differently from one pushed live (see
 * {@link decideUpdateAutoOpen}).
 */
export interface UpdateView {
  readonly status: UpdateStatus;
  readonly source: 'initial' | 'pull' | 'push';
  /** A check has run this session — sticky once true. */
  readonly checked: boolean;
  /**
   * Counts entries into the error state. Back-to-back error statuses with no
   * other state between them (electron-updater dispatches 'error' and the
   * full-download retry's .catch then sets it again) share one episode, so
   * the modal opens once per failure rather than once per push.
   */
  readonly errorEpisode: number;
}

export const INITIAL_UPDATE_VIEW: UpdateView = { status: { state: 'idle' }, source: 'initial', checked: false, errorEpisode: 0 };

function nextErrorEpisode(prev: UpdateView, status: UpdateStatus): number {
  return status.state === 'error' && prev.status.state !== 'error' ? prev.errorEpisode + 1 : prev.errorEpisode;
}

/** Apply a live status push. Any non-idle status implies a check ran. */
export function applyPushedStatus(prev: UpdateView, status: UpdateStatus): UpdateView {
  return {
    status,
    source: 'push',
    checked: prev.checked || status.state !== 'idle',
    errorEpisode: nextErrorEpisode(prev, status),
  };
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
  return {
    status: snapshot.status,
    source: 'pull',
    checked,
    errorEpisode: nextErrorEpisode(prev, snapshot.status),
  };
}

/** What the modal has already opened for this session. */
export interface AutoOpenMemory {
  /** The one-time available/downloaded prompt has been shown. */
  readonly updatePrompted: boolean;
  /** The last error episode the modal opened for (0 = none). */
  readonly errorEpisodeShown: number;
}

export const INITIAL_AUTO_OPEN_MEMORY: AutoOpenMemory = { updatePrompted: false, errorEpisodeShown: 0 };

/**
 * Whether the update modal should open by itself (the caller only asks once
 * setup is done), and the memory to carry to the next decision.
 * - Each error episode opens it once — a repeated error push can't re-open a
 *   modal the user closed, but a new failure (e.g. after Retry) always
 *   surfaces. The exception is a check-stage error pulled on mount: the launch
 *   check failed before the window existed (typically offline, or github.com
 *   blocked), which used to be dropped silently; Settings → General still
 *   shows "Retry update check".
 * - An available or downloaded update opens it once per session, whether it
 *   was pushed or pulled (a launch check that finished before the renderer
 *   subscribed must still prompt).
 */
export function decideUpdateAutoOpen(
  view: UpdateView,
  memory: AutoOpenMemory,
): { readonly open: boolean; readonly memory: AutoOpenMemory } {
  const { status } = view;
  if (status.state === 'error') {
    const pulledCheckError = view.source === 'pull' && status.stage === 'check';
    if (pulledCheckError || view.errorEpisode === memory.errorEpisodeShown) return { open: false, memory };
    return { open: true, memory: { ...memory, errorEpisodeShown: view.errorEpisode } };
  }
  if (memory.updatePrompted) return { open: false, memory };
  if (status.state === 'available' || status.state === 'downloaded') {
    return { open: true, memory: { ...memory, updatePrompted: true } };
  }
  return { open: false, memory };
}
