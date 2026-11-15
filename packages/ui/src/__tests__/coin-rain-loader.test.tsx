import { Profiler } from 'react';
import { render, screen, act, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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

interface StartedAnimation {
  readonly target: Element;
  readonly keyframes: readonly Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly cancel: ReturnType<typeof vi.fn>;
}

/** jsdom has no Web Animations API. Install one that records what every coin
 *  was asked to do, so the tests read the motion the compositor would run. */
function installAnimate(): { readonly started: StartedAnimation[]; readonly restore: () => void } {
  const started: StartedAnimation[] = [];
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, keyframes: readonly Keyframe[], options: KeyframeAnimationOptions) {
      const cancel = vi.fn();
      started.push({ target: this, keyframes, options, cancel });
      return { cancel };
    },
  });
  return {
    started,
    restore: () => {
      if (original === undefined) Reflect.deleteProperty(Element.prototype, 'animate');
      else Object.defineProperty(Element.prototype, 'animate', original);
    },
  };
}

function coins(): HTMLElement[] {
  return screen.getAllByText('$');
}

/** Painted extent of a disc along one axis. `scale()` is centre-origin on a
 *  COIN_SIZE box, so the disc is NOT `offset … offset + COIN_SIZE * scale`. */
function discSpan(offset: number, scale: number): { start: number; end: number } {
  const centre = offset + COIN_SIZE / 2;
  const half = (COIN_SIZE * scale) / 2;
  return { start: centre - half, end: centre + half };
}

/** Painted extent of a static coin, which is placed with `top` / `left`. */
function paintedSpan(coin: HTMLElement, axis: 'top' | 'left'): { start: number; end: number } {
  const offset = Number.parseFloat(coin.style[axis]);
  const scale = Number.parseFloat(coin.style.transform.replace(/^.*scale\(([\d.]+)\).*$/, '$1'));
  return discSpan(offset, scale);
}

interface CoinPose { readonly x: number; readonly y: number; readonly rotation: number; readonly scale: number }

/** A falling coin is placed by its transform alone. */
function parsePose(transform: unknown): CoinPose {
  const match = typeof transform === 'string'
    ? /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) rotateY\((-?[\d.]+)deg\) scale\(([\d.]+)\)$/.exec(transform)
    : null;
  if (match === null) throw new Error(`not a coin transform: ${String(transform)}`);
  return { x: Number(match[1]), y: Number(match[2]), rotation: Number(match[3]), scale: Number(match[4]) };
}

function poses(animation: StartedAnimation): CoinPose[] {
  return animation.keyframes.map(keyframe => parsePose(keyframe['transform']));
}

/** A cycle is a run of falls: keyframes come in (start, end) pairs. */
function falls(animation: StartedAnimation): { start: CoinPose; end: CoinPose; easing: unknown }[] {
  const all = poses(animation);
  const out: { start: CoinPose; end: CoinPose; easing: unknown }[] = [];
  for (let i = 0; i + 1 < all.length; i += 2) {
    const start = all[i];
    const end = all[i + 1];
    if (start === undefined || end === undefined) break;
    out.push({ start, end, easing: animation.keyframes[i]?.easing });
  }
  return out;
}

