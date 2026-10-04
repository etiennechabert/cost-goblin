import { render, screen } from '@testing-library/react';
import { startTransition } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '../hooks/use-query.js';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, startTransition: vi.fn(actual.startTransition) };
});

// Each test counts calls on the shared spy; don't depend on the runner's
// clearMocks default to isolate them.
beforeEach(() => {
  vi.mocked(startTransition).mockClear();
});

function Probe({ urgent }: Readonly<{ urgent: boolean }>) {
  const query = useQuery(() => Promise.resolve('done'), [], urgent ? { urgent: true } : undefined);
  return <span>{query.status === 'success' ? query.data : query.status}</span>;
}

describe('useQuery', () => {
  it('applies a settled result as a transition by default', async () => {
    render(<Probe urgent={false} />);
    await screen.findByText('done');
    expect(vi.mocked(startTransition)).toHaveBeenCalled();
  });

  // Since React 19.3 each transition renders on its own, so a small result
  // the page waits on (a view's filter dimensions) could queue for seconds
  // behind a burst of widget renders on a loaded machine.
  it('applies a settled result urgently when asked to', async () => {
    render(<Probe urgent />);
    await screen.findByText('done');
    expect(vi.mocked(startTransition)).not.toHaveBeenCalled();
  });
});
