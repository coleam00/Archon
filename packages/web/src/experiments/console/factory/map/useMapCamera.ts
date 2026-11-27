import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  cappedHeight,
  FIT_PAD,
  type FitPad,
  fitCamera,
  fittedHeight,
  grownHeight,
  MAP_ROOM_Y,
  MIN_FRAME_HEIGHT,
  LIVE_MIN_K,
  reveal,
  zoomAt,
  type Camera,
  type Frame,
} from '../lib/map-camera';
import type { Box } from '../lib/map-layout';

/** A press that moves less than this (px, summed axes) is a click, not a pan. */
const DRAG_SLOP = 4;
const BUTTON_ZOOM = 1.25;

interface MapCamera {
  frameRef: RefObject<HTMLDivElement | null>;
  camera: Camera;
  /** The frame's height: the map fitted to the width of the row the frame sits in. */
  height: number;
  zoomIn: () => void;
  zoomOut: () => void;
  /** The whole map in the frame; it then refits with the frame again until moved. */
  fit: () => void;
  frameHandlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  };
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

/**
 * How a camera fits its drawing: the padding kept round it, the least and most scale, and a
 * band at the frame's bottom a fit leaves clear (for a panel docked over it), which panning
 * may still use.
 */
export interface Fitting {
  pad: FitPad;
  minK: number;
  maxK: number;
  reserveBottom: number;
  /**
   * The most of the window's height the frame takes, as a fraction. Where the drawing fitted to
   * the row's width would be taller, the frame stops there and the fit shrinks the drawing to
   * its height too. Unset, the frame is as tall as the width-fitted drawing.
   */
  maxFrameVh?: number;
}
/**
 * The live map: opens fitted to its frame down to `LIVE_MIN_K`, else at its start sideways,
 * with room above and below the drawing.
 */
export const LIVE_FITTING: Fitting = {
  pad: { x: FIT_PAD, y: MAP_ROOM_Y },
  minK: LIVE_MIN_K,
  maxK: 1,
  reserveBottom: 0,
};

const frameOf = (el: HTMLElement): Frame => ({ width: el.clientWidth, height: el.clientHeight });

/**
 * The map's camera, ported from Mission Control's map: it opens fitted and refits as the frame
 * resizes until the person pans or zooms; a drag pans, the wheel zooms around the cursor.
 * While a card is `focus`ed (its details open beside the frame, which narrows it) the camera
 * keeps its scale and pans only as far as it must to keep that card in view: refitting to the
 * narrower frame would shrink the cards' text below what a person can read. The cards the
 * panel's width pushes out of the frame are a drag away. Closing the panel refits again,
 * unless the person has moved the map. `fitting` sets the fit's padding, its least and most
 * scale (`fitCamera`) and the bottom band it leaves clear; the live map takes the defaults.
 * Where the drawing does not fit, a fit opens (and Fit returns) at the drawing's start.
 * `below` is how far under the drawing (world units) must show too, now: the frame grows under
 * the drawing to hold it (`grownHeight`) while the fit, and so the cards, stay where they are.
 */
