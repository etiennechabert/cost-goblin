import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryPreferences } from '@costgoblin/core/browser';
import { CostApiProvider, MockCostApi } from '@costgoblin/ui';
import { SetupTelemetryStep } from '../renderer/setup-telemetry-step.js';

const ALL_OFF: TelemetryPreferences = { errorReports: false, nativeCrashReports: false, performance: false, analytics: false };

/** Preference reads answer from `reads` in order (the last one repeats); an
 *  Error entry is a failed read. Saves are recorded and settle via `saveOutcome`. */
class PrefsApi extends MockCostApi {
  reads: (TelemetryPreferences | Error)[] = [ALL_OFF];
  readCount = 0;
  readonly saves: TelemetryPreferences[] = [];
  saveOutcome: () => Promise<void> = () => Promise.resolve();

  override getTelemetryPreferences(): Promise<TelemetryPreferences> {
    const answer = this.reads[Math.min(this.readCount, this.reads.length - 1)] ?? ALL_OFF;
    this.readCount += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  override setTelemetryPreferences(prefs?: TelemetryPreferences): Promise<void> {
    if (prefs !== undefined) this.saves.push(prefs);
    return this.saveOutcome();
  }
}

function renderStep(api: PrefsApi, onDone: () => void = vi.fn()): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <SetupTelemetryStep onDone={onDone} />
    </CostApiProvider>,
  );
  return user;
}

function toggle(label: string): HTMLElement {
  return screen.getByRole('switch', { name: `Toggle ${label}` });
}

function isOn(label: string): boolean {
  return toggle(label).getAttribute('aria-checked') === 'true';
}

function finish(): HTMLButtonElement {
  const el = screen.getByRole('button', { name: 'Finish' });
  if (!(el instanceof HTMLButtonElement)) throw new Error('Finish is not a button');
  return el;
}

describe('SetupTelemetryStep', () => {
  it('offers only the two scrubbed channels, never native crash reports', async () => {
    renderStep(new PrefsApi());
    expect(screen.getByRole('heading', { name: 'Help improve CostGoblin?' })).toBeDefined();
    await waitFor(() => { expect(finish().disabled).toBe(false); });
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(toggle('Error reports')).toBeDefined();
    expect(toggle('Performance metrics')).toBeDefined();
    expect(screen.queryByRole('switch', { name: /Native crash/ })).toBeNull();
  });

  it('holds Finish until the saved preferences have loaded', async () => {
    const api = new PrefsApi();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => { release = res; });
    vi.spyOn(api, 'getTelemetryPreferences').mockImplementation(async () => {
      await gate;
      return ALL_OFF;
    });
    renderStep(api);
    expect(finish().disabled).toBe(true);

    await act(async () => { release(); await gate; });
    await waitFor(() => { expect(finish().disabled).toBe(false); });
  });

  it('starts from the choices already saved', async () => {
    const api = new PrefsApi();
    api.reads = [{ ...ALL_OFF, errorReports: true }];
    renderStep(api);
    await waitFor(() => { expect(isOn('Error reports')).toBe(true); });
    expect(isOn('Performance metrics')).toBe(false);
  });

  it('saves the two visible choices, keeps the channels it does not show, then moves on', async () => {
    const api = new PrefsApi();
    api.reads = [{ errorReports: false, nativeCrashReports: true, performance: false, analytics: true }];
    const onDone = vi.fn();
    const user = renderStep(api, onDone);
    await waitFor(() => { expect(finish().disabled).toBe(false); });

    await user.click(toggle('Error reports'));
    await user.click(toggle('Performance metrics'));
    await user.click(toggle('Performance metrics'));
    await user.click(toggle('Performance metrics'));
    expect(isOn('Error reports')).toBe(true);
    expect(isOn('Performance metrics')).toBe(true);

    await user.click(finish());

    expect(api.saves).toEqual([{ errorReports: true, nativeCrashReports: true, performance: true, analytics: true }]);
    await waitFor(() => { expect(onDone).toHaveBeenCalledOnce(); });
    // One save per click: the button stays locked once pressed.
    expect(finish().disabled).toBe(true);
  });

  it('still moves on when the save fails, so onboarding never gets stuck', async () => {
    const api = new PrefsApi();
    api.saveOutcome = () => Promise.reject(new Error('disk full'));
    const onDone = vi.fn();
    const user = renderStep(api, onDone);
    await waitFor(() => { expect(finish().disabled).toBe(false); });

    await user.click(finish());

    await waitFor(() => { expect(onDone).toHaveBeenCalledOnce(); });
    expect(api.saves).toEqual([ALL_OFF]);
  });

  describe('when the saved preferences could not be read', () => {
    it('re-reads them at Finish and keeps every channel as saved, ignoring the default switches', async () => {
      const api = new PrefsApi();
      const saved: TelemetryPreferences = { errorReports: true, nativeCrashReports: true, performance: false, analytics: false };
      api.reads = [new Error('ipc down'), saved];
      const onDone = vi.fn();
      const user = renderStep(api, onDone);
      // Finish unlocks anyway — telemetry must never block onboarding.
      await waitFor(() => { expect(finish().disabled).toBe(false); });
      expect(isOn('Error reports')).toBe(false);
      await user.click(toggle('Performance metrics'));

      await user.click(finish());

      await waitFor(() => { expect(onDone).toHaveBeenCalledOnce(); });
      expect(api.saves).toEqual([saved]);
    });

    it('saves everything off when the re-read fails too', async () => {
      const api = new PrefsApi();
      api.reads = [new Error('ipc down')];
      const onDone = vi.fn();
      const user = renderStep(api, onDone);
      await waitFor(() => { expect(finish().disabled).toBe(false); });
      await user.click(toggle('Error reports'));

      await user.click(finish());

      await waitFor(() => { expect(onDone).toHaveBeenCalledOnce(); });
      expect(api.saves).toEqual([ALL_OFF]);
    });
  });
});
