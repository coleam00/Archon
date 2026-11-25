import { describe, expect, test } from 'bun:test';
import { columnsOf } from '../../routes/BoardPage';
import { shippedGraph } from '../curated.test-fixtures';
import { LIVE_FITTING } from '../map/useMapCamera';
import { fullWorkflowLayout } from './full-workflow-layout';
import { fitCamera } from './map-camera';
import { boxesMeet } from './map-geometry.test-fixtures';

describe("the shipped pack's full workflow", () => {
  const layout = fullWorkflowLayout(shippedGraph, columnsOf(shippedGraph));
  const named = layout.arrows.map(arrow => ({
    name: `${arrow.from}>${arrow.to} [${arrow.lines.join('/')}]`,
    box: arrow.pillBox,
  }));

  test('no pill meets another pill', () => {
    const faults: string[] = [];
    named.forEach((pill, i) =>
      named.forEach((other, j) => {
        if (i < j && boxesMeet(pill.box, other.box)) faults.push(`${pill.name} | ${other.name}`);
      })
    );
    expect(faults).toEqual([]);
  });

  test('no pill meets a card', () => {
    const faults = named.flatMap(pill =>
      layout.cards
        .filter(card => boxesMeet(pill.box, card.box))
        .map(card => `${pill.name} | ${card.id}`)
    );
    expect(faults).toEqual([]);
  });

  test('every pill sits inside the bounds the camera fits', () => {
    const { bounds } = layout;
    for (const { box } of named) {
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(box.y + box.h).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
  });

  test('the whole graph opens inside the Overview frame at 1440x900 (about 1110x720)', () => {
    const frame = { width: 1110, height: 720 };
    const { pad } = LIVE_FITTING;
    const camera = fitCamera(layout.bounds, frame, pad, 0.4, 1);
    const { bounds } = layout;
    expect(camera.k).toBeGreaterThanOrEqual(0.4);
    expect(bounds.x * camera.k + camera.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y * camera.k + camera.y).toBeGreaterThanOrEqual(0);
    expect((bounds.x + bounds.w) * camera.k + camera.x).toBeLessThanOrEqual(frame.width);
    expect((bounds.y + bounds.h) * camera.k + camera.y).toBeLessThanOrEqual(frame.height);
  });
});
