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

function createCoin(id: number, containerWidth: number, containerHeight: number): Coin {
  return {
    id,
    x: Math.random() * (containerWidth - 24),
    y: -30 - Math.random() * containerHeight * 0.6,
    vy: 0.5 + Math.random() * 1.5,
    vx: (Math.random() - 0.5) * 0.3,
    rotation: Math.random() * 360,
    rotationSpeed: (Math.random() - 0.5) * 6,
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
        vy += 0.12;
        vx += Math.sin(Date.now() / 800 + c.id * 2) * 0.04;
        vx *= 0.98;
        x += vx;
        y += vy;
        rotation += rotationSpeed;

        if (x < 0) { x = 0; vx = Math.abs(vx) * 0.5; }
        if (x > w - 24 * scale) { x = w - 24 * scale; vx = -Math.abs(vx) * 0.5; }

        if (y > height + 30) {
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
          className="absolute pointer-events-none select-none"
          style={{
            left: c.x,
            top: c.y,
            transform: `rotateZ(${String(c.rotation)}deg) scale(${String(c.scale)})`,
            fontSize: 22,
            willChange: 'transform',
            transition: 'transform 0.03s linear',
          }}
        >
          🪙
        </div>
      ))}
    </div>
  );
}
