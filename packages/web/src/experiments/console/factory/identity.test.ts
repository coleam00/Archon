import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The canvases' identity lives in tokens (DESIGN.md, "Visual identity, 2026-11-19"): theme.css
 * defines the depth, light, tint and texture, and the files that draw the map, How it works and
 * the stage drill-down's cards use them by class, never with a one-off shadow or colour.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The sources that draw the canvases' cards, lines, dots and legends. */
const CANVAS_SOURCES = [
  'canvas-lines.tsx',
  'map/FactoryMap.tsx',
  'map/MapArrows.tsx',
  'map/MapCard.tsx',
  'map/MapChips.tsx',
  'map/MapFlow.tsx',
  'map/MapLegend.tsx',
  'map/MapStageRow.tsx',
  'overview/OverviewCard.tsx',
  'overview/OverviewEdges.tsx',
  'overview/OverviewFlow.tsx',
  'overview/OverviewLegend.tsx',
  'stage/DrilldownCard.tsx',
];

describe('the canvas identity', () => {
  test('theme.css defines its tokens and classes', () => {
    const css = read('../theme.css');
    for (const token of [
      '--tone-intake',
      '--card-depth',
      '--card-depth-hover',
      '--card-glow',
      '--card-tint',
      '--canvas-texture',
      '--running-fill',
      '--running-border',
      '--running-ring',
    ])
      expect({ token, defined: new RegExp(`${token}:`).test(css) }).toEqual({
        token,
        defined: true,
      });
    for (const rule of [
      '.factory-card {',
      '.factory-card[data-lit]',
      '.factory-card[data-running]',
      '.factory-canvas {',
    ])
      expect({ rule, defined: css.includes(rule) }).toEqual({ rule, defined: true });
  });

  test('no canvas source writes its own shadow or colour', () => {
    const found: string[] = [];
    for (const file of CANVAS_SOURCES) {
      const source = read(file);
      for (const [pattern, what] of [
        [/\bshadow-(?:sm|md|lg|xl|2xl|inner)\b/, 'a shadow utility'],
        [/\bboxShadow\b/, 'an inline box-shadow'],
        [/\boklch\(/, 'an oklch literal'],
        [/['"`\s(:]#[0-9a-fA-F]{3,8}\b/, 'a hex colour'],
      ] as const)
        if (pattern.test(source)) found.push(`${file}: ${what}`);
    }
    expect(found).toEqual([]);
  });
});
