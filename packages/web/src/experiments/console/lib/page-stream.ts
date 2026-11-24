import { useEffect, type DependencyList } from 'react';

/** The part of a window the helper listens on, so a test can hand in its own. */
export type PageEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Keep a stream open only while this document is shown. `connect` opens it and returns its
 * disconnect (nothing when it opened nothing); it runs now, its disconnect runs on `pagehide`,
 * and it runs again on a `pageshow` that restores the page from the back/forward cache. The
 * returned cleanup removes the listeners and disconnects once.
 *
 * Why `pagehide` and not only the effect's cleanup: a full document load (a refresh, a typed
 * URL, a link opened by an agent's browser) unloads the page without unmounting React, so no
 * effect cleanup runs, and Chrome kept the old document's EventSource sockets open. Two
 * streams per page fill HTTP/1.1's six connections per host after three loads, and the next
 * page's reads queue forever behind them (issue #39).
 */
export function followWhilePageShown(
  connect: () => (() => void) | undefined,
  page: PageEvents = window
): () => void {
  let disconnect: (() => void) | undefined = connect();

  const hide = (): void => {
    disconnect?.();
    disconnect = undefined;
  };
  const show = (event: Event): void => {
    // A page shown fresh still has its stream; only a restored one closed it on the way out.
    if (disconnect === undefined && (event as PageTransitionEvent).persisted)
      disconnect = connect();
  };

  page.addEventListener('pagehide', hide);
  page.addEventListener('pageshow', show);
  return (): void => {
    page.removeEventListener('pagehide', hide);
    page.removeEventListener('pageshow', show);
    hide();
  };
}

/** `followWhilePageShown` as an effect: `connect` runs again when `deps` change. */
export function useWhilePageShown(
  connect: () => (() => void) | undefined,
  deps: DependencyList
): void {
  useEffect(() => followWhilePageShown(connect), deps);
}
