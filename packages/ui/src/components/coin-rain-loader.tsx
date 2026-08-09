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

const COIN_SIZE = 36;

// Rotation (rotateY) oscillates between 25% (90°) and 75% (270°) of a full
// turn. Each coin starts at one of the two endpoints at random and rotates
// toward the other, then reverses. This keeps the coin hovering around
// its back-face view (180°) — the previous "continuous 360°" rotation
// would spend half its time with the coin fully side-on (invisibly thin).
const ROTATION_MIN = 90;
const ROTATION_MAX = 270;

// Midpoint of the oscillation: the fully face-on view. Only the animated path
// ever leaves this angle, so it is the one rotation a coin that never moves
// can be frozen at and still read as a coin.
const ROTATION_FACE_ON = (ROTATION_MIN + ROTATION_MAX) / 2;

/** A coin placed for the static (reduced-motion) render: inside the visible
 *  box rather than above it, and face-on rather than at an oscillation
 *  endpoint. Both matter — the animated spawn is off-screen above the
 *  container and the endpoints are exactly edge-on, so a coin frozen with
 *  either would be invisible, which is the opposite of what a loading
 *  indicator is for. Bounds use the rendered size (COIN_SIZE * scale, the
 *  transform is centre-origin) so nothing clips against `overflow-hidden`. */
function createStaticCoin(id: number, containerWidth: number, containerHeight: number): Coin {
  const scale = 0.7 + Math.random() * 0.5;
  const rendered = COIN_SIZE * scale;
  return {
    id,
    x: Math.random() * Math.max(containerWidth - rendered, 0),
    y: Math.random() * Math.max(containerHeight - rendered, 0),
    vy: 0,
    vx: 0,
    rotation: ROTATION_FACE_ON,
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
    scale: 0.7 + Math.random() * 0.5,
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
    if (reduced) return;

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
      // Motion is the only "still working" signal this loader gives; with it
      // removed the static scatter is indistinguishable from a finished render,
      // so the status role and label carry that meaning instead — for screen
      // readers in both modes, and visually for reduced-motion users.
      role="status"
      aria-label="Loading"
      className="relative overflow-hidden"
      style={{ height, perspective: '600px' }}
    >
      {coins.map(c => (
        <div
          key={c.id}
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
            // Both only mean anything while the transform is being rewritten
            // each frame. On the static path `will-change` would pin a
            // compositor layer per coin — a dozen-plus app-wide — for elements
            // that never change.
            ...(reduced ? {} : { willChange: 'transform', transition: 'transform 0.03s linear' }),
          }}
        >
          $
        </div>
      ))}
    </div>
  );
}
