import { describe, expect, test } from 'bun:test';
import { MIN_CHROMA, oklch, PURPLE_PINK, tokens } from '../lib/token-hue.test-fixtures';
import { KINDS } from './drilldown-kinds';

describe('the stage drill-down kind colours', () => {
  test('every kind is a saturated colour, none purple or pink (owner change 1)', () => {
    const map = tokens();
    for (const [kind, { color }] of Object.entries(KINDS)) {
      const [, chroma, hue] = oklch(color, map);
      expect({ kind, saturated: chroma >= MIN_CHROMA }).toEqual({ kind, saturated: true });
      const purple = hue >= PURPLE_PINK[0] && hue <= PURPLE_PINK[1];
      expect({ kind, purple }).toEqual({ kind, purple: false });
    }
  });
});
