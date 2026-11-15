import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useReducedMotion } from '../hooks/use-reduced-motion.js';

/** A coin of the reduced-motion scatter: placed once, never moved. */
interface StaticCoin {
  readonly kind: 'static';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** A coin of the rain: one endless animation of its transform. */
interface FallingCoin {
  readonly kind: 'falling';
  readonly id: number;
  /** Where the coin waits until the animation takes over: its first keyframe,
   *  out of sight above the box. */
  readonly parked: string;
  readonly keyframes: Keyframe[];
  readonly durationMs: number;
}

type Coin = StaticCoin | FallingCoin;

/** Layout size of a coin, before its centre-origin `scale` transform.
 *  Exported so tests compute painted extents from the real value rather than
 *  restating it. */
export const COIN_SIZE = 36;

// Rotation (rotateY) oscillates between 25% (90°) and 75% (270°) of a full
// turn. Each coin starts at one of the two endpoints at random and turns to
// the other over one fall, then back over the next. This keeps the coin
// hovering around its back-face view (180°) — a continuous 360° rotation
// would spend half its time with the coin fully side-on (invisibly thin).
const ROTATION_MIN = 90;
const ROTATION_MAX = 270;

// A coin enters at FALL_SPEED and accelerates at GRAVITY, in CSS pixels and
// seconds.
const FALL_SPEED = 22;
const GRAVITY = 122;
/** How far above the box a fall may start, as a share of the box's height, so
 *  the coins come in one after another rather than in a row. */
const HEADROOM = 0.6;
/** Furthest a coin drifts sideways over one fall, in pixels. */
const MAX_DRIFT = 40;
/** Falls in one cycle of a coin's animation. Each has its own lane, drift and
 *  height, so a coin is seen to retrace its path only after this many. */
const FALLS_PER_CYCLE = 4;

// Every angle in the oscillation range is past 90°, i.e. the coin's back face.
// While it tumbles that reads as a spin, but a frozen coin at 180° is simply a
// mirror image — backwards `$`, gradient highlight on the wrong side. 0° is
// the front face and projects to the same full width, so it is the angle to
// park a coin that will never move.
const ROTATION_FRONT_ON = 0;

const SCALE_MIN = 0.7;
const SCALE_RANGE = 0.5;

/** mulberry32 — a tiny seeded PRNG. The coins are pure decoration, so the
 *  randomness is deliberately non-cryptographic and deterministic. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shared random source for coin placement. An object so tests can pin
 *  worst-case draws by spying on `next`. */
export const coinRandom = { next: mulberry32(0x0c01_90b1) };

function randomScale(): number {
  return SCALE_MIN + coinRandom.next() * SCALE_RANGE;
}

/** Largest offset that keeps a scaled coin fully inside `extent`. `scale()` is
 *  centre-origin on a COIN_SIZE box, so the painted disc spans
 *  `offset + (COIN_SIZE ± COIN_SIZE * scale) / 2` — clamping against
 *  `COIN_SIZE * scale` alone would let every coin under 1× hang past the edge
 *  and get sliced by `overflow-hidden`. */
function maxStaticOffset(extent: number, scale: number): number {
  return extent - (COIN_SIZE + COIN_SIZE * scale) / 2;
}

/** Smallest offset that keeps a scaled coin fully inside the box — negative
 *  for coins scaled above 1×, whose disc overhangs the layout box. */
function minStaticOffset(scale: number): number {
  return (COIN_SIZE * scale - COIN_SIZE) / 2;
}

function staticOffset(extent: number, scale: number): number {
  const min = minStaticOffset(scale);
  const max = maxStaticOffset(extent, scale);
  // Degenerate container (jsdom reports offsetWidth 0, and real containers can
  // be narrower than one coin): centre what cannot fit rather than clamping to
  // an edge, so a too-small box still shows the coins.
  if (max <= min) return (extent - COIN_SIZE) / 2;
  return min + coinRandom.next() * (max - min);
}

/** A coin placed for the static (reduced-motion) render: inside the visible
 *  box rather than above it, and front-on rather than at an oscillation
 *  endpoint. Both matter — the animated spawn sits off-screen above the
 *  container and the endpoints are exactly edge-on, so a coin frozen with
 *  either would be invisible, which is the opposite of what a loading
 *  indicator is for. */
function createStaticCoin(id: number, containerWidth: number, containerHeight: number): StaticCoin {
  const scale = randomScale();
  return {
    kind: 'static',
    id,
    x: staticOffset(containerWidth, scale),
    y: staticOffset(containerHeight, scale),
    scale,
  };
}

/** Two decimals: sub-pixel precision, and never an exponent in a CSS value. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function coinTransform(x: number, y: number, rotation: number, scale: number): string {
  return `translate3d(${String(x)}px, ${String(y)}px, 0) rotateY(${String(rotation)}deg) scale(${String(scale)})`;
}

/** Seconds a coin takes to fall `distance` pixels. */
function fallSeconds(distance: number): number {
  return (Math.sqrt(FALL_SPEED * FALL_SPEED + 2 * GRAVITY * distance) - FALL_SPEED) / GRAVITY;
}

/** Timing function of that fall: constant acceleration from FALL_SPEED. A
 *  parabola is exactly a cubic Bézier whose control points sit at one and two
 *  thirds of the time, so this is the motion itself (to four decimals), not a
 *  likeness of it. */
function fallEasing(distance: number, seconds: number): string {
  // Share of the distance the entry speed alone would cover.
  const entry = (FALL_SPEED * seconds) / distance;
  const point = (value: number): string => value.toFixed(4);
  return `cubic-bezier(${point(1 / 3)}, ${point(entry / 3)}, ${point(2 / 3)}, ${point((1 + entry) / 3)})`;
}

/** A coin of the rain. Its whole motion is one animation of `transform`: a
 *  cycle of falls, each from out of sight above the box to out of sight below
 *  it, with an instant jump back up in between (two keyframes at one offset).
 *
 *  Nothing but `transform` may move. An animation of transform alone runs on
 *  the compositor, at no cost to the main thread. Moving `top` or `left`, or
 *  writing styles from an animation frame, makes Chromium rebuild the page's
 *  layers on the main thread every frame: 13 of every 16 ms on a dashboard of
 *  a few thousand nodes, which left React no time to render the results the
 *  loaders were waiting for. */
function createFallingCoin(id: number, containerWidth: number, containerHeight: number): FallingCoin {
  const scale = randomScale();
  // Painted extents, not layout boxes: `scale()` is centre-origin. Whole
  // pixels, rounded away from the box, so a coin is fully out of sight at both
  // ends of a fall and the jump between them never shows.
  const hiddenAbove = Math.floor(-(COIN_SIZE + COIN_SIZE * scale) / 2);
  const hiddenBelow = Math.ceil(containerHeight + minStaticOffset(scale));
  // Rounded into the box, so a lane at either limit stays inside it.
  const minX = Math.ceil(minStaticOffset(scale) * 100) / 100;
  const maxX = Math.floor(maxStaticOffset(containerWidth, scale) * 100) / 100;
  // A box narrower than a coin has no lanes: the coin stays where it is centred.
  const lane = (x: number): number => (maxX <= minX ? round(x) : Math.min(Math.max(round(x), minX), maxX));

  let rotation = coinRandom.next() < 0.5 ? ROTATION_MIN : ROTATION_MAX;
  let elapsed = 0;
  let parked = 'none';
  const falls: { from: string; to: string; easing: string; startsAt: number }[] = [];
  for (let i = 0; i < FALLS_PER_CYCLE; i++) {
    const startY = hiddenAbove - Math.round(coinRandom.next() * containerHeight * HEADROOM);
    const startX = lane(staticOffset(containerWidth, scale));
    const drift = (coinRandom.next() - 0.5) * 2 * MAX_DRIFT;
    const endX = maxX <= minX ? startX : lane(startX + drift);
    const turned = rotation === ROTATION_MIN ? ROTATION_MAX : ROTATION_MIN;
    const distance = hiddenBelow - startY;
    const seconds = fallSeconds(distance);
    const from = coinTransform(startX, startY, rotation, scale);
    if (i === 0) parked = from;
    falls.push({
      from,
      to: coinTransform(endX, hiddenBelow, turned, scale),
      easing: fallEasing(distance, seconds),
      startsAt: elapsed,
    });
    rotation = turned;
    elapsed += seconds;
  }

  const keyframes: Keyframe[] = [];
  for (const [i, fall] of falls.entries()) {
    const next = falls[i + 1];
    keyframes.push(
      { offset: fall.startsAt / elapsed, transform: fall.from, easing: fall.easing },
      { offset: next === undefined ? 1 : next.startsAt / elapsed, transform: fall.to, easing: 'linear' },
    );
  }
  return { kind: 'falling', id, parked, keyframes, durationMs: elapsed * 1000 };
}

const COIN_CLASS = 'absolute pointer-events-none select-none flex items-center justify-center rounded-full font-black';

const COIN_FACE: CSSProperties = {
  width: COIN_SIZE,
  height: COIN_SIZE,
  background: 'radial-gradient(circle at 32% 28%, #FFF3B0 0%, #F4C430 35%, #D4A017 70%, #8B6914 100%)',
  boxShadow: 'inset -2px -3px 0 rgba(0,0,0,0.22), inset 2px 2px 2px rgba(255,255,255,0.35), 0 3px 6px rgba(0,0,0,0.3)',
  color: '#5A3D00',
  fontSize: 20,
  lineHeight: 1,
};

function StaticCoinView({ coin }: Readonly<{ coin: StaticCoin }>) {
  return (
    <div
      aria-hidden="true"
      className={COIN_CLASS}
      style={{
        ...COIN_FACE,
        left: coin.x,
        top: coin.y,
        transform: `rotateY(${String(ROTATION_FRONT_ON)}deg) scale(${String(coin.scale)})`,
      }}
    >
      $
    </div>
  );
}

function FallingCoinView({ coin }: Readonly<{ coin: FallingCoin }>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    // jsdom has no Web Animations; the coin then stays parked above the box.
    if (el === null || typeof el.animate !== 'function') return undefined;
    const animation = el.animate(coin.keyframes, { duration: coin.durationMs, iterations: Infinity });
    return () => { animation.cancel(); };
  }, [coin]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={COIN_CLASS}
      style={{
        ...COIN_FACE,
        left: 0,
        top: 0,
        // rotateY gives the 3D tumble effect — a plain Z-rotate on a symmetric
        // circle is invisible. The Y axis flips the front/back face; the `$`
        // glyph appears squashed at 90°/270° which reads as "spinning on its
        // edge".
        transform: coin.parked,
        // The coin's own compositor layer from its first paint, so starting
        // the animation changes no layer. Static coins never move and get
        // none: a dozen-plus layers app-wide for elements that never change.
        willChange: 'transform',
      }}
    >
      $
    </div>
  );
}

