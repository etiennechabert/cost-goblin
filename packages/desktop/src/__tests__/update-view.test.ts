import { describe, expect, it } from 'vitest';
import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';
import {
  INITIAL_AUTO_OPEN_MEMORY,
  INITIAL_UPDATE_VIEW,
  applyPulledSnapshot,
  applyPushedStatus,
  decideUpdateAutoOpen,
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

/** Replays the App effect: one decision per view, memory carried forward;
 *  returns whether each view opened the modal. */
function opens(views: readonly UpdateView[], memory: AutoOpenMemory = INITIAL_AUTO_OPEN_MEMORY): boolean[] {
  let current = memory;
  return views.map((view) => {
    const decision = decideUpdateAutoOpen(view, current);
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
    const decision = decideUpdateAutoOpen(applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING), INITIAL_AUTO_OPEN_MEMORY);
    expect(decision).toStrictEqual({ open: false, memory: INITIAL_AUTO_OPEN_MEMORY });
  });
});
