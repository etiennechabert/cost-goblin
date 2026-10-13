import { describe, expect, it } from 'vitest';
import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';
import {
  INITIAL_AUTO_OPEN_MEMORY,
  INITIAL_UPDATE_VIEW,
  applyPulledSnapshot,
  applyPushedStatus,
  decideUpdateAutoOpen,
  hasUpdateIndicator,
  isAnotherModalOpen,
  keepUpdateModalOpen,
  settingsGearTab,
  updateModalHasContent,
} from '../renderer/update-view.js';
import type { AutoOpenMemory, UpdateView } from '../renderer/update-view.js';

const INFO = { version: '0.7.3', releaseDate: '2026-10-01', releaseNotes: null };
const IDLE: UpdateStatus = { state: 'idle' };
const CHECKING: UpdateStatus = { state: 'checking' };
const AVAILABLE: UpdateStatus = { state: 'available', info: INFO };
const DOWNLOADING: UpdateStatus = { state: 'downloading', percent: 40, info: INFO };
const DOWNLOADED: UpdateStatus = { state: 'downloaded', info: INFO };
const CHECK_ERROR: UpdateStatus = { state: 'error', error: 'getaddrinfo ENOTFOUND api.github.com', stage: 'check', logs: [] };
const DOWNLOAD_ERROR: UpdateStatus = { state: 'error', error: 'socket hang up', stage: 'download', logs: [] };
const RETRY_ERROR: UpdateStatus = { state: 'error', error: 'immediate failure', stage: 'download', logs: [] };

function snapshot(status: UpdateStatus, checkedThisSession: boolean): UpdateSnapshot {
  return { status, checkedThisSession };
}

function pushAll(statuses: readonly UpdateStatus[], from: UpdateView = INITIAL_UPDATE_VIEW): UpdateView {
  return statuses.reduce(applyPushedStatus, from);
}

const NO_OTHER_MODAL = { otherModalOpen: false } as const;
const OTHER_MODAL = { otherModalOpen: true } as const;

/** Replays the App effect: one decision per view, memory carried forward;
 *  returns whether each view opened the modal. */
function opens(views: readonly UpdateView[], memory: AutoOpenMemory = INITIAL_AUTO_OPEN_MEMORY): boolean[] {
  return replay(views.map((view) => ({ view, otherModalOpen: false })), memory);
}

/** Like `opens`, with whether another modal was open at each decision — the
 *  App effect re-decides on the same view when that changes. */
function replay(
  steps: readonly { readonly view: UpdateView; readonly otherModalOpen: boolean }[],
  memory: AutoOpenMemory = INITIAL_AUTO_OPEN_MEMORY,
): boolean[] {
  let current = memory;
  return steps.map(({ view, otherModalOpen }) => {
    const decision = decideUpdateAutoOpen(view, current, { otherModalOpen });
    current = decision.memory;
    return decision.open;
  });
}

describe('update view: mount pull', () => {
  it('starts idle and unchecked', () => {
    expect(INITIAL_UPDATE_VIEW).toStrictEqual({ status: IDLE, source: 'initial', checked: false, errorEpisode: 0 });
  });

  it('takes the pulled status and check flag when nothing was pushed yet', () => {
    expect(applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(AVAILABLE, true)))
      .toStrictEqual({ status: AVAILABLE, source: 'pull', checked: true, errorEpisode: 0 });
  });

  it('keeps "not checked" for a pulled idle snapshot before any check', () => {
    expect(applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(IDLE, false)))
      .toStrictEqual({ status: IDLE, source: 'pull', checked: false, errorEpisode: 0 });
  });

  it('starts an error episode for a pulled error', () => {
    expect(applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true)).errorEpisode).toBe(1);
  });

  it('keeps a status pushed before the pull resolved (the push is at least as new)', () => {
    const pushed = applyPushedStatus(INITIAL_UPDATE_VIEW, DOWNLOAD_ERROR);
    expect(applyPulledSnapshot(pushed, snapshot(CHECK_ERROR, true)))
      .toStrictEqual({ status: DOWNLOAD_ERROR, source: 'push', checked: true, errorEpisode: 1 });
  });

  it('merges only the check flag into an already-pushed view', () => {
    const pushed = applyPushedStatus(INITIAL_UPDATE_VIEW, IDLE);
    expect(pushed.checked).toBe(false);
    expect(applyPulledSnapshot(pushed, snapshot(IDLE, true)))
      .toStrictEqual({ status: IDLE, source: 'push', checked: true, errorEpisode: 0 });
  });

  it('returns the same object when the pull changes nothing', () => {
    const pushed = applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING);
    expect(applyPulledSnapshot(pushed, snapshot(CHECKING, true))).toBe(pushed);
  });
});

