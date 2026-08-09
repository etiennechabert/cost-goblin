import { render, screen, act, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CoinRainLoader, COIN_SIZE, coinRandom } from '../components/coin-rain-loader.js';
import { setReducedMotion } from './setup.js';

const HEIGHT = 200;
/** jsdom performs no layout, so a container measures 0 wide and every coin
 *  would collapse to x=0 — which silently left horizontal placement untested.
 *  Stub a realistic width so the x clamp is exercised like the y one. */
const WIDTH = 400;
/** Enough coins that a broken clamp is caught reliably rather than ~40% of the
 *  time: placement draws from an arbitrary point in the shared PRNG stream, so
 *  a handful of samples is a coin flip, not a bound. */
const COUNT = 40;

function withWidth(width: number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: width });
  return () => {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
    else Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
  };
}

function coins(): HTMLElement[] {
  return screen.getAllByText('$');
}

/** Painted extent of a coin along one axis. `scale()` is centre-origin on a
 *  COIN_SIZE box, so the disc is NOT `offset … offset + COIN_SIZE * scale`. */
function paintedSpan(coin: HTMLElement, axis: 'top' | 'left'): { start: number; end: number } {
  const offset = Number.parseFloat(coin.style[axis]);
  const scale = Number.parseFloat(coin.style.transform.replace(/^.*scale\(([\d.]+)\).*$/, '$1'));
  const centre = offset + COIN_SIZE / 2;
  const half = (COIN_SIZE * scale) / 2;
  return { start: centre - half, end: centre + half };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CoinRainLoader', () => {
  it('animates by default — the preference most users have', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    expect(raf).toHaveBeenCalled();
    // Coins fall in, so they start above the container and are invisible until
    // the loop moves them. Exactly what the reduced-motion path must not do.
    for (const coin of coins()) {
      expect(Number.parseFloat(coin.style.top)).toBeLessThanOrEqual(-COIN_SIZE);
    }
  });

  it('renders a static scatter fully inside the box under reduced motion', () => {
    setReducedMotion(true);
    const restoreWidth = withWidth(WIDTH);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    try {
      render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

      expect(coins()).toHaveLength(COUNT);
      expect(raf).not.toHaveBeenCalled();

      // Asserts the PAINTED disc, not the layout offset. Clamping against
      // `COIN_SIZE * scale` looks right but lets every coin under 1x hang past
      // the edge, where `overflow-hidden` slices it — the empty-loader bug the
      // static path exists to avoid.
      for (const coin of coins()) {
        const vertical = paintedSpan(coin, 'top');
        expect(vertical.start).toBeGreaterThanOrEqual(0);
        expect(vertical.end).toBeLessThanOrEqual(HEIGHT);
        const horizontal = paintedSpan(coin, 'left');
        expect(horizontal.start).toBeGreaterThanOrEqual(0);
        expect(horizontal.end).toBeLessThanOrEqual(WIDTH);
      }

      // Spread across the box, not stacked in a column at the left edge.
      const lefts = new Set(coins().map(c => c.style.left));
      expect(lefts.size).toBeGreaterThan(1);
    } finally {
      restoreWidth();
    }
  });

  it('keeps the worst-case static coin inside the box', () => {
    // Placement is random, so sampling it only catches a bad clamp some of the
    // time. Pin the worst corner instead: the smallest scale (largest gap
    // between the layout box and the painted disc) at the largest offset.
    // The random source is consumed as scale, then x, then y.
    vi.spyOn(coinRandom, 'next').mockReturnValueOnce(0).mockReturnValue(0.999999);
    setReducedMotion(true);
    const restoreWidth = withWidth(WIDTH);
    try {
      render(<CoinRainLoader height={HEIGHT} count={1} />);
      const coin = coins()[0];
      expect(coin).toBeDefined();
      if (coin === undefined) return;

      expect(paintedSpan(coin, 'top').end).toBeLessThanOrEqual(HEIGHT);
      expect(paintedSpan(coin, 'left').end).toBeLessThanOrEqual(WIDTH);
    } finally {
      restoreWidth();
    }
  });

  it('parks static coins front-on, not showing the mirrored back face', () => {
    setReducedMotion(true);
    render(<CoinRainLoader height={HEIGHT} count={4} />);

    // Every angle in the animation range is past 90deg — the back face — which
    // reads as a spin while tumbling but freezes into a backwards `$`.
    for (const coin of coins()) {
      expect(coin.style.transform).toContain('rotateY(0deg)');
    }
  });

  it('stops animating when the preference flips mid-render', () => {
    render(<CoinRainLoader height={HEIGHT} count={4} />);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');

    act(() => { setReducedMotion(true); });

    // Subscribed, not sampled at mount: the running loop is torn down and the
    // coins re-seed into view rather than waiting for a remount.
    expect(cancel).toHaveBeenCalled();
    for (const coin of coins()) {
      expect(Number.parseFloat(coin.style.top)).toBeGreaterThanOrEqual(0);
    }
  });

  it('announces itself as a status region without reading out the coins', () => {
    render(<CoinRainLoader height={HEIGHT} count={4} />);

    // role="status" is a polite live region, so what gets spoken is its text —
    // not its label. It needs a real text node, and the decorative glyphs must
    // be hidden, or a loading dashboard announces "dollar dollar dollar" per
    // widget. (textContent is asserted via the two halves rather than directly:
    // it reports aria-hidden subtrees, which is exactly what a reader skips.)
    const status = screen.getByRole('status');
    expect(within(status).getByText('Loading')).toBeDefined();
    for (const coin of coins()) {
      expect(coin.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('does not schedule frames when there are no coins to move', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CoinRainLoader height={HEIGHT} count={0} />);

    // An empty array still yields a fresh array each tick, so React would never
    // bail out and the loop would re-render forever with nothing on screen.
    expect(raf).not.toHaveBeenCalled();
  });
});
