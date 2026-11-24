/**
 * Test helpers that resolve a console colour token to its oklch value, for the tests that hold
 * the canvases' colours apart by hue (`overview-kinds.test.ts`, `tones.test.ts`).
 */
import { readFileSync } from 'node:fs';

/** Purple through pink, which owner change 1 of 2026-11-19 keeps off the canvases. */
export const PURPLE_PINK: [number, number] = [270, 350];
/** Under this chroma a colour reads as grey, whatever its hue. */
export const MIN_CHROMA = 0.1;
/**
 * The least hue gap between two colours that must read apart. Distinct tokens are not enough:
 * two tokens two degrees apart look alike on a 3 px bar, where lightness alone does not tell
 * them apart. The console's non-purple hue families sit about 30 degrees apart at the closest.
 */
export const MIN_HUE_GAP = 25;

/** Every `--name: value;` the console sees: index.css's :root, then theme.css's, which wins. */
export function tokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of ['../../../../index.css', '../../theme.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [, name, value] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g))
      map.set(name as string, (value as string).trim());
  }
  return map;
}

/** A colour's oklch lightness, chroma and hue, following `var()` until a literal. */
export function oklch(colour: string, map: Map<string, string>): [number, number, number] {
  const ref = /^var\((--[\w-]+)\)$/.exec(colour);
  if (ref) {
    const value = map.get(ref[1] as string);
    if (value === undefined) throw new Error(`no token ${ref[1] as string}`);
    return oklch(value, map);
  }
  const literal = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(colour);
  if (!literal) throw new Error(`not an oklch colour: ${colour}`);
  return [Number(literal[1]), Number(literal[2]), Number(literal[3])];
}

export const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** Each pair of `colours` closer than MIN_HUE_GAP, as `a/b: N°`; empty when none. */
export function closePairs(colours: readonly { name: string; hue: number }[]): string[] {
  const close: string[] = [];
  for (const [i, a] of colours.entries())
    for (const b of colours.slice(i + 1))
      if (hueGap(a.hue, b.hue) < MIN_HUE_GAP)
        close.push(`${a.name}/${b.name}: ${hueGap(a.hue, b.hue).toString()}°`);
  return close;
}