describe('update view: pushed statuses', () => {
  it('marks the session checked on any non-idle push', () => {
    for (const status of [CHECKING, AVAILABLE, DOWNLOADED, CHECK_ERROR]) {
      expect(applyPushedStatus(INITIAL_UPDATE_VIEW, status).checked).toBe(true);
    }
  });

  it('does not mark the session checked on an idle push alone', () => {
    expect(applyPushedStatus(INITIAL_UPDATE_VIEW, IDLE))
      .toStrictEqual({ status: IDLE, source: 'push', checked: false, errorEpisode: 0 });
  });

  it('never un-checks the session', () => {
    const checked = applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING);
    expect(applyPushedStatus(checked, IDLE).checked).toBe(true);
  });

  it('replaces a pulled status', () => {
    const pulled = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true));
    expect(applyPushedStatus(pulled, CHECKING))
      .toStrictEqual({ status: CHECKING, source: 'push', checked: true, errorEpisode: 1 });
  });

  it('keeps one error episode across back-to-back error pushes', () => {
    // A failed full-download retry: electron-updater dispatches 'error' and
    // the retry's .catch sets the error status again — two pushes, no state
    // in between.
    const first = pushAll([AVAILABLE, DOWNLOADING, DOWNLOAD_ERROR]);
    const repeat = applyPushedStatus(first, RETRY_ERROR);
    expect(first.errorEpisode).toBe(1);
    expect(repeat.errorEpisode).toBe(1);
    // The repeat's message still replaces the first, so the modal shows it.
    expect(repeat.status).toBe(RETRY_ERROR);
  });

  it('starts a new error episode after any non-error status', () => {
    const first = pushAll([CHECKING, CHECK_ERROR]);
    expect(pushAll([CHECKING, CHECK_ERROR], first).errorEpisode).toBe(2);
  });
});

describe('decideUpdateAutoOpen', () => {
  it('does not open for a check error pulled on mount (e.g. an offline launch)', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true));
    expect(opens([view])).toStrictEqual([false]);
  });

  it('opens for a pushed check error', () => {
    expect(opens([applyPushedStatus(INITIAL_UPDATE_VIEW, CHECK_ERROR)])).toStrictEqual([true]);
  });

  it('opens for a pulled download error', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(DOWNLOAD_ERROR, true));
    expect(opens([view])).toStrictEqual([true]);
  });

  it('opens an error episode once: a repeated error push does not re-open a closed modal', () => {
    const first = pushAll([AVAILABLE, DOWNLOADING, DOWNLOAD_ERROR]);
    const repeat = applyPushedStatus(first, RETRY_ERROR);
    expect(opens([first, repeat], { updatePrompted: true, errorEpisodeShown: 0 })).toStrictEqual([true, false]);
  });

  it('re-opens for a new error after a retry (errors always surface)', () => {
    const first = pushAll([CHECKING, CHECK_ERROR]);
    const retrying = applyPushedStatus(first, CHECKING);
    const second = applyPushedStatus(retrying, CHECK_ERROR);
    expect(opens([first, retrying, second])).toStrictEqual([true, false, true]);
  });

  it('still opens an episode whose first push was never decided on (setup not ready yet)', () => {
    // The App effect skips deciding until setup is ready, so only the latest
    // view of the episode is ever seen — it must still open.
    const repeat = pushAll([DOWNLOADING, DOWNLOAD_ERROR, RETRY_ERROR]);
    expect(opens([repeat])).toStrictEqual([true]);
  });

  it('a shown error does not use up the one-time update prompt', () => {
    const error = pushAll([CHECKING, CHECK_ERROR]);
    const available = pushAll([CHECKING, AVAILABLE], error);
    expect(opens([error, available])).toStrictEqual([true, true]);
  });

  it('opens once for an update the launch check found before the renderer subscribed', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(AVAILABLE, true));
    expect(opens([view, view])).toStrictEqual([true, false]);
  });

  it('opens once per session for a pushed available or downloaded update', () => {
    const available = applyPushedStatus(INITIAL_UPDATE_VIEW, AVAILABLE);
    const downloaded = pushAll([DOWNLOADING, DOWNLOADED], available);
    expect(opens([available, downloaded])).toStrictEqual([true, false]);
    expect(opens([downloaded])).toStrictEqual([true]);
  });

  it('stays closed while idle, checking or downloading', () => {
    for (const status of [IDLE, CHECKING, DOWNLOADING]) {
      expect(opens([applyPushedStatus(INITIAL_UPDATE_VIEW, status)])).toStrictEqual([false]);
    }
    expect(opens([INITIAL_UPDATE_VIEW])).toStrictEqual([false]);
  });

  it('leaves the memory untouched when nothing opens', () => {
    const decision = decideUpdateAutoOpen(applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING), INITIAL_AUTO_OPEN_MEMORY, NO_OTHER_MODAL);
    expect(decision).toStrictEqual({ open: false, memory: INITIAL_AUTO_OPEN_MEMORY });
  });
});

