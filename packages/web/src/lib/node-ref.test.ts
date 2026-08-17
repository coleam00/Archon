import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_ID_PATTERN, NODE_ID_SOURCE, findOutputRefs, outputRefPattern } from './node-ref';

/**
 * `@archon/web` must never import `@archon/workflows`, and `api.generated.d.ts`
 * is type-only, so the engine's `OUTPUT_REF_SOURCE` cannot reach this package as
 * a value. Reading the engine file as TEXT keeps the package boundary intact
 * while still failing loudly when the two definitions diverge — the alarm a
 * KEEP IN SYNC comment cannot raise.
 */
const ENGINE_LOADER = join(import.meta.dir, '..', '..', '..', 'workflows', 'src', 'loader.ts');

function engineOutputRefSource(): string {
  const source = readFileSync(ENGINE_LOADER, 'utf8');
  const match = /const OUTPUT_REF_SOURCE = String\.raw`([^`]*)`/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      `Could not find OUTPUT_REF_SOURCE in ${ENGINE_LOADER}. If the engine moved or renamed it, ` +
        're-point this drift guard and packages/web/src/lib/node-ref.ts together.'
    );
  }
  return match[1];
}

describe('node-ref drift guard', () => {
  test('the web copy is byte-identical to the engine definition', () => {
    expect(outputRefPattern().source).toBe(engineOutputRefSource());
  });

  test('the engine definition contains the hyphen this package once dropped', () => {
    // Pins the specific regression: `/\$(\w+)\.output/` excluded `-` and so
    // matched none of the hyphenated ids the bundled workflows use.
    expect(engineOutputRefSource()).toContain('-');
  });
});

describe('outputRefPattern', () => {
  test('matches a hyphenated node id', () => {
    expect(findOutputRefs('review $check-reproduction.output now')).toEqual(
      new Set(['check-reproduction'])
    );
  });

  test('matches underscore and mixed ids, and collects every distinct ref', () => {
    expect(findOutputRefs('$a_1.output and $b-2.output and $a_1.output again')).toEqual(
      new Set(['a_1', 'b-2'])
    );
  });

  test('captures only the id, not a trailing field access', () => {
    expect(findOutputRefs("when $classify.output.verdict == 'BUG'")).toEqual(new Set(['classify']));
  });

  test('does not match an id starting with a digit', () => {
    expect(findOutputRefs('$1step.output')).toEqual(new Set());
  });

  test('returns an independent instance so a stale lastIndex cannot skip matches', () => {
    const first = outputRefPattern();
    first.exec('$one.output $two.output');
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(outputRefPattern().lastIndex).toBe(0);
  });
});

describe('NODE_ID_PATTERN', () => {
  test('accepts the engine id grammar and rejects everything else', () => {
    expect(NODE_ID_PATTERN.test('check-reproduction')).toBe(true);
    expect(NODE_ID_PATTERN.test('_private')).toBe(true);
    expect(NODE_ID_PATTERN.test('1step')).toBe(false);
    expect(NODE_ID_PATTERN.test('has space')).toBe(false);
    expect(NODE_ID_PATTERN.test('has.dot')).toBe(false);
  });

  test('is built from the shared source', () => {
    expect(NODE_ID_PATTERN.source).toBe(`^${NODE_ID_SOURCE}$`);
  });
});
