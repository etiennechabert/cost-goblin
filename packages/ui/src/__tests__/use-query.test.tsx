import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core/browser';
import { useQuery } from '../hooks/use-query.js';

// A query whose run for deps `n` is cancelled `cancels.get(n)` times before it
// succeeds. Clicking the button moves to the next deps.
function CancelledProbe({ cancels }: Readonly<{ cancels: Map<number, number> }>): React.JSX.Element {
  const [n, setN] = useState(0);
  const q = useQuery(() => {
    const left = cancels.get(n) ?? 0;
    if (left > 0) {
      cancels.set(n, left - 1);
      return Promise.reject(new Error(QUERY_CANCELLED_MESSAGE));
    }
    return Promise.resolve(`data-${String(n)}`);
  }, [n]);
  return <button type="button" onClick={() => { setN(v => v + 1); }}>{q.status === 'success' ? q.data : q.status}</button>;
}

describe('useQuery cancel-retries', () => {
  it('gives every new set of deps a fresh retry budget', async () => {
    // Views cancel in-flight queries on navigation and when Compare toggles. A
    // query that already used its retries must still retry the next time it's
    // cancelled, rather than failing on a budget spent on older deps.
    const user = userEvent.setup();
    render(<CancelledProbe cancels={new Map([[0, 2], [1, 1]])} />);
    await user.click(await screen.findByText('data-0'));
    expect(await screen.findByText('data-1')).toBeDefined();
  });

  it('gives up once one run exhausts its retries', async () => {
    render(<CancelledProbe cancels={new Map([[0, 3]])} />);
    expect(await screen.findByText('error')).toBeDefined();
  });
});