export function CoinRainLoader({ height = 120, count = 5 }: Readonly<{ height?: number; count?: number }>) {
  const containerRef = useRef<HTMLOutputElement>(null);
  const [coins, setCoins] = useState<readonly Coin[]>([]);
  const reduced = useReducedMotion();

  // The coins are seeded once the box can be measured, and again when its
  // height, the count or the motion preference changes — never per frame. A
  // state update per frame is an urgent render per frame, and on a busy main
  // thread each one sends a pending transition (a query result waiting to
  // render) back to the end of the queue: the loaders then outlive their
  // queries by minutes. Subscribed to the preference, so toggling the OS
  // setting mid-load re-seeds instead of waiting for a remount.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const w = el.offsetWidth;
    setCoins(Array.from({ length: count }, (_, i) => (
      reduced ? createStaticCoin(i, w, height) : createFallingCoin(i, w, height)
    )));
  }, [count, height, reduced]);

  return (
    // Motion is the only "still working" signal this loader gives, and the
    // reduced-motion scatter has none at all, so announce it instead —
    // <output> is an implicit status live region. The spoken content of a live
    // region is its text — not its label — and the coins are decorative `$`
    // glyphs, so they are hidden and a real text node carries the message.
    // Mirrors the announcer in App.tsx.
    <output
      ref={containerRef}
      className="relative block overflow-hidden"
      style={{ height, perspective: '600px' }}
    >
      <span className="sr-only">Loading</span>
      {coins.map(coin => (
        coin.kind === 'static'
          ? <StaticCoinView key={coin.id} coin={coin} />
          : <FallingCoinView key={coin.id} coin={coin} />
      ))}
    </output>
  );
}
