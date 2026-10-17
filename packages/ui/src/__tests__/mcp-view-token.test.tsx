import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { McpView } from '../views/mcp-view.js';

const MASK = '•'.repeat(28);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderView(api: MockCostApi) {
  const user = userEvent.setup();
  const view = render(<CostApiProvider value={api}><McpView /></CostApiProvider>);
  return { user, ...view };
}

/** The token field: the `<pre>` beside the Copy token button. */
function tokenField(): HTMLElement {
  const pre = screen.getByRole('button', { name: 'Copy token' }).parentElement?.querySelector('pre');
  if (!(pre instanceof HTMLElement)) throw new Error('token field missing');
  return pre;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('McpView — regenerating the token', () => {
  it('asks before regenerating, and Cancel leaves the token alone', async () => {
    const api = new MockCostApi();
    const regenerate = vi.spyOn(api, 'regenerateMcpToken');
    const { user } = renderView(api);
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    expect(screen.getByText('Existing clients will stop working until updated.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Existing clients will stop working until updated.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDefined();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('shows progress while regenerating, then reveals the new token', async () => {
    const api = new MockCostApi();
    const pending = deferred<string>();
    vi.spyOn(api, 'regenerateMcpToken').mockReturnValue(pending.promise);
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Copy token' });
    expect(tokenField().textContent).toBe(MASK);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: 'Regenerating…' })).toHaveProperty('disabled', true);

    await act(async () => { pending.resolve('fresh-token-789'); await Promise.resolve(); });
    // The new value is shown at once: every client has to be updated with it.
    await waitFor(() => { expect(tokenField().textContent).toBe('fresh-token-789'); });
    expect(screen.getByRole('button', { name: 'Hide' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDefined();
    expect(screen.queryByText('Existing clients will stop working until updated.')).toBeNull();
  });

  it('keeps the old token, still hidden, when regenerating fails', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'regenerateMcpToken').mockRejectedValue(new Error('keychain locked'));
    const { user } = renderView(api);
    await screen.findByRole('button', { name: 'Copy token' });
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDefined(); });
    expect(tokenField().textContent).toBe(MASK);
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeDefined();
  });
});

describe('McpView — server toggle and snippets', () => {
  it('shows a failed toggle whose reason is not an Error, and the state the main process reports', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'setMcpServerRunning').mockRejectedValue('port 19532 is taken');
    const running = vi.spyOn(api, 'getMcpServerRunning');
    running.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('ipc closed'));
    const { user } = renderView(api);

    await user.click(await screen.findByRole('button', { name: 'Enable' }));
    expect((await screen.findByRole('alert')).textContent).toBe('port 19532 is taken');
    // The re-query failed too: the view falls back to "stopped".
    await waitFor(() => { expect(running).toHaveBeenCalledTimes(2); });
    expect(screen.getByText('MCP server stopped')).toBeDefined();
  });

  it('shows the endpoint while running, and folds an open snippet shut again', async () => {
    const api = new MockCostApi();
    await api.setMcpServerRunning(true);
    const { user } = renderView(api);
    expect(await screen.findByText('MCP server running')).toBeDefined();
    expect(screen.getByText('http://localhost:19532/mcp')).toBeDefined();

    const header = screen.getByRole('button', { name: /^Gemini CLI/ });
    await user.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.textContent).toContain('Hide');
    await user.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('Show config');
    expect(screen.queryByText(/Add to ~\/\.gemini\/settings\.json/)).toBeNull();
  });
});
