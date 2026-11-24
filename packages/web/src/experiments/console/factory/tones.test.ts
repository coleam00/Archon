import { describe, expect, test } from 'bun:test';
import { closePairs, MIN_CHROMA, oklch, PURPLE_PINK, tokens } from './lib/token-hue.test-fixtures';
import { TONES } from './tones';

/**
 * The stage groups' colours (Visual standard, rule 5): saturated, none purple or pink (owner
 * change 1 of 2026-11-19), and apart from each other and from the two status colours a map
 * card's chips show beside them, running and needs you.
 */
describe('the group colours', () => {
  const map = tokens();
  const groups = Object.entries(TONES).map(([tone, { color }]) => {
    const [, chroma, hue] = oklch(color, map);
    return { name: tone, hue, chroma };
  });

  test('every group is a saturated colour, none purple or pink', () => {
    for (const { name, hue, chroma } of groups) {
      expect({ name, saturated: chroma >= MIN_CHROMA }).toEqual({ name, saturated: true });
      const purple = hue >= PURPLE_PINK[0] && hue <= PURPLE_PINK[1];
      expect({ name, purple }).toEqual({ name, purple: false });
    }
  });

  test('every pair, and each against running and needs you, is at least MIN_HUE_GAP apart', () => {
    const chips = ['--running', '--warning'].map(token => ({
      name: token,
      hue: oklch(`var(${token})`, map)[2],
    }));
    expect(closePairs([...groups, ...chips]).filter(pair => !pair.startsWith('--'))).toEqual([]);
  });
});
