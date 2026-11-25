/**
 * The factory map's camera: the world drawn at `translate(x, y) scale(k)` with origin 0 0,
 * so a world point p sits at `p * k + (x, y)` in the frame.
 */
import type { Box, Point } from './map-layout';

export interface Camera {
  x: number;
  y: number;
  k: number;
}

export interface Frame {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
/** Fitting never enlarges the live map past its drawn size: zoom in to read closer. */
const MAX_FIT = 1;
/** The px a console type token names: `text-console-12` is 12 px (theme.css's scale). */
const tokenPx = (token: string): number => Number(token.slice('text-console-'.length));
/**
 * The smallest text the map draws (its chips and line pills; FactoryMap.test.tsx holds every
 * class on the map to it), and the Visual standard's type floor (rule 1).
 */
const MAP_SMALLEST_TEXT = 'text-console-12';
export const MAP_SMALLEST_PX = tokenPx(MAP_SMALLEST_TEXT);
export const TYPE_FLOOR_PX = 12;
/**
 * The scale at which the map's text draws at the type floor: 1. It is only `fitCamera`'s and
 * `fittedHeight`'s default floor; the live map opens down to `LIVE_MIN_K` instead (ruling
 * 33a557aa), and How it works passes its own floor.
 */
export const READABLE_K = TYPE_FLOOR_PX / MAP_SMALLEST_PX;
/**
 * The least scale the live map opens (and Fit returns) at. The owner's ruling of 2026-11-25
 * (ruling 33a557aa) has the Overview map open fitted to its frame at 1440, the Merged card in
 * view: the shipped map is about 1313 px wide and its frame there about 1110, so it opens near
 * 0.82. Below this scale, on narrower frames, it opens at this scale at its start and pans, so
 * a phone does not shrink it to nothing. A person may still zoom in to read closer.
 */
export const LIVE_MIN_K = 0.75;
/** Space kept between the fitted map and the frame's edge. */
export const FIT_PAD = 16;
/**
 * Canvas kept above and below the live map's drawing, so its cards and lane labels never touch
 * the frame (owner change 2 of 2026-11-21). The frame grows taller to hold it; the scale, which
 * the width decides, is unchanged. Sideways the pad stays `FIT_PAD`, so the map opens at its start.
 */
export const MAP_ROOM_Y = 48;

/** Padding round a fitted drawing: one for every side, or one across and one up and down. */
export type FitPad = number | { x: number; y: number };
const padOf = (pad: FitPad): { x: number; y: number } =>
  typeof pad === 'number' ? { x: pad, y: pad } : pad;
/** The frame is never shorter than this, so the details panel beside it has room. */
export const MIN_FRAME_HEIGHT = 260;

export function clampK(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/**
 * The scale that fits `bounds` in `frame`, inside the padding, never under `minK` nor over
 * `maxK`; `maxK` for an empty map. `minK` is `LIVE_MIN_K` for the live map; the factory overview
 * passes its own floor, and a `maxK` over 1 so a small view fills a large frame.
 */
function fitScale(bounds: Box, frame: Frame, fitPad: FitPad, minK: number, maxK: number): number {
  const pad = padOf(fitPad);
  const sx = bounds.w > 0 ? (frame.width - 2 * pad.x) / bounds.w : maxK;
  const sy = bounds.h > 0 ? (frame.height - 2 * pad.y) / bounds.h : maxK;
  return clampK(Math.max(minK, Math.min(maxK, sx, sy)));
}

/** Where a span of `size` starts in an `extent`: centred when it fits, else at the padding. */
function place(size: number, extent: number, pad: number): number {
  return size <= extent - 2 * pad ? (extent - size) / 2 : pad;
}

/**
 * The map in the frame at its fitting scale: centred where it fits, else from its start
 * (top-left), so a narrow frame shows the first stages and the flow reads left to right,
 * panning to the rest. Finite for any frame, a zero-sized one included.
 */
export function fitCamera(
  bounds: Box,
  frame: Frame,
  fitPad: FitPad = FIT_PAD,
  minK = READABLE_K,
  maxK = MAX_FIT
): Camera {
  const k = fitScale(bounds, frame, fitPad, minK, maxK);
  const pad = padOf(fitPad);
  return {
    k,
    x: place(bounds.w * k, frame.width, pad.x) - bounds.x * k,
    y: place(bounds.h * k, frame.height, pad.y) - bounds.y * k,
  };
}

/** The frame height for a frame `width` wide: the map at its fitting scale, no empty bands. */
export function fittedHeight(
  bounds: Box,
  width: number,
  fitPad: FitPad = FIT_PAD,
  minK = READABLE_K,
  maxK = MAX_FIT
): number {
  const k = fitScale(bounds, { width, height: Number.POSITIVE_INFINITY }, fitPad, minK, maxK);
  return Math.max(MIN_FRAME_HEIGHT, Math.ceil(bounds.h * k + 2 * padOf(fitPad).y));
}

/**
 * A frame `fitted` tall held to `maxVh` of a window `viewport` tall, never under
 * `MIN_FRAME_HEIGHT` for the cap; a shorter `fitted` stands.
 */
export function cappedHeight(fitted: number, viewport: number, maxVh: number): number {
  return Math.min(fitted, Math.max(MIN_FRAME_HEIGHT, Math.floor(viewport * maxVh)));
}

/** Zoom by `factor` keeping the frame point `at` over the same world point. */
export function zoomAt(camera: Camera, at: Point, factor: number): Camera {
  const k = clampK(camera.k * factor);
  const r = k / camera.k;
  return { k, x: at.x - (at.x - camera.x) * r, y: at.y - (at.y - camera.y) * r };
}

/** The camera panned the least distance that shows all of `box` in the frame, where it fits. */
export function reveal(camera: Camera, box: Box, frame: Frame, pad = FIT_PAD): Camera {
  const shift = (start: number, size: number, extent: number): number => {
    const lo = pad - start;
    const hi = extent - pad - (start + size);
    if (lo > 0) return lo;
    if (hi < 0) return Math.max(hi, lo);
    return 0;
  };
  const left = box.x * camera.k + camera.x;
  const top = box.y * camera.k + camera.y;
  return {
    ...camera,
    x: camera.x + shift(left, box.w * camera.k, frame.width),
    y: camera.y + shift(top, box.h * camera.k, frame.height),
  };
}
