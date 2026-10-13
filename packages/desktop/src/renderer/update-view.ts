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

/** Where the decision is taken. */
export interface AutoOpenContext {
  /** A modal other than the update modal itself is open (see
   *  {@link isAnotherModalOpen}). */
  readonly otherModalOpen: boolean;
}

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
 * - Never over another modal: an update push lands whenever it lands, and a
 *   modal popping up over the dialog the user is working in takes the click
 *   meant for it. While one is open the answer is "not yet" and the memory is
 *   left as it was, so the caller — which decides again whenever
 *   `otherModalOpen` changes — opens it once the last one closes.
 */
export function decideUpdateAutoOpen(
  view: UpdateView,
  memory: AutoOpenMemory,
  context: AutoOpenContext,
): { readonly open: boolean; readonly memory: AutoOpenMemory } {
  const decision = decideIgnoringOtherModals(view, memory);
  if (decision.open && context.otherModalOpen) return { open: false, memory };
  return decision;
}

function decideIgnoringOtherModals(
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

/**
 * Whether a modal other than the update modal is open, from the number of
 * open modal layers (the UI's layer registry). The update modal is one of
 * those layers while it shows; until it has registered (the render right
 * after it opens) the count does not include it yet.
 */
export function isAnotherModalOpen(openLayerCount: number, updateModalShown: boolean): boolean {
  return openLayerCount > (updateModalShown ? 1 : 0);
}

/** The statuses the update modal has something to show for. */
export type UpdateModalStatus = Extract<UpdateStatus, { readonly state: 'available' | 'downloading' | 'downloaded' | 'error' }>;

/** True when the update modal has something to show; it renders nothing for
 *  the other statuses. */
export function updateModalHasContent(status: UpdateStatus): status is UpdateModalStatus {
  return status.state === 'available'
    || status.state === 'downloading'
    || status.state === 'downloaded'
    || status.state === 'error';
}

/**
 * The update modal's open flag for the current status: it is cleared as soon
 * as the status leaves what the modal shows. A flag left set while the modal
 * rendered nothing (Retry in "Update failed" moves to 'checking') would
 * re-mount it open the moment a later status gave it content — an
 * 'available', or a new error — without going through
 * {@link decideUpdateAutoOpen}, so over whatever modal is open by then.
 */
export function keepUpdateModalOpen(open: boolean, status: UpdateStatus): boolean {
  return open && updateModalHasContent(status);
}

/** An update the user can act on: the Settings gear shows a dot for it. */
export function hasUpdateIndicator(status: UpdateStatus): boolean {
  return status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded';
}

/** The Settings tab the gear opens on. Its dot and title say "Update
 *  available" and the update controls live in General, so that is where the
 *  click lands while the dot shows; otherwise Data & Sync. */
export function settingsGearTab(status: UpdateStatus): 'general' | 'data-sync' {
  return hasUpdateIndicator(status) ? 'general' : 'data-sync';
}
