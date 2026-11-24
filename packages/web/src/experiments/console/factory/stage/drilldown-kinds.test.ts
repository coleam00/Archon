import { expect, test } from 'bun:test';
import { KIND_TONES } from '../lib/step-kinds';
import { MIN_CHROMA, oklch, PURPLE_PINK, tokens } from '../lib/token-hue.test-fixtures';
import { KINDS } from './drilldown-kinds';

// Owner change 1: step and drill-down kinds are saturated colours, none purple or pink.
const colours: [string, string, boolean][] = [
  ...Object.entries(KIND_TONES).map(([kind, c]): [string, string, boolean] => [
    `step ${kind}`,
    c,
    kind !== 'other',
  ]),
  ...Object.entries(KINDS).map(([kind, { color }]): [string, string, boolean] => [
    `card ${kind}`,
    color,
    true,
  ]),
];

test.each(colours)(
  'the %s colour is saturated and not purple or pink',
  (_kind, color, saturated) => {
    const [, chroma, hue] = oklch(color, tokens());
    expect(hue >= PURPLE_PINK[0] && hue <= PURPLE_PINK[1]).toBe(false);
    if (saturated) expect(chroma).toBeGreaterThanOrEqual(MIN_CHROMA);
  }
);