// The update modal is a layer of its own: opened while another modal is up,
// it would sit over (or, before the layers were unified, under) a dialog the
// user is working in and take its clicks. It waits for the last one to close.
describe('decideUpdateAutoOpen while another modal is open', () => {
  it('does not open an available update, and does not use up the one-time prompt', () => {
    const available = applyPushedStatus(INITIAL_UPDATE_VIEW, AVAILABLE);
    expect(decideUpdateAutoOpen(available, INITIAL_AUTO_OPEN_MEMORY, OTHER_MODAL))
      .toStrictEqual({ open: false, memory: INITIAL_AUTO_OPEN_MEMORY });
  });

  it('does not open a new error episode, and does not mark it shown', () => {
    const error = pushAll([CHECKING, CHECK_ERROR]);
    expect(decideUpdateAutoOpen(error, INITIAL_AUTO_OPEN_MEMORY, OTHER_MODAL))
      .toStrictEqual({ open: false, memory: INITIAL_AUTO_OPEN_MEMORY });
  });

  it('opens the deferred update once the last other modal closes', () => {
    const available = applyPushedStatus(INITIAL_UPDATE_VIEW, AVAILABLE);
    expect(replay([
      { view: available, otherModalOpen: true },
      { view: available, otherModalOpen: true },
      { view: available, otherModalOpen: false },
      { view: available, otherModalOpen: false },
    ])).toStrictEqual([false, false, true, false]);
  });

  it('opens the deferred error episode once the last other modal closes', () => {
    const error = pushAll([AVAILABLE, DOWNLOADING, DOWNLOAD_ERROR]);
    const repeat = applyPushedStatus(error, RETRY_ERROR);
    expect(replay([
      { view: error, otherModalOpen: true },
      { view: repeat, otherModalOpen: true },
      { view: repeat, otherModalOpen: false },
      { view: repeat, otherModalOpen: false },
    ], { updatePrompted: true, errorEpisodeShown: 0 })).toStrictEqual([false, false, true, false]);
  });

  it('opens a downloaded update deferred from its available push', () => {
    const available = applyPushedStatus(INITIAL_UPDATE_VIEW, AVAILABLE);
    const downloaded = pushAll([DOWNLOADING, DOWNLOADED], available);
    expect(replay([
      { view: available, otherModalOpen: true },
      { view: downloaded, otherModalOpen: false },
    ])).toStrictEqual([false, true]);
  });

  it('never opens what would not open anyway', () => {
    const pulledCheckError = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true));
    for (const view of [INITIAL_UPDATE_VIEW, applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING), pulledCheckError]) {
      expect(replay([{ view, otherModalOpen: true }, { view, otherModalOpen: false }])).toStrictEqual([false, false]);
    }
  });
});

