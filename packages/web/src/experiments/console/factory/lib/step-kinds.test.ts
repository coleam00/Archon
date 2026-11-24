import { describe, expect, test } from 'bun:test';
import { MIN_CHROMA, oklch, PURPLE_PINK, tokens } from './token-hue.test-fixtures';
import { KIND_TONES } from './step-kinds';

describe('the step kind colours', () => {
  test('every kind but "other" is a saturated colour, none purple or pink (owner change 1)', () => {
    const map = tokens();
    for (const [kind, color] of Object.entries(KIND_TONES)) {
      const [, chroma, hue] = oklch(color, map);
      const purple = hue >= PURPLE_PINK[0] && hue <= PURPLE_PINK[1];
      expect({ kind, purple }).toEqual({ kind, purple: false });
      if (kind !== 'other')
        expect({ kind, saturated: chroma >= MIN_CHROMA }).toEqual({ kind, saturated: true });
    }
  });
});
