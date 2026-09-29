import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { McpView } from '../views/mcp-view.js';

const MOCK_TOKEN = 'mock-token-abc123';
const PROVIDERS = ['Claude / Cursor / Windsurf', 'Gemini CLI'];
const HIDDEN_HINT = 'Token hidden. Copy includes it, or click Reveal above.';

function renderView(api: MockCostApi) {
  return render(<CostApiProvider value={api}><McpView /></CostApiProvider>);
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** Open one provider's snippet (the view shows one at a time). The provider
 *  names hold no RegExp metacharacters. */
async function expand(user: ReturnType<typeof userEvent.setup>, provider: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${provider}`), expanded: false }));
}

describe('McpView — server opt-in', () => {
  it('shows "Checking…" with the toggle disabled until the state resolves, never "running"', () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getMcpServerRunning').mockReturnValue(never());
    renderView(api);
    expect(screen.getByText('Checking…')).toBeDefined();
    expect(screen.queryByText('MCP server running')).toBeNull();
    expect(screen.queryByText('MCP server stopped')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', true);
  });

  it('is stopped by default and explains the opt-in', async () => {
    renderView(new MockCostApi());
    expect(await screen.findByText('MCP server stopped')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Off by default. Once enabled, the server starts automatically each time CostGoblin launches.')).toBeDefined();
  });

  it('shows stopped when the state query fails', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getMcpServerRunning').mockRejectedValue(new Error('ipc down'));
    renderView(api);
    expect(await screen.findByText('MCP server stopped')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', false);
  });

  it('Enable calls setMcpServerRunning(true), then Disable calls it with false', async () => {
    const api = new MockCostApi();
    const setSpy = vi.spyOn(api, 'setMcpServerRunning');
    const user = userEvent.setup();
    renderView(api);

    await user.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(setSpy).toHaveBeenLastCalledWith(true);
    expect(await screen.findByText('MCP server running')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Disable' }));
    expect(setSpy).toHaveBeenLastCalledWith(false);
    expect(await screen.findByText('MCP server stopped')).toBeDefined();
  });

  it('a rejected toggle shows the error, re-queries the state and re-enables the button', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'setMcpServerRunning').mockRejectedValue(new Error('listen EADDRINUSE 127.0.0.1:19532'));
    const getSpy = vi.spyOn(api, 'getMcpServerRunning');
    const user = userEvent.setup();
    renderView(api);

    await user.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText(/EADDRINUSE/)).toBeDefined();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enable' })).toHaveProperty('disabled', false);
    });
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText('MCP server stopped')).toBeDefined();
  });
});

describe('McpView — token in snippets', () => {
  it.each(PROVIDERS)('masks the token in the %s snippet until Reveal, with no ?token= URL', async (provider) => {
    const user = userEvent.setup();
    const { container } = renderView(new MockCostApi());
    await screen.findByRole('button', { name: 'Copy token' });
    await expand(user, provider);

    expect(screen.getByRole('button', { name: `Copy ${provider} config` })).toBeDefined();
    const text = container.textContent;
    expect(text).not.toContain(MOCK_TOKEN);
    expect(text).not.toContain('?token=');
    expect(text).toContain('Bearer ••••');
    expect(screen.getByText(HIDDEN_HINT)).toBeDefined();
  });

  it('Copy puts the real config, token included, on the clipboard', async () => {
    const user = userEvent.setup();
    renderView(new MockCostApi());
    await screen.findByRole('button', { name: 'Copy token' });

    await expand(user, 'Claude / Cursor / Windsurf');
    await user.click(screen.getByRole('button', { name: 'Copy Claude / Cursor / Windsurf config' }));
    const claude = await navigator.clipboard.readText();
    expect(claude).toContain(`Bearer ${MOCK_TOKEN}`);
    expect(claude).not.toContain('•');

    await expand(user, 'Gemini CLI');
    await user.click(screen.getByRole('button', { name: 'Copy Gemini CLI config' }));
    const gemini: unknown = JSON.parse(await navigator.clipboard.readText());
    expect(gemini).toStrictEqual({
      mcpServers: {
        costgoblin: {
          httpUrl: 'http://localhost:19532/mcp',
          headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
        },
      },
    });
  });

  it('Reveal and Hide toggle the token field and the snippets together', async () => {
    const user = userEvent.setup();
    const { container } = renderView(new MockCostApi());
    await screen.findByRole('button', { name: 'Copy token' });
    await expand(user, 'Gemini CLI');

    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    // Once in the token field, once in the open snippet.
    await waitFor(() => {
      expect(container.textContent.split(MOCK_TOKEN)).toHaveLength(3);
    });
    expect(screen.queryByText(HIDDEN_HINT)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => {
      expect(container.textContent).not.toContain(MOCK_TOKEN);
    });
    expect(screen.getByText(HIDDEN_HINT)).toBeDefined();
  });

  it('shows no Copy button while the token is still loading', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getMcpToken').mockReturnValue(never());
    const user = userEvent.setup();
    renderView(api);
    await screen.findByText('MCP server stopped');
    await expand(user, 'Claude / Cursor / Windsurf');

    expect(screen.queryAllByRole('button', { name: /^Copy/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Reveal' })).toHaveProperty('disabled', true);
  });

  it('explains that cloud-hosted assistants cannot reach the loopback server', async () => {
    renderView(new MockCostApi());
    expect(await screen.findByText(/can.t reach this server/)).toBeDefined();
  });
});
