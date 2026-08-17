import { describe, test, expect } from 'bun:test';
import { NODE_ID_PATTERN, NODE_ID_SOURCE, OUTPUT_REF_SOURCE, findOutputRefs } from './node-ref';

// Parser behavior only. The check that this definition still matches the
// engine's lives at `scripts/node-ref-parity.test.ts` — a repository-level
// concern, not a unit-test one.

describe('findOutputRefs', () => {
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

  test('repeated calls are independent — no lastIndex carried between scans', () => {
    // A shared `g` regex would resume from the previous match and lose the
    // first ref on the second call.
    const text = '$one.output then $two.output';
    expect(findOutputRefs(text)).toEqual(findOutputRefs(text));
    expect(findOutputRefs(text)).toEqual(new Set(['one', 'two']));
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

describe('OUTPUT_REF_SOURCE', () => {
  test('embeds the shared id grammar', () => {
    expect(OUTPUT_REF_SOURCE).toContain(NODE_ID_SOURCE);
  });
});
