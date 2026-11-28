import { useLayoutEffect, useState, type RefObject } from 'react';

interface Size {
  width: number;
  height: number;
}

/** The least height a fitted graph is given, so a graph far down a short panel still reads. */
const MIN_ROOM_H = 240;
/** Room kept under the frame: its border and the scroller's padding. */
const ROOM_BELOW = 8;

/**
 * The scale that draws a graph `natural` big whole in `room`, inside `pad` on every side, never
 * enlarged past its drawn size. Positive and finite for any input: a graph with no size, or a
 * room not laid out yet, draws at 1.
 */
export function graphFitScale(natural: Size, room: Size, pad: number): number {
  const k = Math.min(
    1,
    (room.width - 2 * pad) / natural.width,
    (room.height - 2 * pad) / natural.height
  );
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** The nearest ancestor that scrolls up and down, which is the height a graph is fitted to. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = window.getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

/**
 * How tall the scroller can be: as tall as it is, plus what an ancestor capped by `max-height`
 * (a dialog as tall as its content) can still grow. That sum does not change as the graph's
 * scale changes the content's height, so the fit settles rather than chasing its own size.
 */
function scrollerRoom(scroller: HTMLElement): number {
  for (let at = scroller.parentElement; at !== null; at = at.parentElement) {
    const max = Number.parseFloat(window.getComputedStyle(at).maxHeight);
    if (Number.isFinite(max)) return scroller.clientHeight + Math.max(0, max - at.offsetHeight);
  }
  return scroller.clientHeight;
}

/**
 * The room a graph frame has: its width, and the height left in its scroller under what sits
 * above it. Above it is what its own `<section>` holds before it (its heading), or, for the
 * first section, everything from the scroller's top, which a reader cannot scroll past.
 */
function roomOf(frame: HTMLElement): Size {
  const scroller = scrollerOf(frame);
  if (scroller === null) return { width: frame.clientWidth, height: Number.POSITIVE_INFINITY };
  const section = frame.closest('section');
  const first = section === null || section.previousElementSibling?.tagName !== 'SECTION';
  const top = frame.getBoundingClientRect().top;
  const above = first
    ? top - scroller.getBoundingClientRect().top + scroller.scrollTop
    : top - section.getBoundingClientRect().top;
  return {
    width: frame.clientWidth,
    height: Math.max(MIN_ROOM_H, scrollerRoom(scroller) - above - ROOM_BELOW),
  };
}

/**
 * The scale a graph `natural` big opens at, fitted to its frame's width and to the height its
 * scroller leaves it (`roomOf`), refitted as the frame, its section or the window resizes. 1 when `enabled` is
 * false, and where there is no ResizeObserver (happy-dom). Measured before paint, so the graph
 * never shows at full size first.
 */
export function useGraphFit(
  frameRef: RefObject<HTMLElement | null>,
  natural: Size,
  pad: number,
  enabled: boolean
): number {
  const [k, setK] = useState(1);
  const { width, height } = natural;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!enabled || frame === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setK(graphFitScale({ width, height }, roomOf(frame), pad));
    measure();
    // The frame's own size, and its section's: a line appearing above the graph (an item
    // running now) moves the frame without resizing it.
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    const section = frame.closest('section');
    if (section !== null) observer.observe(section);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [frameRef, width, height, pad, enabled]);
  return enabled ? k : 1;
}
