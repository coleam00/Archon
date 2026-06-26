import { useEffect, useRef, type RefObject } from 'react';

/**
 * Unmount guard for async handlers: `ref.current` flips to true when the
 * component unmounts (and resets on mount, surviving StrictMode's double
 * effect cycle), so `await`-ed continuations can bail before touching React
 * state. Extracted once the identical inline block hit six console call
 * sites (rule of three, twice over).
 *
 * Note: the ref is mount-scoped — it does NOT flip when props change. A
 * consumer whose async loop must also stop on a prop change (e.g.
 * SubscriptionLoginFlow's per-provider poll loop) combines it with an
 * effect-local flag.
 */
export function useCancelledRef(): RefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = false;
    return (): void => {
      ref.current = true;
    };
  }, []);
  return ref;
}
