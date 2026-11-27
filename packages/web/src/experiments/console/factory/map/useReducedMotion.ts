import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/**
 * Whether the person asked for reduced motion, kept current as the setting changes. A CSS
 * `motion-reduce:` class cannot stop an SVG (SMIL) animation, so motion of that kind is not
 * rendered at all when this is true. Without a window (static rendering) it says true: no motion
 * until the browser says motion is wanted.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true
  );
}
