import { describe, expect, test } from 'bun:test';
import { tipShift } from './tip-shift';

describe('keeping a map tip inside its frame, 8 px from its edges', () => {
  const frame = { left: 16, right: 374 };
  test('a tip inside stays put', () => {
    expect(tipShift({ left: 100, right: 310 }, frame)).toBe(0);
  });
  test('one past the right edge moves left, to the edge less the room', () => {
    expect(tipShift({ left: 221, right: 431 }, frame)).toBe(-65);
  });
  test('one past the left edge moves right', () => {
    expect(tipShift({ left: 0, right: 210 }, frame)).toBe(24);
  });
  test('one wider than the frame starts at its left edge', () => {
    expect(tipShift({ left: 100, right: 500 }, frame)).toBe(-76);
  });
});
