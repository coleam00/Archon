import { describe, expect, test } from 'bun:test';
import { fitCamera, fittedHeight, MIN_ZOOM, READABLE_K, reveal, zoomAt } from './map-camera';
import { layoutMap } from './map-layout';
import { shippedView } from '../item-detail.test-fixtures';

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

  test('the shipped map opens at the readable scale at every frame width', () => {
    const { bounds } = layoutMap(shippedView);
    for (const width of [320, 390, 768, 1100, 1280, 1600]) {
      const camera = fitCamera(bounds, { width, height: fittedHeight(bounds, width) });
      expect(camera.k).toBe(READABLE_K);
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
});
