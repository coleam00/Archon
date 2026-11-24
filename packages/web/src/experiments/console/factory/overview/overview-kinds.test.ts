import { describe, expect, test } from 'bun:test';
import { closePairs, MIN_CHROMA, oklch, PURPLE_PINK, tokens } from '../lib/token-hue.test-fixtures';
import { KINDS } from './overview-kinds';

describe('the overview kind colours', () => {
  const map = tokens();
  const kinds = Object.entries(KINDS).map(([kind, { color }]) => ({
    kind,
    hue: oklch(color, map)[2],
    chroma: oklch(color, map)[1],
  }));

  test('every kind is a saturated colour, none purple or pink', () => {
    for (const { kind, hue, chroma } of kinds) {
      expect({ kind, saturated: chroma >= MIN_CHROMA }).toEqual({ kind, saturated: true });
      const purple = hue >= PURPLE_PINK[0] && hue <= PURPLE_PINK[1];
      expect({ kind, purple }).toEqual({ kind, purple: false });
    }
  });

  test('no two kinds share a colour: every pair is at least MIN_HUE_GAP degrees of hue apart', () => {
    expect(closePairs(kinds.map(({ kind, hue }) => ({ name: kind, hue })))).toEqual([]);
  });
});
