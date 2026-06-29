import { useEffect, useState } from 'react';

/** Trailing-edge debounce of a value. Returns the input only after it has held
 *  steady for `ms`, so a burst of changes collapses into a single settled value. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(value); }, ms);
    return () => { clearTimeout(id); };
  }, [value, ms]);
  return debounced;
}