export function useMapCamera(
  bounds: Box,
  focus: Box | null,
  fitting: Fitting = LIVE_FITTING,
  below = 0
): MapCamera {
  const { pad, minK, maxK, reserveBottom, maxFrameVh } = fitting;
  /**
   * The part of the frame a fit fills: the frame as the drawing alone sizes it (`base`, its
   * border box), not as a grown `below` makes it, so showing what is below never moves the map.
   */
  const fitFrame = useCallback(
    (el: HTMLElement, base: number): Frame => ({
      width: el.clientWidth,
      height: Math.max(0, base - (el.offsetHeight - el.clientHeight) - reserveBottom),
    }),
    [reserveBottom]
  );
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const current = useRef(camera);
  const moved = useRef(false);
  const focused = useRef(focus);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  const put = useCallback((next: Camera) => {
    current.current = next;
    setCamera(next);
  }, []);

  /** The frame's border-box height for the drawing alone, before `below` grows it. */
  const baseOf = useCallback(
    (el: HTMLElement): number => {
      const row = el.parentElement ?? el;
      // The height set is the frame's border box; the fit is to its client box, inside the
      // border. Adding the border makes the client box the fitted height, so the drawing sits
      // centred with the whole pad above and below it rather than top-aligned and short.
      const border = el.offsetHeight - el.clientHeight;
      const fitted = fittedHeight(bounds, row.clientWidth, pad, minK, maxK) + border;
      return maxFrameVh === undefined
        ? fitted
        : cappedHeight(fitted, window.innerHeight, maxFrameVh);
    },
    [bounds, pad, minK, maxK, maxFrameVh]
  );

  const place = useCallback(() => {
    const el = frameRef.current;
    if (el === null) return;
    const base = baseOf(el);
    const target = focused.current;
    if (target !== null) put(reveal(current.current, target, frameOf(el)));
    else if (!moved.current) put(fitCamera(bounds, fitFrame(el, base), pad, minK, maxK));
    setHeight(grownHeight(base, current.current, bounds, below));
  }, [bounds, below, pad, minK, maxK, baseOf, fitFrame, put]);

  useEffect(() => {
    focused.current = focus;
    place();
  }, [focus, place]);

  useEffect(() => {
    const el = frameRef.current;
    // happy-dom and old browsers have no ResizeObserver; the map then stays where it opened.
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place());
    observer.observe(el);
    if (el.parentElement !== null) observer.observe(el.parentElement);
    // A frame capped to the window's height follows the window, which neither box tracks.
    const onWindow = (): void => place();
    if (maxFrameVh !== undefined) window.addEventListener('resize', onWindow);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindow);
    };
  }, [place, maxFrameVh]);

  const zoomAround = useCallback(
    (factor: number, at: { x: number; y: number }) => {
      moved.current = true;
      put(zoomAt(current.current, at, factor));
    },
    [put]
  );

  // React attaches wheel listeners passive, and a passive one cannot keep the page still.
  useEffect(() => {
    const el = frameRef.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      zoomAround(Math.exp(-event.deltaY * 0.0022), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  const zoomCentre = (factor: number): void => {
    const el = frameRef.current;
    if (el !== null) zoomAround(factor, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
  };

  const fit = (): void => {
    const el = frameRef.current;
    if (el === null) return;
    moved.current = false;
    const base = baseOf(el);
    put(fitCamera(bounds, fitFrame(el, base), pad, minK, maxK));
    setHeight(grownHeight(base, current.current, bounds, below));
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
  };
  // Capture waits for the press to move: captured at once, a plain click on a card would go
  // to the frame instead.
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const was = drag.current;
    if (was === null) return;
    // A press released outside the frame before it was captured never reaches onPointerUp.
    if (event.buttons === 0) {
      drag.current = null;
      return;
    }
    if (!was.moved) {
      if (Math.abs(event.clientX - was.startX) + Math.abs(event.clientY - was.startY) <= DRAG_SLOP)
        return;
      was.moved = true;
      event.currentTarget.setPointerCapture(was.pointerId);
    }
    moved.current = true;
    const at = current.current;
    put({ ...at, x: at.x + event.clientX - was.lastX, y: at.y + event.clientY - was.lastY });
    was.lastX = event.clientX;
    was.lastY = event.clientY;
  };
  const onPointerUp = (): void => {
    const was = drag.current;
    drag.current = null;
    if (was?.moved !== true) return;
    // The click a browser sends after a drag must not open the card the drag ended on. It
    // comes straight after this event or not at all, so the guard lasts one task.
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  const onClickCapture = (event: MouseEvent<HTMLElement>): void => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  return {
    frameRef,
    camera,
    height,
    zoomIn: () => zoomCentre(BUTTON_ZOOM),
    zoomOut: () => zoomCentre(1 / BUTTON_ZOOM),
    fit,
    frameHandlers: { onPointerDown, onPointerMove, onPointerUp, onClickCapture },
  };
}
