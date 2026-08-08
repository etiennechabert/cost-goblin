import { render, screen, cleanup, act } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SsoLoginButton } from '../components/sso-login-button.js';

class SsoApi extends MockCostApi {
  calls = 0;
  result: Promise<void> = Promise.resolve();
  override ssoLogin(): Promise<void> {
    this.calls += 1;
    return this.result;
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(api: SsoApi, onRetry?: () => void | Promise<void>) {
  render(
    <CostApiProvider value={api}>
      <SsoLoginButton profile="prod" onRetry={onRetry} />
    </CostApiProvider>,
  );
  return { button: screen.getByRole('button', { name: /SSO Login/ }) };
}

function retryButton(): HTMLButtonElement | null {
  const found = screen.queryAllByRole('button')
    .find(b => /Retry/.test(b.textContent));
  return found instanceof HTMLButtonElement ? found : null;
}

describe('SsoLoginButton', () => {
  it('shows progress feedback, locks the button, and swallows repeat clicks until the lock expires', async () => {
    vi.useFakeTimers();
    let startLogin!: () => void;
    const api = new SsoApi();
    api.result = new Promise<void>((resolve) => { startLogin = resolve; });
    const { button } = setup(api);

    expect(button.textContent).toContain('Open SSO Login');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { button.click(); await Promise.resolve(); });
    expect(api.calls).toBe(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain('Opening SSO Login');

    // Impatient repeat clicks during the multi-second open must not spawn more SSO tabs.
    await act(async () => { button.click(); button.click(); await Promise.resolve(); });
    expect(api.calls).toBe(1);

    // Browser is now opening (promise resolved) — button stays locked.
    await act(async () => { startLogin(); await Promise.resolve(); });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    // Lock expires after 30s → usable again.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toContain('Open SSO Login');
  });

  it('unlocks immediately when the login fails to start', async () => {
    const api = new SsoApi();
    api.result = Promise.reject(new Error('AWS_CLI_NOT_FOUND'));
    const { button } = setup(api);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    // CLI missing → button is replaced by the install hint, not left spinning.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Install the AWS CLI/i)).toBeDefined();
  });

  // Without this the panel is a dead end: `aws sso login` resolves the moment
  // the browser opens, so nothing in the renderer ever learns the sign-in
  // finished and the expired-credentials error sits there until the view is
  // remounted (or the app restarted).
  it('offers no retry affordance when the caller wires none', () => {
    setup(new SsoApi());
    expect(retryButton()).toBeNull();
    expect(screen.getByText(/Refresh this page after logging in/)).toBeDefined();
  });

  it('runs the caller-supplied retry and points the hint at it', async () => {
    const onRetry = vi.fn<() => Promise<void>>();
    let finishRetry!: () => void;
    onRetry.mockReturnValue(new Promise<void>((resolve) => { finishRetry = resolve; }));
    setup(new SsoApi(), onRetry);

    expect(screen.getByText(/come back here and hit Retry/)).toBeDefined();
    const retry = retryButton();
    expect(retry?.textContent).toContain('Retry');

    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Locked while the re-fetch is in flight, so an impatient double-click
    // can't queue a second one.
    expect(retryButton()?.disabled).toBe(true);
    expect(retryButton()?.textContent).toContain('Retrying');
    await act(async () => { retry?.click(); await Promise.resolve(); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => { finishRetry(); await Promise.resolve(); });
    expect(retryButton()?.disabled).toBe(false);
  });

  it('unlocks the retry button when the retry itself rejects', async () => {
    const onRetry = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('still expired'));
    setup(new SsoApi(), onRetry);

    await act(async () => { retryButton()?.click(); await Promise.resolve(); });

    expect(retryButton()?.disabled).toBe(false);
    expect(retryButton()?.textContent).toContain('Retry');
  });

  it('relabels the retry once the login has been launched', async () => {
    const api = new SsoApi();
    const { button } = setup(api, vi.fn());

    expect(retryButton()?.textContent.trim()).toBe('Retry');
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(retryButton()?.textContent).toContain("I've signed in");
  });
});
