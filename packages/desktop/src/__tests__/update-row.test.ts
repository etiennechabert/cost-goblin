import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@costgoblin/core/browser';
import { describeUpdateRow } from '../renderer/settings/update-row.js';

describe('describeUpdateRow', () => {
  it('says "up to date" only after a check this session', () => {
    expect(describeUpdateRow({ state: 'idle', checked: true, checkOnStartup: true, appVersion: '0.7.2' }))
      .toBe("You're up to date · v0.7.2");
    expect(describeUpdateRow({ state: 'idle', checked: true, checkOnStartup: false, appVersion: '0.7.2' }))
      .toBe("You're up to date · v0.7.2");
  });

  it('says the automatic check is off when nothing was checked and the pref is off', () => {
    expect(describeUpdateRow({ state: 'idle', checked: false, checkOnStartup: false, appVersion: '0.7.2' }))
      .toBe('Automatic check is off · v0.7.2');
  });

  it('says "not checked yet" when nothing was checked and the pref is on', () => {
    expect(describeUpdateRow({ state: 'idle', checked: false, checkOnStartup: true, appVersion: '0.7.2' }))
      .toBe('Not checked yet · v0.7.2');
  });

  it('drops the version suffix while the version is unknown', () => {
    expect(describeUpdateRow({ state: 'idle', checked: true, checkOnStartup: true, appVersion: '' }))
      .toBe("You're up to date");
    expect(describeUpdateRow({ state: 'idle', checked: false, checkOnStartup: false, appVersion: '' }))
      .toBe('Automatic check is off');
    expect(describeUpdateRow({ state: 'idle', checked: false, checkOnStartup: true, appVersion: '' }))
      .toBe('Not checked yet');
  });

  it.each<UpdateStatus['state']>(['checking', 'available', 'downloading', 'downloaded', 'error'])(
    'has no description while %s (the control speaks for itself)',
    (state) => {
      expect(describeUpdateRow({ state, checked: true, checkOnStartup: true, appVersion: '0.7.2' })).toBeUndefined();
      expect(describeUpdateRow({ state, checked: false, checkOnStartup: false, appVersion: '0.7.2' })).toBeUndefined();
    },
  );
});