describe('CoinRainLoader', () => {
  let animations: ReturnType<typeof installAnimate>;

  beforeEach(() => {
    animations = installAnimate();
  });

  afterEach(() => {
    animations.restore();
    vi.restoreAllMocks();
  });

  it('animates by default — the preference most users have', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    // One animation per coin, and it never ends: the loader is on screen for as
    // long as the query takes.
    expect(animations.started).toHaveLength(COUNT);
    expect(new Set(animations.started.map(a => a.target))).toEqual(new Set(coins()));
    for (const { options } of animations.started) {
      expect(options.iterations).toBe(Number.POSITIVE_INFINITY);
      expect(options.duration).toBeGreaterThan(0);
    }
  });

  it('moves the coins with their transform alone, so the compositor can run them', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    // A transform-only animation runs off the main thread. Animating `top` or
    // `left` does not: every frame then re-layerizes the whole page there — 13
    // of every 16 ms on a large dashboard, which left React no time to render
    // the results the loader was waiting for.
    for (const { keyframes } of animations.started) {
      expect(keyframes.length).toBeGreaterThan(0);
      for (const keyframe of keyframes) {
        expect(Object.keys(keyframe).sort((a, b) => a.localeCompare(b))).toEqual(['easing', 'offset', 'transform']);
      }
    }
    for (const coin of coins()) {
      expect(coin.style.top).toBe('0px');
      expect(coin.style.left).toBe('0px');
    }
  });

  it('asks for no animation frame and renders nothing more while it animates', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const onRender = vi.fn();
    render(
      <Profiler id="loader" onRender={onRender}>
        <CoinRainLoader height={HEIGHT} count={COUNT} />
      </Profiler>,
    );
    const commitsAfterMount = onRender.mock.calls.length;

    // Several 60 Hz frames. A state update per frame is an urgent render per
    // frame, and each one sends a pending transition — a query result — back to
    // the end of the queue.
    await new Promise<void>((resolve) => { setTimeout(resolve, 120); });

    expect(raf).not.toHaveBeenCalled();
    expect(onRender.mock.calls).toHaveLength(commitsAfterMount);
  });

  it('starts and ends every fall out of sight, and stays inside the box sideways', () => {
    const restoreWidth = withWidth(WIDTH);
    try {
      render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

      expect(animations.started).toHaveLength(COUNT);
      for (const animation of animations.started) {
        const cycle = falls(animation);
        expect(cycle.length).toBeGreaterThan(1);
        for (const { start, end } of cycle) {
          // The painted disc, not the layout box: the jump from the end of one
          // fall to the start of the next must not show.
          expect(discSpan(start.y, start.scale).end).toBeLessThanOrEqual(0);
          expect(discSpan(end.y, end.scale).start).toBeGreaterThanOrEqual(HEIGHT);
          for (const pose of [start, end]) {
            const horizontal = discSpan(pose.x, pose.scale);
            expect(horizontal.start).toBeGreaterThanOrEqual(0);
            expect(horizontal.end).toBeLessThanOrEqual(WIDTH);
          }
        }
        // Falls land in different lanes: a coin does not retrace one column.
        expect(new Set(cycle.map(fall => fall.start.x)).size).toBeGreaterThan(1);
      }
    } finally {
      restoreWidth();
    }
  });

  it('runs the falls of a cycle back to back, from 0 to 1', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    expect(animations.started).toHaveLength(COUNT);
    for (const { keyframes } of animations.started) {
      const offsets = keyframes.map(keyframe => keyframe.offset);
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(1);
      for (let i = 1; i < offsets.length; i++) {
        const previous = offsets[i - 1];
        const current = offsets[i];
        expect(typeof previous).toBe('number');
        expect(typeof current).toBe('number');
        if (typeof previous !== 'number' || typeof current !== 'number') continue;
        // A fall takes time; the jump back to the top takes none.
        if (i % 2 === 1) expect(current).toBeGreaterThan(previous);
        else expect(current).toBe(previous);
      }
    }
  });

  it('tumbles each coin between its two edge-on angles without a jump', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    expect(animations.started).toHaveLength(COUNT);
    for (const animation of animations.started) {
      const cycle = falls(animation);
      expect(cycle.length).toBeGreaterThan(1);
      for (const [i, { start, end }] of cycle.entries()) {
        // Every fall turns the coin over once, through its back face, and the
        // next one turns it back from where this one left it.
        expect([start.rotation, end.rotation].sort((a, b) => a - b)).toEqual([90, 270]);
        const next = cycle[(i + 1) % cycle.length];
        expect(next?.start.rotation).toBe(end.rotation);
        expect(end.scale).toBe(start.scale);
      }
    }
  });

  it('falls faster the further it has fallen, and takes longer to cross a taller box', () => {
    // Pin the draws: every coin gets the same scale, height above the box and lane.
    vi.spyOn(coinRandom, 'next').mockReturnValue(0.5);
    render(<CoinRainLoader height={100} count={1} />);
    render(<CoinRainLoader height={400} count={1} />);

    const [short, tall] = animations.started;
    expect(short).toBeDefined();
    expect(tall).toBeDefined();
    if (short === undefined || tall === undefined) return;
    expect(Number(tall.options.duration)).toBeGreaterThan(Number(short.options.duration));

    for (const { easing } of [...falls(short), ...falls(tall)]) {
      const curve = typeof easing === 'string' ? /^cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)$/.exec(easing) : null;
      expect(curve).not.toBeNull();
      if (curve === null) continue;
      const [x1, y1, x2, y2] = [Number(curve[1]), Number(curve[2]), Number(curve[3]), Number(curve[4])];
      // Below the diagonal at both control points: it accelerates all the way down.
      expect(y1).toBeLessThan(x1);
      expect(y2).toBeLessThan(x2);
    }
  });

  it('parks each coin above the box until its animation takes over', () => {
    render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

    // Coins fall in, so they start above the container. Exactly what the
    // reduced-motion path must not do.
    expect(animations.started).toHaveLength(COUNT);
    for (const animation of animations.started) {
      const target = animation.target;
      expect(target).toBeInstanceOf(HTMLElement);
      if (!(target instanceof HTMLElement)) continue;
      expect(target.style.transform).toBe(animation.keyframes[0]?.['transform']);
      const parked = parsePose(target.style.transform);
      expect(discSpan(parked.y, parked.scale).end).toBeLessThanOrEqual(0);
    }
  });

  it('renders a static scatter fully inside the box under reduced motion', () => {
    setReducedMotion(true);
    const restoreWidth = withWidth(WIDTH);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    try {
      render(<CoinRainLoader height={HEIGHT} count={COUNT} />);

      expect(coins()).toHaveLength(COUNT);
      expect(animations.started).toHaveLength(0);
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
    expect(animations.started).toHaveLength(4);

    act(() => { setReducedMotion(true); });

    // Subscribed, not sampled at mount: the running animations are cancelled
    // and the coins re-seed into view rather than waiting for a remount.
    for (const { cancel } of animations.started) expect(cancel).toHaveBeenCalledTimes(1);
    expect(animations.started).toHaveLength(4);
    for (const coin of coins()) {
      expect(Number.parseFloat(coin.style.top)).toBeGreaterThanOrEqual(0);
    }
  });

  it('cancels its animations when the loader goes away', () => {
    const { unmount } = render(<CoinRainLoader height={HEIGHT} count={4} />);

    unmount();

    expect(animations.started).toHaveLength(4);
    for (const { cancel } of animations.started) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('still renders its coins where Web Animations are missing', () => {
    animations.restore();

    render(<CoinRainLoader height={HEIGHT} count={4} />);

    expect(coins()).toHaveLength(4);
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

  it('starts nothing when there are no coins to move', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CoinRainLoader height={HEIGHT} count={0} />);

    expect(animations.started).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
  });
});
