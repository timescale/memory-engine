/**
 * `useDebounced` — returns a value that only updates after `delay` ms of
 * quiescence. Used to throttle filter changes so we don't fire an RPC per
 * keystroke.
 */
import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
