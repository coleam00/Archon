import { useEffect, useState } from 'react';

/**
 * Returns the current visual viewport height in pixels.
 *
 * On mobile, the visual viewport shrinks when the soft keyboard appears.
 * Using this value instead of `100dvh` / `window.innerHeight` ensures that
 * the main chat container never gets hidden behind the keyboard.
 *
 * On desktop (no keyboard) the value equals `window.innerHeight`.
 *
 * Falls back to `window.innerHeight` via a resize listener on browsers that
 * do not support the `visualViewport` API (e.g. some older mobile browsers).
 */
export function useVisualViewport(): number {
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return window.visualViewport?.height ?? window.innerHeight;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const vv = window.visualViewport;

    if (vv) {
      const handler = (): void => {
        setHeight(vv.height);
      };
      vv.addEventListener('resize', handler);
      vv.addEventListener('scroll', handler);
      return (): void => {
        vv.removeEventListener('resize', handler);
        vv.removeEventListener('scroll', handler);
      };
    }

    // Fallback for browsers without visualViewport support
    const handler = (): void => {
      setHeight(window.innerHeight);
    };
    window.addEventListener('resize', handler);
    return (): void => {
      window.removeEventListener('resize', handler);
    };
  }, []);

  return height;
}
