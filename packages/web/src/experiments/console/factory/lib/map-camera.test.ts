import { describe, expect, test } from 'bun:test';
import {
  clampK,
  fitCamera,
  fittedHeight,
  MAP_ROOM_Y,
  MAX_ZOOM,
  MIN_FRAME_HEIGHT,
  FIT_PAD,
  MIN_ZOOM,
  READABLE_K,
  reveal,
  zoomAt,
} from './map-camera';
import { layoutMap } from './map-layout';
import { shippedView } from '../item-detail.test-fixtures';
import { LIVE_FITTING } from '../map/useMapCamera';

const world = { x: 0, y: -10, w: 1000, h: 200 };

describe('the map camera', () => {
  test('fit centres the map in the frame at the largest scale that holds it, inside the padding', () => {
    const camera = fitCamera(world, { width: 848, height: 400 }, 24, MIN_ZOOM);
    expect(camera.k).toBe(0.8);
    expect(camera.x).toBe(24);
    // 200 tall at 0.8 is 160, centred in 400; the world starts at y -10.
    expect(camera.y).toBe(120 + 8);
  });

  test('fit never enlarges past the drawn size, nor shrinks the text under the type floor', () => {
    expect(fitCamera(world, { width: 5000, height: 5000 }).k).toBe(1);
    expect(fitCamera(world, { width: 60, height: 60 }).k).toBe(READABLE_K);
    expect(READABLE_K).toBeGreaterThan(MIN_ZOOM);
  });

  test('a frame too narrow for the whole map opens on its start, at the readable scale', () => {
    const camera = fitCamera(world, { width: 400, height: 300 }, 24);
    expect(camera.k).toBe(READABLE_K);
    // The world's left edge at the padding: the first stages show, the rest pans.
    expect(camera.x).toBe(24);
  });

  // The Overview frame's widths on a phone, a tablet, at 1440x900, 1280 and wider.
  const WIDTHS = [320, 390, 768, 1100, 1280, 1600];
  const { bounds } = layoutMap(shippedView);
  const fitWidth = bounds.w + 2 * FIT_PAD;

  test('the shipped map opens at the readable scale at every frame width, panning exactly below its fit width', () => {
    for (const width of WIDTHS) {
      const camera = fitCamera(bounds, { width, height: fittedHeight(bounds, width) });
      expect(camera.k).toBe(READABLE_K);
    }
    const at = (width: number) => fitCamera(bounds, { width, height: 400 });
    // At its fit width it is centred; one pixel narrower it opens on its start and pans.
    expect(at(fitWidth).x).toBe(FIT_PAD - bounds.x);
    expect(at(fitWidth - 1).x).toBe(FIT_PAD - bounds.x);
    expect(at(fitWidth + 100).x).toBe(FIT_PAD + 50 - bounds.x);
  });

  test('the live map keeps 48 px of canvas above and below its drawing, and still opens at its start', () => {
    expect(MAP_ROOM_Y).toBe(48);
    const { pad, minK, maxK } = LIVE_FITTING;
    // The frame at 390x844, 1440x900 and 1920x1080 (measured in the browser).
    for (const width of [356, 1110, 1590]) {
      const frame = { width, height: fittedHeight(bounds, width, pad, minK, maxK) };
      const camera = fitCamera(bounds, frame, pad, minK, maxK);
      const top = camera.y + bounds.y * camera.k;
      const bottom = frame.height - (camera.y + (bounds.y + bounds.h) * camera.k);
      expect(top).toBeGreaterThanOrEqual(MAP_ROOM_Y);
      expect(bottom).toBeGreaterThanOrEqual(MAP_ROOM_Y);
    }
    // Sideways the pad is unchanged: too narrow to fit, it opens at the drawing's start.
    expect(fitCamera(bounds, { width: 1100, height: 800 }, LIVE_FITTING.pad).x).toBe(
      FIT_PAD - bounds.x
    );
  });

  test('fit is finite for an empty map and for a frame not laid out yet', () => {
    const empty = fitCamera({ x: 0, y: 0, w: 0, h: 0 }, { width: 800, height: 300 });
    expect(empty).toEqual({ k: 1, x: 400, y: 150 });
    const unsized = fitCamera(world, { width: 0, height: 0 });
    expect([unsized.k, unsized.x, unsized.y].every(Number.isFinite)).toBe(true);
  });

  test('the fitted frame height leaves no empty band, never below the floor', () => {
    expect(fittedHeight({ x: 0, y: 0, w: 1000, h: 600 }, 848, 24, MIN_ZOOM)).toBe(528);
    // Too narrow to fit: the height of the map at the readable scale.
    expect(fittedHeight({ x: 0, y: 0, w: 1000, h: 600 }, 300, 24)).toBe(600 * READABLE_K + 48);
    expect(fittedHeight(world, 548, 24)).toBe(MIN_FRAME_HEIGHT);
  });

  test('zoom keeps the point under the cursor over the same world point', () => {
    const camera = { x: 40, y: 20, k: 0.8 };
    const at = { x: 300, y: 120 };
    const worldAt = { x: (at.x - camera.x) / camera.k, y: (at.y - camera.y) / camera.k };
    const zoomed = zoomAt(camera, at, 1.25);
    expect(zoomed.k).toBe(1);
    expect(worldAt.x * zoomed.k + zoomed.x).toBeCloseTo(at.x);
    expect(worldAt.y * zoomed.k + zoomed.y).toBeCloseTo(at.y);
  });

  test('zoom stops at its bounds', () => {
    expect(clampK(10)).toBe(MAX_ZOOM);
    expect(clampK(0)).toBe(MIN_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: MAX_ZOOM }, { x: 10, y: 10 }, 2)).toEqual({
      x: 0,
      y: 0,
      k: MAX_ZOOM,
    });
  });

  test('reveal pans the least that shows a card, and not at all when it shows', () => {
    const camera = { x: 0, y: 0, k: 1 };
    const frame = { width: 500, height: 300 };
    expect(reveal(camera, { x: 100, y: 50, w: 100, h: 100 }, frame, 20)).toEqual(camera);
    expect(reveal(camera, { x: 450, y: 50, w: 100, h: 100 }, frame, 20)).toEqual({
      ...camera,
      x: -70,
    });
    expect(reveal(camera, { x: -30, y: 50, w: 100, h: 100 }, frame, 20)).toEqual({
      ...camera,
      x: 50,
    });
  });
});
