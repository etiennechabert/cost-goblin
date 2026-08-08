import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { RetryButton, SsoLoginButton } from '../components/sso-login-button.js';

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

// The 30s launch lock is keyed by profile and deliberately lives at module
// scope so it survives the remount its own Retry causes (see `launchedAt`).
// That makes it shared across tests too, so each test that launches a login
// uses its own profile rather than resetting global state.
let nextProfile = 0;
function uniqueProfile(): string {
  nextProfile += 1;
  return `prof-${String(nextProfile)}`;
}

function setup(api: SsoApi, onRetry: () => void | Promise<void> = vi.fn(), profile = uniqueProfile()) {
  const view = render(
    <CostApiProvider value={api}>
      <SsoLoginButton profile={profile} onRetry={onRetry} />
    </CostApiProvider>,
  );
  return { view, profile, api, onRetry };
}

function loginButton(): HTMLButtonElement {
  const el = screen.getByRole('button', { name: /SSO Login/ });
  if (!(el instanceof HTMLButtonElement)) throw new Error('login button missing');
  return el;
}

/** The retry button, matched on its accessible name rather than a substring —
 *  `toContain('Retry')` also matches "Retrying…", which made the label
 *  assertions pass no matter what the button said. */
function retryButton(): HTMLButtonElement | null {
  const found = screen.queryAllByRole('button')
    .find(b => b.getAttribute('title') === 'Re-run the check that failed');
  return found instanceof HTMLButtonElement ? found : null;
}

function retryLabel(): string {
  return retryButton()?.textContent.trim() ?? '';
}

describe('SsoLoginButton', () => {
  it('shows progress feedback, locks the button, and swallows repeat clicks until the lock expires', async () => {
    vi.useFakeTimers();
    let startLogin!: () => void;
    const api = new SsoApi();
    api.result = new Promise<void>((resolve) => { startLogin = resolve; });
    setup(api);

    expect(loginButton().textContent).toContain('Open SSO Login');
    expect(loginButton().disabled).toBe(false);

    await act(async () => { loginButton().click(); await Promise.resolve(); });
    expect(api.calls).toBe(1);
    expect(loginButton().disabled).toBe(true);
    expect(loginButton().textContent).toContain('Opening SSO Login');

    // Impatient repeat clicks during the multi-second spawn must not spawn
    // more SSO tabs. What enforces that is `disabled` — the `if (busy) return`
    // in the handler is unreachable from the DOM (neither `.click()` nor
    // `fireEvent` dispatches to a disabled control), so this asserts the
    // user-visible contract, not the early return.
    await act(async () => { fireEvent.click(loginButton()); await Promise.resolve(); });
    expect(api.calls).toBe(1);

    // Spawn resolved — the browser is now opening, and the lock starts here.
    await act(async () => { startLogin(); await Promise.resolve(); });
    expect(loginButton().disabled).toBe(true);

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(loginButton().disabled).toBe(false);
    expect(loginButton().textContent).toContain('Open SSO Login');
  });

  // Regression: the lock used to live in component state, but every caller's
  // onRetry clears the error that renders this panel — so pressing Retry
  // unmounted the button and reset the lock, letting a second `aws sso login`
  // (and a second consent tab) fire seconds after the first.
  it('keeps the launch lock across a remount', async () => {
    vi.useFakeTimers();
    const api = new SsoApi();
    const profile = uniqueProfile();
    const { view } = setup(api, vi.fn(), profile);

    await act(async () => { loginButton().click(); await Promise.resolve(); });
    expect(api.calls).toBe(1);
    expect(loginButton().disabled).toBe(true);

    // Exactly what a retry does to this subtree.
    view.unmount();
    render(
      <CostApiProvider value={api}>
        <SsoLoginButton profile={profile} onRetry={vi.fn()} />
      </CostApiProvider>,
    );

    expect(loginButton().disabled).toBe(true);
    await act(async () => { fireEvent.click(loginButton()); await Promise.resolve(); });
    expect(api.calls).toBe(1);

    // …and it still releases on schedule.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(loginButton().disabled).toBe(false);
  });

  it('keeps the retry available when the CLI is missing', async () => {
    const api = new SsoApi();
    api.result = Promise.reject(new Error('AWS_CLI_NOT_FOUND'));
    const onRetry = vi.fn();
    setup(api, onRetry);

    await act(async () => { loginButton().click(); await Promise.resolve(); });

    // The login button has nothing left to run, but installing the CLI is
    // itself a leave-and-come-back action, so the retry must survive.
    expect(screen.queryByRole('button', { name: /SSO Login/ })).toBeNull();
    expect(screen.getByText(/Install the AWS CLI/i)).toBeDefined();
    await act(async () => { retryButton()?.click(); await Promise.resolve(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not claim the user signed in when the login never launched', async () => {
    const api = new SsoApi();
    api.result = Promise.reject(new Error('spawn aws EACCES'));
    setup(api);

    await act(async () => { loginButton().click(); await Promise.resolve(); });

    // No browser opened, so no lock and no "I've signed in".
    expect(loginButton().disabled).toBe(false);
    expect(retryLabel()).toBe('Retry');
  });

  it('relabels the retry once a login has actually launched', async () => {
    const api = new SsoApi();
    setup(api);

    expect(retryLabel()).toBe('Retry');
    await act(async () => { loginButton().click(); await Promise.resolve(); });
    expect(retryLabel()).toBe("I've signed in — Retry");
  });
});

describe('RetryButton', () => {
  it('runs the retry and locks itself while the re-fetch is in flight', async () => {
    let finish!: () => void;
    const onRetry = vi.fn<() => Promise<void>>()
      .mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<RetryButton onRetry={onRetry} />);

    await act(async () => { retryButton()?.click(); await Promise.resolve(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton()?.disabled).toBe(true);
    expect(retryLabel()).toBe('Retrying…');

    // Inert while in flight. As above, `disabled` is what enforces this; the
    // handler's `if (retrying) return` is belt-and-braces for a programmatic
    // caller and cannot be reached by any DOM event.
    await act(async () => { fireEvent.click(retryButton() as HTMLButtonElement); await Promise.resolve(); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); await Promise.resolve(); });
    expect(retryButton()?.disabled).toBe(false);
    expect(retryLabel()).toBe('Retry');
  });

  it('unlocks when the retry rejects', async () => {
    const onRetry = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('still expired'));
    render(<RetryButton onRetry={onRetry} />);

    await act(async () => { retryButton()?.click(); await Promise.resolve(); });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton()?.disabled).toBe(false);
    expect(retryLabel()).toBe('Retry');
  });

  it('unlocks when the retry throws synchronously', async () => {
    const onRetry = vi.fn(() => { throw new Error('bridge gone'); });
    render(<RetryButton onRetry={onRetry} />);

    await act(async () => { retryButton()?.click(); await Promise.resolve(); });

    // Without the try/catch this sat disabled on "Retrying…" forever — the
    // one affordance the panel has, permanently dead.
    expect(retryButton()?.disabled).toBe(false);
    expect(retryLabel()).toBe('Retry');
  });
});
