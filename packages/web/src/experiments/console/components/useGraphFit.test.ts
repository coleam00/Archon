import { describe, expect, test } from 'bun:test';
import { graphFitScale } from './useGraphFit';

/** The Checks stage's workflow as dagre draws it, before any fit. */
const CHECKS = { width: 628, height: 730 };

describe('the scale a stage graph opens at', () => {
  test('a graph wider than its frame shrinks to the frame width, inside the padding', () => {
    expect(graphFitScale(CHECKS, { width: 362, height: 2000 }, 24)).toBe((362 - 48) / 628);
  });

  test('a graph taller than the room it is left shrinks to that height', () => {
    // The Checks modal at 1440x900: a 542 px frame and about 460 px left under the heading.
    const k = graphFitScale(CHECKS, { width: 542, height: 460 }, 24);
    expect(k).toBe((460 - 48) / 730);
    expect(CHECKS.width * k + 48).toBeLessThanOrEqual(542);
  });

  test('a graph that fits is never enlarged', () => {
    expect(graphFitScale({ width: 228, height: 314 }, { width: 542, height: 700 }, 24)).toBe(1);
  });

  test('no room yet, or a graph with no size, draws at 1, never at nothing or below', () => {
    expect(graphFitScale(CHECKS, { width: 0, height: 0 }, 24)).toBe(1);
    expect(graphFitScale({ width: 0, height: 0 }, { width: 542, height: 460 }, 24)).toBe(1);
  });
});
