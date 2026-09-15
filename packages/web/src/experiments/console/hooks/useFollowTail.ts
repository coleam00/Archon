import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Distance from the bottom (px) within which a scroller counts as sitting at the
 * tail. Drives both follow stickiness and the jump-to-bottom affordance.
 */
export const NEAR_BOTTOM_PX = 120;

/**
 * The geometry follow-tail actually reads. Narrower than `HTMLElement` on purpose:
 * the controller below is the testable core, and a plain object satisfies this.
 */
export interface ScrollerGeometry {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function isNearBottom(el: ScrollerGeometry, nearBottomPx: number = NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx;
}

export interface FollowTailController {
  isFollowing: () => boolean;
  /** Resume following and snap to the tail. */
  pin: () => void;
  /** Stop following, leaving the viewport where it is. */
  unpin: () => void;
  /** Observed content changed height; hold the tail if still following. */
  onContentResize: () => void;
  /** The viewport moved; follow intent follows the viewport. */
  onScroll: () => void;
}

export interface FollowTailControllerOptions {
  getScroller: () => ScrollerGeometry | null;
  onFollowingChange?: (following: boolean) => void;
  nearBottomPx?: number;
  /** When true, a scroll event must not disturb follow intent. */
  isScrollSuppressed?: () => boolean;
}

/**
 * Follow-tail intent, free of React and the DOM.
 *
 * The invariant that matters: intent is owned by user navigation (`onScroll`,
 * `pin`, `unpin`), never inferred from post-render geometry. Content that grows
 * under a pinned viewport must re-pin rather than be read as "the user scrolled
 * up" — that misreading is the bug this exists to prevent.
 */
export function createFollowTailController(
  options: FollowTailControllerOptions
): FollowTailController {
  const {
    getScroller,
    onFollowingChange,
    nearBottomPx = NEAR_BOTTOM_PX,
    isScrollSuppressed,
  } = options;
  let following = true;

  const setFollowing = (next: boolean): void => {
    if (following === next) return;
    following = next;
    onFollowingChange?.(next);
  };

  const toTail = (): void => {
    const el = getScroller();
    if (el !== null) el.scrollTop = el.scrollHeight;
  };

  return {
    isFollowing: (): boolean => following,
    pin: (): void => {
      setFollowing(true);
      toTail();
    },
    unpin: (): void => {
      setFollowing(false);
    },
    onContentResize: (): void => {
      if (following) toTail();
    },
    onScroll: (): void => {
      if (isScrollSuppressed?.() === true) return;
      const el = getScroller();
      if (el === null) return;
      setFollowing(isNearBottom(el, nearBottomPx));
    },
  };
}

export interface UseFollowTailOptions<T extends HTMLElement = HTMLDivElement> {
  nearBottomPx?: number;
  /**
   * Reuse a ref the caller already owns, for a component whose helpers close over
   * the scroller above the point where this hook is called. Omit to get one.
   */
  scrollRef?: RefObject<T | null>;
  /**
   * Consulted on each fresh mount of the observed node. Return false to mount
   * detached — for a caller that is about to reveal a specific target instead.
   */
  followOnMount?: () => boolean;
  /** Runs once the observed node is mounted and the observer is attached. */
  onContentMount?: (node: HTMLElement) => void;
  /** When true, scroll events leave follow intent alone. */
  isScrollSuppressed?: () => boolean;
}

export interface UseFollowTailResult<T extends HTMLElement = HTMLDivElement> {
  /** Attach to the scrolling element (`overflow-y-auto`). */
  scrollRef: RefObject<T | null>;
  /**
   * Attach to the content element *inside* the scroller. Its DOM lifetime owns
   * the ResizeObserver, so the observer survives loading early-returns and
   * remounts without a separate effect to babysit it.
   */
  contentRef: (node: HTMLElement | null) => (() => void) | undefined;
  /** Whether the viewport is at the tail — drives the jump-to-bottom affordance. */
  atBottom: boolean;
  scrollToBottom: () => void;
  /** Imperative follow intent, for callers doing a programmatic reveal. */
  setFollowing: (following: boolean) => void;
  /** Wire to the scroller's `onScroll`. */
  handleScroll: () => void;
}

/**
 * Keeps a scroller pinned to its tail while new content arrives, and detaches
 * when the user scrolls away.
 *
 * Height-driven rather than count-driven: a `ResizeObserver` on the content node
 * re-pins on *any* growth, so streaming text, late markdown/code highlighting and
 * expanding cards all hold the tail. Keying auto-scroll off a message count (the
 * shape this replaces) misses every one of those, because they grow an existing
 * row instead of adding one.
 */
export function useFollowTail<T extends HTMLElement = HTMLDivElement>(
  options: UseFollowTailOptions<T> = {}
): UseFollowTailResult<T> {
  const ownScrollRef = useRef<T | null>(null);
  const scrollRef = options.scrollRef ?? ownScrollRef;
  const [atBottom, setAtBottom] = useState(true);

  // Seeded from the first render so the callback ref — which runs before any
  // effect — sees real options on mount, then kept current for later mounts.
  const optionsRef = useRef(options);
  const scrollRefRef = useRef(scrollRef);
  useLayoutEffect(() => {
    optionsRef.current = options;
    scrollRefRef.current = scrollRef;
  });

  const controllerRef = useRef<FollowTailController | null>(null);
  controllerRef.current ??= createFollowTailController({
    getScroller: () => scrollRefRef.current.current,
    onFollowingChange: setAtBottom,
    nearBottomPx: options.nearBottomPx,
    isScrollSuppressed: () => optionsRef.current.isScrollSuppressed?.() === true,
  });
  const controller = controllerRef.current;

  const contentRef = useCallback(
    (node: HTMLElement | null): (() => void) | undefined => {
      if (node === null) return undefined;

      if (optionsRef.current.followOnMount?.() ?? true) controller.pin();
      else controller.unpin();

      const observer = new ResizeObserver(() => {
        controller.onContentResize();
      });
      observer.observe(node);

      optionsRef.current.onContentMount?.(node);

      return (): void => {
        observer.disconnect();
      };
    },
    [controller]
  );

  const handleScroll = useCallback((): void => {
    controller.onScroll();
  }, [controller]);

  const scrollToBottom = useCallback((): void => {
    controller.pin();
  }, [controller]);

  const setFollowing = useCallback(
    (following: boolean): void => {
      if (following) controller.pin();
      else controller.unpin();
    },
    [controller]
  );

  return { scrollRef, contentRef, atBottom, scrollToBottom, setFollowing, handleScroll };
}
