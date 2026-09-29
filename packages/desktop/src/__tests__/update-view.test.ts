import { describe, expect, it } from 'vitest';
import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';
import {
  INITIAL_UPDATE_VIEW,
  applyPulledSnapshot,
  applyPushedStatus,
  shouldAutoOpenUpdateModal,
} from '../renderer/update-view.js';

const INFO = { version: '0.7.3', releaseDate: '2026-10-01', releaseNotes: null };
const IDLE: UpdateStatus = { state: 'idle' };
const CHECKING: UpdateStatus = { state: 'checking' };
const AVAILABLE: UpdateStatus = { state: 'available', info: INFO };
const DOWNLOADED: UpdateStatus = { state: 'downloaded', info: INFO };
const CHECK_ERROR: UpdateStatus = { state: 'error', error: 'getaddrinfo ENOTFOUND api.github.com', stage: 'check', logs: [] };
const DOWNLOAD_ERROR: UpdateStatus = { state: 'error', error: 'socket hang up', stage: 'download', logs: [] };

function snapshot(status: UpdateStatus, checkedThisSession: boolean): UpdateSnapshot {
  return { status, checkedThisSession };
}

describe('update view: mount pull', () => {
  it('starts idle and unchecked', () => {
    expect(INITIAL_UPDATE_VIEW).toStrictEqual({ status: IDLE, source: 'initial', checked: false });
  });

  it('takes the pulled status and check flag when nothing was pushed yet', () => {
    expect(applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(AVAILABLE, true)))
      .toStrictEqual({ status: AVAILABLE, source: 'pull', checked: true });
  });

  it('keeps "not checked" for a pulled idle snapshot before any check', () => {
    expect(applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(IDLE, false)))
      .toStrictEqual({ status: IDLE, source: 'pull', checked: false });
  });

  it('keeps a status pushed before the pull resolved (the push is at least as new)', () => {
    const pushed = applyPushedStatus(INITIAL_UPDATE_VIEW, DOWNLOAD_ERROR);
    expect(applyPulledSnapshot(pushed, snapshot(CHECK_ERROR, true)))
      .toStrictEqual({ status: DOWNLOAD_ERROR, source: 'push', checked: true });
  });

  it('merges only the check flag into an already-pushed view', () => {
    const pushed = applyPushedStatus(INITIAL_UPDATE_VIEW, IDLE);
    expect(pushed.checked).toBe(false);
    expect(applyPulledSnapshot(pushed, snapshot(IDLE, true)))
      .toStrictEqual({ status: IDLE, source: 'push', checked: true });
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
    expect(applyPushedStatus(INITIAL_UPDATE_VIEW, IDLE)).toStrictEqual({ status: IDLE, source: 'push', checked: false });
  });

  it('never un-checks the session', () => {
    const checked = applyPushedStatus(INITIAL_UPDATE_VIEW, CHECKING);
    expect(applyPushedStatus(checked, IDLE).checked).toBe(true);
  });

  it('replaces a pulled status', () => {
    const pulled = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true));
    expect(applyPushedStatus(pulled, CHECKING)).toStrictEqual({ status: CHECKING, source: 'push', checked: true });
  });
});

describe('shouldAutoOpenUpdateModal', () => {
  it('does not open for a check error pulled on mount (e.g. an offline launch)', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(CHECK_ERROR, true));
    expect(shouldAutoOpenUpdateModal(view, false)).toBe(false);
  });

  it('opens for a pushed check error, every time', () => {
    const view = applyPushedStatus(INITIAL_UPDATE_VIEW, CHECK_ERROR);
    expect(shouldAutoOpenUpdateModal(view, false)).toBe(true);
    expect(shouldAutoOpenUpdateModal(view, true)).toBe(true);
  });

  it('opens for a pulled download error', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(DOWNLOAD_ERROR, true));
    expect(shouldAutoOpenUpdateModal(view, false)).toBe(true);
  });

  it('opens once for an update the launch check found before the renderer subscribed', () => {
    const view = applyPulledSnapshot(INITIAL_UPDATE_VIEW, snapshot(AVAILABLE, true));
    expect(shouldAutoOpenUpdateModal(view, false)).toBe(true);
    expect(shouldAutoOpenUpdateModal(view, true)).toBe(false);
  });

  it('opens once for a pushed available or downloaded update', () => {
    for (const status of [AVAILABLE, DOWNLOADED]) {
      const view = applyPushedStatus(INITIAL_UPDATE_VIEW, status);
      expect(shouldAutoOpenUpdateModal(view, false)).toBe(true);
      expect(shouldAutoOpenUpdateModal(view, true)).toBe(false);
    }
  });

  it('stays closed while idle, checking or downloading', () => {
    const downloading: UpdateStatus = { state: 'downloading', percent: 40, info: INFO };
    for (const status of [IDLE, CHECKING, downloading]) {
      expect(shouldAutoOpenUpdateModal(applyPushedStatus(INITIAL_UPDATE_VIEW, status), false)).toBe(false);
    }
    expect(shouldAutoOpenUpdateModal(INITIAL_UPDATE_VIEW, false)).toBe(false);
  });
});
