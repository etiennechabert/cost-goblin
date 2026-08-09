import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { setReducedMotion } from './setup.js';

/** Rendered coin box, before the scale transform. Mirrors COIN_SIZE. */
const COIN_SIZE = 36;
/** Smallest scale createStaticCoin can pick — so the tightest bound the
 *  clamp must satisfy for every coin is `height - COIN_SIZE * 0.7`. */
const MIN_SCALE = 0.7;

const HEIGHT = 200;
const COUNT = 4;

function coinTops(): number[] {
  return screen.getAllByText('$').map(c => Number.parseFloat(c.style.top));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CoinRainLoader', () => {
  it('animates by default — the preference most users have', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    expect(raf).toHaveBeenCalled();
    // Coins fall in, so they start above the container and are invisible
    // until the loop moves them. This is what the reduced-motion path must
    // NOT do — see the static test below.
    for (const top of coinTops()) {
      expect(top).toBeLessThanOrEqual(-COIN_SIZE);
    }
  });

  it('renders a static, visible scatter under reduced motion', () => {
    setReducedMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    const coins = screen.getAllByText('$');
    expect(coins).toHaveLength(COUNT);
    expect(raf).not.toHaveBeenCalled();

    // Fully inside the box, not merely non-negative: a coin seeded at
    // `height` would be clipped away entirely by `overflow-hidden`, which is
    // the empty-loader bug the static path exists to avoid.
    for (const top of coinTops()) {
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(HEIGHT - COIN_SIZE * MIN_SCALE);
    }

    // Face-on, not at an oscillation endpoint. 90°/270° render the coin
    // edge-on — invisibly thin — and nothing advances rotation when the
    // animation never runs.
    for (const coin of coins) {
      expect(coin.style.transform).toContain('rotateY(180deg)');
    }

    // will-change pins a compositor layer per coin; pointless when the
    // transform is never rewritten.
    expect(coins[0]?.style.willChange).toBe('');
  });

  it('stops animating when the preference flips mid-render', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');

    act(() => { setReducedMotion(true); });

    // Subscribed, not sampled at mount: the running loop is torn down and the
    // coins re-seed into view rather than waiting for a remount.
    expect(cancel).toHaveBeenCalled();
    for (const top of coinTops()) {
      expect(top).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes the loading state to assistive tech in both modes', () => {
    const { unmount } = render(<CoinRainLoader height={HEIGHT} count={COUNT} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
    unmount();

    setReducedMotion(true);
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
  });
});
