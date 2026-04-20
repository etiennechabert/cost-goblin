import { useEffect, useRef, useState } from 'react';

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

export function CoinRainLoader({ height = 120, count = 5 }: Readonly<{ height?: number; count?: number }>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const frameRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    setCoins(Array.from({ length: count }, (_, i) => createCoin(i, el.offsetWidth, height)));
  }, [count, height]);

  useEffect(() => {
    if (coins.length === 0) return;
    const el = containerRef.current;
    if (el === null) return;

    const w = el.offsetWidth;

    const tick = () => {
      setCoins(prev => prev.map(c => {
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
        if (x > w - COIN_SIZE * scale) { x = w - COIN_SIZE * scale; vx = -Math.abs(vx) * 0.5; }

        if (y > height + COIN_SIZE) {
          return createCoin(c.id, w, height);
        }

        return { ...c, x, y, vx, vy, rotation, scale };
      }));
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frameRef.current); };
  }, [coins.length, height]);

  return (
    <div
      ref={containerRef}
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
            willChange: 'transform',
            transition: 'transform 0.03s linear',
          }}
        >
          $
        </div>
      ))}
    </div>
  );
}
