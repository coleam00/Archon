import { describe, test, expect } from 'bun:test';
import {
  createFollowTailController,
  isNearBottom,
  NEAR_BOTTOM_PX,
  type ScrollerGeometry,
} from './useFollowTail';

/**
 * A scroller whose height can be grown the way real content does: more
 * `scrollHeight`, untouched `scrollTop`. That is the case the count-keyed
 * auto-scroll this hook replaces could not see.
 */
function makeScroller(
  clientHeight = 500,
  scrollHeight = 500
): ScrollerGeometry & {
  grow: (px: number) => void;
  scrollUpBy: (px: number) => void;
} {
  const el = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    grow(px: number): void {
      (el as { scrollHeight: number }).scrollHeight += px;
    },
    scrollUpBy(px: number): void {
      el.scrollTop -= px;
    },
  };
  return el;
}

function makeController(
  el: ScrollerGeometry | null,
  suppressed = false
): {
  controller: ReturnType<typeof createFollowTailController>;
  following: boolean[];
} {
  const following: boolean[] = [];
  const controller = createFollowTailController({
    getScroller: () => el,
    onFollowingChange: next => following.push(next),
    isScrollSuppressed: () => suppressed,
  });
  return { controller, following };
}

describe('isNearBottom', () => {
  test('is true at the tail and false above it', () => {
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });

  test('treats the threshold band as the tail', () => {
    const justInside = {
      scrollTop: 500 - (NEAR_BOTTOM_PX - 1),
      scrollHeight: 1000,
      clientHeight: 500,
    };
    const justOutside = { scrollTop: 500 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 500 };
    expect(isNearBottom(justInside)).toBe(true);
    expect(isNearBottom(justOutside)).toBe(false);
  });

  test('honours a caller-supplied threshold', () => {
    const el = { scrollTop: 400, scrollHeight: 1000, clientHeight: 500 };
    expect(isNearBottom(el, 50)).toBe(false);
    expect(isNearBottom(el, 200)).toBe(true);
  });
});

describe('createFollowTailController', () => {
  test('follows by default, so a fresh view starts at the tail', () => {
    const { controller } = makeController(makeScroller());
    expect(controller.isFollowing()).toBe(true);
  });

  // The regression this hook exists for: height growth with no new row.
  test('re-pins when content grows in place while pinned', () => {
    const el = makeScroller(500, 500);
    const { controller } = makeController(el);

    el.grow(400);
    controller.onContentResize();

    expect(el.scrollTop).toBe(900);
  });

  test('re-pins repeatedly, as streaming text grows a single row', () => {
    const el = makeScroller(500, 500);
    const { controller } = makeController(el);

    for (let i = 0; i < 5; i++) {
      el.grow(100);
      controller.onContentResize();
    }

    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test('leaves the viewport alone when the user has scrolled away', () => {
    const el = makeScroller(500, 2000);
    const { controller } = makeController(el);

    el.scrollTop = 200; // user dragged up, far from the tail
    controller.onScroll();
    expect(controller.isFollowing()).toBe(false);

    el.grow(1000);
    controller.onContentResize();

    expect(el.scrollTop).toBe(200);
  });

  test('re-attaches when the user scrolls back into the tail band', () => {
    const el = makeScroller(500, 2000);
    const { controller, following } = makeController(el);

    el.scrollTop = 0;
    controller.onScroll();
    expect(controller.isFollowing()).toBe(false);

    el.scrollTop = 1500;
    controller.onScroll();
    expect(controller.isFollowing()).toBe(true);

    expect(following).toEqual([false, true]);
  });

  test('pin() snaps to the tail and resumes following', () => {
    const el = makeScroller(500, 2000);
    const { controller } = makeController(el);

    el.scrollTop = 0;
    controller.onScroll();
    expect(controller.isFollowing()).toBe(false);

    controller.pin();

    expect(controller.isFollowing()).toBe(true);
    expect(el.scrollTop).toBe(2000);
  });

  test('unpin() detaches without moving the viewport', () => {
    const el = makeScroller(500, 2000);
    el.scrollTop = 900;
    const { controller } = makeController(el);

    controller.unpin();

    expect(controller.isFollowing()).toBe(false);
    expect(el.scrollTop).toBe(900);
  });

  test('reports follow changes only on transitions', () => {
    const el = makeScroller(500, 2000);
    const { controller, following } = makeController(el);

    el.scrollTop = 1500; // already at the tail; still following
    controller.onScroll();
    controller.onScroll();
    expect(following).toEqual([]);

    el.scrollTop = 0;
    controller.onScroll();
    controller.onScroll();
    expect(following).toEqual([false]);
  });

  test('a suppressed scroll does not change intent', () => {
    const el = makeScroller(500, 2000);
    const { controller } = makeController(el, true);

    el.scrollTop = 0; // a programmatic reveal moved the viewport, not the user
    controller.onScroll();

    expect(controller.isFollowing()).toBe(true);
  });

  test('survives a detached scroller', () => {
    const { controller } = makeController(null);

    controller.onScroll();
    controller.onContentResize();
    controller.pin();

    expect(controller.isFollowing()).toBe(true);
  });
});
