import { useEffect, useRef, useState } from 'react';

/** Tracks the rendered width of a container via ResizeObserver. Returns a
 *  ref to attach to the element and the current width in pixels. */
export function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  return [ref, width];
}
