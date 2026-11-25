import { describe, expect, test } from 'bun:test';
import {
  cappedHeight,
  FIT_PAD,
  fitCamera,
  MIN_FRAME_HEIGHT,
  MIN_ZOOM,
  READABLE_K,
  reveal,
  zoomAt,
} from './map-camera';
import { LIVE_FITTING } from '../map/useMapCamera';
import { layoutMap } from './map-layout';
import { shippedArrows, shippedView } from '../curated.test-fixtures';

const world = { x: 0, y: -10, w: 1000, h: 200 };

describe('the map camera', () => {
  test('fit centres the map in the frame at the largest scale that holds it, inside the padding', () => {
    const camera = fitCamera(world, { width: 848, height: 400 }, 24, MIN_ZOOM);
    expect(camera.k).toBe(0.8);
    expect(camera.x).toBe(24);
    // 200 tall at 0.8 is 160, centred in 400; the world starts at y -10.
    expect(camera.y).toBe(120 + 8);
  });

  test('a frame too narrow for the whole map opens on its start, at the readable scale', () => {
    const camera = fitCamera(world, { width: 400, height: 300 }, 24);
    expect(camera.k).toBe(READABLE_K);
    // The world's left edge at the padding: the first stages show, the rest pans.
    expect(camera.x).toBe(24);
  });

  test('the shipped map opens whole in a 1440 frame, and at its start on narrower ones', () => {
    const { bounds } = layoutMap(shippedView, shippedArrows);
    // The live map's own fitting, as the Overview's map camera uses it.
    const { pad, minK } = LIVE_FITTING;
    // The Overview's frame at 1440x900 is about 1110 px wide: every card shows, Merged included.
    for (const width of [1110, 1280, 1600]) {
      const camera = fitCamera(bounds, { width, height: 2000 }, pad, minK);
      expect(bounds.w * camera.k).toBeLessThanOrEqual(width - 2 * FIT_PAD);
    }
    // A phone opens at the least live scale, at the row's start, and pans to the rest.
    for (const width of [320, 390, 768]) {
      const camera = fitCamera(bounds, { width, height: 2000 }, pad, minK);
      expect(camera.k).toBe(minK);
      expect(camera.x).toBe(FIT_PAD);
    }
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

  test('a capped frame stops at its share of the window, never under the least frame; a shorter one stands', () => {
    // The Overview's Full workflow at 1440x900: fitted to its width it would be 853 tall.
    expect(cappedHeight(853, 900, 0.8)).toBe(720);
    expect(cappedHeight(400, 900, 0.8)).toBe(400);
    expect(cappedHeight(853, 200, 0.8)).toBe(MIN_FRAME_HEIGHT);
  });
});
