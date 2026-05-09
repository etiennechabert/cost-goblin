import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { AnomalyBadge } from '../components/anomaly-badge.js';

afterEach(cleanup);

describe('AnomalyBadge', () => {
  it('renders with high severity', () => {
    render(<AnomalyBadge severity="high" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('!');
    expect(badge.className).toContain('bg-negative');
  });

  it('renders with medium severity', () => {
    render(<AnomalyBadge severity="medium" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-orange-500');
  });

  it('renders with low severity', () => {
    render(<AnomalyBadge severity="low" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-yellow-500');
  });

  it('displays count when provided', () => {
    render(<AnomalyBadge severity="high" count={3} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('3');
  });

  it('displays zero count', () => {
    render(<AnomalyBadge severity="medium" count={0} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('0');
  });

  it('displays exclamation mark when count is undefined', () => {
    render(<AnomalyBadge severity="high" />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('!');
  });

  it('renders custom children when provided', () => {
    render(<AnomalyBadge severity="high">Custom Text</AnomalyBadge>);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('Custom Text');
  });

  it('custom children override count', () => {
    render(
      <AnomalyBadge severity="high" count={5}>
        Override
      </AnomalyBadge>,
    );
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('Override');
  });

  it('sets correct aria-label without count', () => {
    render(<AnomalyBadge severity="high" />);
    const badge = screen.getByRole('status');
    expect(badge.getAttribute('aria-label')).toBe('high severity anomaly');
  });

  it('sets correct aria-label with count', () => {
    render(<AnomalyBadge severity="medium" count={7} />);
    const badge = screen.getByRole('status');
    expect(badge.getAttribute('aria-label')).toBe('medium severity anomaly: 7 detected');
  });

  it('merges custom className with variant styles', () => {
    render(<AnomalyBadge severity="low" className="custom-class" />);
    const badge = screen.getByRole('status');
    expect(badge.className).toContain('custom-class');
    expect(badge.className).toContain('bg-yellow-500');
  });

  it('forwards ref to the div element', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(<AnomalyBadge ref={ref} severity="high" />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('spreads additional HTML attributes', () => {
    render(<AnomalyBadge severity="high" data-testid="custom-badge" />);
    const badge = screen.getByTestId('custom-badge');
    expect(badge).toBeDefined();
  });
});
