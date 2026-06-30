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

function setup(api: SsoApi) {
  render(
    <CostApiProvider value={api}>
      <SsoLoginButton profile="prod" />
    </CostApiProvider>,
  );
  return { button: screen.getByRole('button') };
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
});