describe('isAnotherModalOpen', () => {
  it('is false with no modal open', () => {
    expect(isAnotherModalOpen(0, false)).toBe(false);
  });

  it('is true for any open modal while the update modal is not showing', () => {
    expect(isAnotherModalOpen(1, false)).toBe(true);
    expect(isAnotherModalOpen(2, false)).toBe(true);
  });

  it('does not count the update modal itself, which is one of the open layers while it shows', () => {
    expect(isAnotherModalOpen(1, true)).toBe(false);
    expect(isAnotherModalOpen(2, true)).toBe(true);
  });

  it('is false while the update modal is opening but has not registered its layer yet', () => {
    expect(isAnotherModalOpen(0, true)).toBe(false);
  });
});

describe('updateModalHasContent', () => {
  it('is true for the statuses the update modal shows', () => {
    for (const status of [AVAILABLE, DOWNLOADING, DOWNLOADED, CHECK_ERROR, DOWNLOAD_ERROR]) {
      expect(updateModalHasContent(status)).toBe(true);
    }
  });

  it('is false while idle or checking, when the modal renders nothing', () => {
    expect(updateModalHasContent(IDLE)).toBe(false);
    expect(updateModalHasContent(CHECKING)).toBe(false);
  });
});

// A flag left set while the modal rendered nothing (Retry in "Update failed"
// moves to 'checking') would re-mount the modal open as soon as a later status
// gave it content — an 'available' or a new error, shown without ever going
// through decideUpdateAutoOpen, so over whatever modal is open by then.
describe('keepUpdateModalOpen', () => {
  it('closes the modal when the status leaves what it shows', () => {
    expect(keepUpdateModalOpen(true, CHECKING)).toBe(false);
    expect(keepUpdateModalOpen(true, IDLE)).toBe(false);
  });

  it('keeps it open across statuses it shows (Download → downloading → downloaded)', () => {
    for (const status of [AVAILABLE, DOWNLOADING, DOWNLOADED, DOWNLOAD_ERROR]) {
      expect(keepUpdateModalOpen(true, status)).toBe(true);
    }
  });

  it('never opens a closed modal', () => {
    for (const status of [IDLE, CHECKING, AVAILABLE, DOWNLOADING, DOWNLOADED, CHECK_ERROR]) {
      expect(keepUpdateModalOpen(false, status)).toBe(false);
    }
  });

  it('after a Retry, a later error re-opens only through the decision', () => {
    // error (shown) → Retry → checking → error: the flag is cleared at
    // 'checking', so the new episode opens via decideUpdateAutoOpen — and
    // waits while another modal is open.
    const first = pushAll([CHECKING, CHECK_ERROR]);
    const retrying = applyPushedStatus(first, CHECKING);
    const second = applyPushedStatus(retrying, CHECK_ERROR);
    const afterRetry = keepUpdateModalOpen(true, retrying.status);
    expect(afterRetry).toBe(false);
    const memory = decideUpdateAutoOpen(first, INITIAL_AUTO_OPEN_MEMORY, NO_OTHER_MODAL).memory;
    expect(decideUpdateAutoOpen(second, memory, OTHER_MODAL).open).toBe(false);
    expect(decideUpdateAutoOpen(second, memory, NO_OTHER_MODAL).open).toBe(true);
  });
});

describe('hasUpdateIndicator', () => {
  it('flags an update the user can act on', () => {
    for (const status of [AVAILABLE, DOWNLOADING, DOWNLOADED]) {
      expect(hasUpdateIndicator(status)).toBe(true);
    }
  });

  it('is off otherwise', () => {
    for (const status of [IDLE, CHECKING, CHECK_ERROR]) {
      expect(hasUpdateIndicator(status)).toBe(false);
    }
  });
});

// The gear's dot (and title) say "Update available"; the update controls live
// in General, so that is where a click on it has to land.
describe('settingsGearTab', () => {
  it('lands on General while the gear shows the update dot', () => {
    for (const status of [AVAILABLE, DOWNLOADING, DOWNLOADED]) {
      expect(settingsGearTab(status)).toBe('general');
    }
  });

  it('lands on Data & Sync otherwise', () => {
    for (const status of [IDLE, CHECKING, CHECK_ERROR]) {
      expect(settingsGearTab(status)).toBe('data-sync');
    }
  });
});
