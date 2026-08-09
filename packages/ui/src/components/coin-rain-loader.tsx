import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../hooks/use-reduced-motion.js';

interface Coin {
  id: number;
  x: number;
  y: number;
  vy: number;
  vx: number;
  rotation: number;
  rotationSpeed: number;
  scale: number;
}

/** Layout size of a coin, before its centre-origin `scale` transform.
 *  Exported so tests compute painted extents from the real value rather than
 *  restating it. */
export const COIN_SIZE = 36;

// Rotation (rotateY) oscillates between 25% (90°) and 75% (270°) of a full
// turn. Each coin starts at one of the two endpoints at random and rotates
// toward the other, then reverses. This keeps the coin hovering around
// its back-face view (180°) — the previous "continuous 360°" rotation
// would spend half its time with the coin fully side-on (invisibly thin).
const ROTATION_MIN = 90;
const ROTATION_MAX = 270;

// Every angle in the oscillation range is past 90°, i.e. the coin's back face.
// While it tumbles that reads as a spin, but a frozen coin at 180° is simply a
// mirror image — backwards `$`, gradient highlight on the wrong side. 0° is
// the front face and projects to the same full width, so it is the angle to
// park a coin that will never move.
const ROTATION_FRONT_ON = 0;

const SCALE_MIN = 0.7;
const SCALE_RANGE = 0.5;

function randomScale(): number {
  return SCALE_MIN + Math.random() * SCALE_RANGE;
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
  return min + Math.random() * (max - min);
}

/** A coin placed for the static (reduced-motion) render: inside the visible
 *  box rather than above it, and front-on rather than at an oscillation
 *  endpoint. Both matter — the animated spawn sits off-screen above the
 *  container and the endpoints are exactly edge-on, so a coin frozen with
 *  either would be invisible, which is the opposite of what a loading
 *  indicator is for. */
function createStaticCoin(id: number, containerWidth: number, containerHeight: number): Coin {
  const scale = randomScale();
  return {
    id,
    x: staticOffset(containerWidth, scale),
    y: staticOffset(containerHeight, scale),
    vy: 0,
    vx: 0,
    rotation: ROTATION_FRONT_ON,
    rotationSpeed: 0,
    scale,
  };
}

function createCoin(id: number, containerWidth: number, containerHeight: number): Coin {
  const startAtMin = Math.random() < 0.5;
  const speedMag = 0.5 + Math.random() * 1.5;
  return {
    id,
    x: Math.random() * Math.max(containerWidth - COIN_SIZE, 0),
    y: -COIN_SIZE - Math.random() * containerHeight * 0.6,
    vy: 0.37,
    vx: (Math.random() - 0.5) * 0.1,
    rotation: startAtMin ? ROTATION_MIN : ROTATION_MAX,
    // Sign points the rotation toward the opposite limit.
    rotationSpeed: startAtMin ? speedMag : -speedMag,
    scale: randomScale(),
  };
}

function updateCoin(c: Coin, containerWidth: number, containerHeight: number): Coin {
  let { x, y, vx, vy, rotation, rotationSpeed, scale } = c;
  vy += 0.034;
  vx += Math.sin(Date.now() / 800 + c.id * 2) * 0.013;
  vx *= 0.98;
  x += vx;
  y += vy;
  rotation += rotationSpeed;
  if (rotation >= ROTATION_MAX) { rotation = ROTATION_MAX; rotationSpeed = -Math.abs(rotationSpeed); }
  else if (rotation <= ROTATION_MIN) { rotation = ROTATION_MIN; rotationSpeed = Math.abs(rotationSpeed); }
  if (x < 0) { x = 0; vx = Math.abs(vx) * 0.5; }
  if (x > containerWidth - COIN_SIZE * scale) { x = containerWidth - COIN_SIZE * scale; vx = -Math.abs(vx) * 0.5; }
  if (y > containerHeight + COIN_SIZE) return createCoin(c.id, containerWidth, containerHeight);
  return { ...c, x, y, vx, vy, rotation, rotationSpeed, scale };
}

function advanceCoins(prev: Coin[], w: number, h: number): Coin[] {
  return prev.map(c => updateCoin(c, w, h));
}

export function CoinRainLoader({ height = 120, count = 5 }: Readonly<{ height?: number; count?: number }>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const reduced = useReducedMotion();

  // Seeding and arming share one `reduced` value from a single render. Reading
  // the preference separately in two effects would let them disagree across
  // commits — coins seeded to fall, then a loop that never arms, leaving an
  // empty box for the whole query. Re-runs on a preference flip, so toggling
  // the OS setting mid-load re-seeds instead of waiting for a remount.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const w = el.offsetWidth;
    setCoins(Array.from({ length: count }, (_, i) => (
      reduced ? createStaticCoin(i, w, height) : createCoin(i, w, height)
    )));
    // `count === 0` would otherwise spin forever: advanceCoins returns a fresh
    // empty array each tick, so React never bails out of the re-render.
    if (reduced || count === 0) return;

    let frame = 0;
    function tick() {
      setCoins(prev => advanceCoins(prev, w, height));
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); };
  }, [count, height, reduced]);

  return (
    <div
      ref={containerRef}
      // Motion is the only "still working" signal this loader gives, and the
      // reduced-motion scatter has none at all, so announce it instead. The
      // spoken content of a live region is its text — not its label — and the
      // coins are decorative `$` glyphs, so they are hidden and a real text
      // node carries the message. Mirrors the announcer in App.tsx.
      role="status"
      className="relative overflow-hidden"
      style={{ height, perspective: '600px' }}
    >
      <span className="sr-only">Loading</span>
      {coins.map(c => (
        <div
          key={c.id}
          aria-hidden="true"
          className="absolute pointer-events-none select-none flex items-center justify-center rounded-full font-black"
          style={{
            left: c.x,
            top: c.y,
            width: 36,
            height: 36,
            // rotateY gives the 3D tumble effect — a plain Z-rotate on a
            // symmetric circle is invisible. The Y axis flips the front/back
            // face; the `$` glyph appears squashed at 90°/270° which reads as
            // "spinning on its edge".
            transform: `rotateY(${String(c.rotation)}deg) scale(${String(c.scale)})`,
            background: 'radial-gradient(circle at 32% 28%, #FFF3B0 0%, #F4C430 35%, #D4A017 70%, #8B6914 100%)',
            boxShadow: 'inset -2px -3px 0 rgba(0,0,0,0.22), inset 2px 2px 2px rgba(255,255,255,0.35), 0 3px 6px rgba(0,0,0,0.3)',
            color: '#5A3D00',
            fontSize: 20,
            lineHeight: 1,
            // Only meaningful while the transform is being rewritten each
            // frame; on the static path it would pin a compositor layer per
            // coin — a dozen-plus app-wide — for elements that never change.
            // (A `transition` here used to smooth the rotation, but at frame
            // pacing it was retargeted before it could ever complete, and
            // measured as ~40% of the loader's total CPU in Chromium.)
            ...(reduced ? {} : { willChange: 'transform' }),
          }}
        >
          $
        </div>
      ))}
    </div>
  );
}
