/**
 * Throttles the dashboard SSE's cache invalidations. An invalidated runs key makes every
 * subscribed view refetch the run list from the database, and a busy instance emits node
 * events constantly, so an open console tab, hidden or not, refetched on every one.
 *
 * - Visible tab: a key refetches at once, then at most once more per window; events
 *   inside the window collapse into one trailing refetch when it ends.
 * - Hidden tab: nothing refetches. Each key invalidated meanwhile refetches once when
 *   the tab is shown again.
 */
export const INVALIDATE_WINDOW_MS = 2000;

export interface ThrottledInvalidatorDeps {
  invalidate: (key: string) => void;
  isHidden: () => boolean;
  setTimer: (callback: () => void, ms: number) => void;
}

export interface ThrottledInvalidator {
  invalidate: (key: string) => void;
  /** Call when the tab becomes visible: refetches every key held while it was hidden. */
  shown: () => void;
}

/**
 * A key with no entry is idle. `held`: invalidated while hidden, refetches when shown.
 * `window`: refetched within the window. `window-dirty`: invalidated again inside it.
 */
type KeyState = 'held' | 'window' | 'window-dirty';

export function createThrottledInvalidator(deps: ThrottledInvalidatorDeps): ThrottledInvalidator {
  const states = new Map<string, KeyState>();

  const refetch = (key: string): void => {
    if (deps.isHidden()) {
      states.set(key, 'held');
      return;
    }
    deps.invalidate(key);
    states.set(key, 'window');
    deps.setTimer(() => {
      const dirty = states.get(key) === 'window-dirty';
      states.delete(key);
      if (dirty) refetch(key);
    }, INVALIDATE_WINDOW_MS);
  };

  return {
    invalidate: (key: string): void => {
      const state = states.get(key);
      if (state === 'window' || state === 'window-dirty') states.set(key, 'window-dirty');
      else refetch(key);
    },
    shown: (): void => {
      for (const [key, state] of [...states]) if (state === 'held') refetch(key);
    },
  };
}
