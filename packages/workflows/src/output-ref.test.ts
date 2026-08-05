import { describe, it, expect } from 'bun:test';

import {
  declaredFieldsFromSchema,
  OutputRefError,
  resolveNodeOutputField,
  similarNodeIds,
} from './output-ref';
import { buildTruncationMarker, hasTruncationMarker } from './utils/output-truncation';
import type { NodeOutput } from './schemas';

function completed(
  output: string,
  structuredOutput?: unknown,
  declaredFields?: string[]
): NodeOutput {
  return {
    state: 'completed',
    output,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(declaredFields !== undefined ? { declaredFields } : {}),
  };
}

describe('declaredFieldsFromSchema', () => {
  it('returns the property names for an object schema', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: { a: {}, b: {} } })).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns [] for an explicit empty properties map', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: {} })).toEqual([]);
  });

  it('returns undefined when there is no schema', () => {
    expect(declaredFieldsFromSchema(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-object schema (no properties map)', () => {
    expect(declaredFieldsFromSchema({ type: 'array', items: {} })).toBeUndefined();
    expect(declaredFieldsFromSchema({ type: 'string' })).toBeUndefined();
  });

  it('returns undefined when properties is explicitly null', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: null })).toBeUndefined();
  });
});

describe('resolveNodeOutputField — producer did not run', () => {
  it('throws producer-not-run for a skipped producer (clear message, not "unparseable")', () => {
    try {
      resolveNodeOutputField({ state: 'skipped', output: '' }, 'n', 'field');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('producer-not-run');
    }
  });

  it('throws producer-not-run for a pending producer', () => {
    expect(() => resolveNodeOutputField({ state: 'pending', output: '' }, 'n', 'field')).toThrow(
      OutputRefError
    );
  });
});

describe('resolveNodeOutputField — declared-schema producer', () => {
  const declared = ['type', 'note'];

  it('resolves a present declared field from structuredOutput', () => {
    const r = resolveNodeOutputField(
      completed('{"type":"BUG"}', { type: 'BUG' }, declared),
      'n',
      'type'
    );
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });

  it('declared-optional absent field → empty (not a throw)', () => {
    const r = resolveNodeOutputField(
      completed('{"type":"BUG"}', { type: 'BUG' }, declared),
      'n',
      'note'
    );
    expect(r).toEqual({ kind: 'empty' });
  });

  it('explicit null on a declared field → empty', () => {
    const r = resolveNodeOutputField(
      completed('{"type":null}', { type: null }, declared),
      'n',
      'type'
    );
    expect(r).toEqual({ kind: 'empty' });
  });

  it('field not in the declared schema → throws not-in-schema', () => {
    expect(() =>
      resolveNodeOutputField(completed('{"type":"BUG"}', { type: 'BUG' }, ['type']), 'n', 'tpye')
    ).toThrow(OutputRefError);
    try {
      resolveNodeOutputField(completed('{"type":"BUG"}', { type: 'BUG' }, ['type']), 'n', 'tpye');
    } catch (e) {
      expect((e as OutputRefError).reason).toBe('not-in-schema');
    }
  });

  it('falls back to parsing output when structuredOutput is absent (legacy declared row)', () => {
    const r = resolveNodeOutputField(completed('{"type":"BUG"}', undefined, ['type']), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });

  // #2456 — a declared schema must never be QUIETER than no schema at all. Before this,
  // an unparseable output returned empty here while the schemaless path threw, so
  // declaring output_format on a `workflow:` node (whose child output is never
  // validated) silently turned every declared field into ''.
  it('unparseable output → throws, exactly like the schemaless path (#2456)', () => {
    const broken = completed('I could not produce JSON, sorry.', undefined, declared);
    expect(() => resolveNodeOutputField(broken, 'n', 'type')).toThrow(OutputRefError);
    try {
      resolveNodeOutputField(broken, 'n', 'type');
    } catch (e) {
      expect((e as OutputRefError).reason).toBe('unparseable');
    }
  });

  it('declaring a schema is never quieter than declaring none (#2456)', () => {
    const text = 'not json at all';
    const withSchema = (): unknown =>
      resolveNodeOutputField(completed(text, undefined, ['f']), 'n', 'f');
    const withoutSchema = (): unknown => resolveNodeOutputField(completed(text), 'n', 'f');
    // Both throw, and for the same reason — that symmetry IS the contract.
    expect(withSchema).toThrow(OutputRefError);
    expect(withoutSchema).toThrow(OutputRefError);
    const reasonOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return (e as OutputRefError).reason;
      }
      return undefined;
    };
    expect(reasonOf(withSchema)).toBe(reasonOf(withoutSchema));
  });

  // The leniency that SURVIVES: a declared-optional field missing from a payload that
  // genuinely parsed. Only "no parseable object at all" changed.
  it('still lenient for a missing key inside a parsed object (#2456 scope guard)', () => {
    const r = resolveNodeOutputField(completed('{"type":"BUG"}', undefined, declared), 'n', 'note');
    expect(r).toEqual({ kind: 'empty' });
  });
});

/**
 * Clipped-on-persist output parses no better than prose, but the author needs the
 * opposite advice: the producer was right and a RESUMED run is reading the clipped
 * copy. `output_format` lives on `dagNodeBaseSchema`, so a bash node can declare one
 * — and bash stdout is the thing the event cap clips.
 */
describe('resolveNodeOutputField — output clipped before persistence', () => {
  /** What `getDagResumeSnapshot` hands back for a bash node that exceeded the cap. */
  function clipped(payload: string): string {
    return payload.slice(0, 40) + buildTruncationMarker(Buffer.byteLength(payload));
  }

  const bigPayload = JSON.stringify({ verdict: 'pass', blob: 'x'.repeat(40_000) });

  it('reports truncated, not unparseable, on the declared-schema path', () => {
    const node = completed(clipped(bigPayload), undefined, ['verdict', 'blob']);
    try {
      resolveNodeOutputField(node, 'gen', 'verdict');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('truncated');
    }
  });

  it('reports truncated on the schemaless path too — both paths stay symmetric', () => {
    try {
      resolveNodeOutputField(completed(clipped(bigPayload)), 'gen', 'verdict');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as OutputRefError).reason).toBe('truncated');
    }
  });

  it('does not blame truncation for output that merely mentions it', () => {
    // The marker is anchored, so prose quoting the phrase mid-string is still a
    // plain producer error — otherwise this branch would misdiagnose in reverse.
    const prose = 'the log said … [truncated; original output was 5 bytes] and then stopped';
    try {
      resolveNodeOutputField(completed(prose, undefined, ['verdict']), 'gen', 'verdict');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as OutputRefError).reason).toBe('unparseable');
    }
  });

  it('says the producer was probably right, and points at the artifacts dir', () => {
    const err = new OutputRefError('gen', 'verdict', 'truncated');
    expect(err.message).toContain('clipped');
    expect(err.message).toContain('$ARTIFACTS_DIR');
    // The old advice was actively wrong here — the node DID emit the field.
    expect(err.message).not.toContain('Emit JSON containing');
  });

  it('marker round-trips through build/detect', () => {
    const output = `head${buildTruncationMarker(1234)}`;
    expect(hasTruncationMarker(output)).toBe(true);
    expect(hasTruncationMarker(`${output}\n \t`)).toBe(true);
    expect(hasTruncationMarker('no marker here')).toBe(false);
  });
});

describe('resolveNodeOutputField — structuredOutput without a declared schema (lenient)', () => {
  it('resolves a present field', () => {
    const r = resolveNodeOutputField(completed('prose', { type: 'BUG' }), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });

  it('absent field → empty (no throw — cannot enforce a contract we do not have)', () => {
    const r = resolveNodeOutputField(completed('prose', { type: 'BUG' }), 'n', 'missing');
    expect(r).toEqual({ kind: 'empty' });
  });

  it('present null is kept as a value (callers stringify to "null")', () => {
    const r = resolveNodeOutputField(completed('prose', { type: null }), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: null });
  });

  it('non-object structuredOutput falls through to the schemaless path', () => {
    // structuredOutput is an array → not a usable object → parse output instead.
    const r = resolveNodeOutputField(completed('{"type":"BUG"}', [1, 2, 3]), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });
});

describe('resolveNodeOutputField — schemaless producer (bash/script/prose)', () => {
  it('resolves a present key from JSON output', () => {
    const r = resolveNodeOutputField(completed('{"status":"done"}'), 'n', 'status');
    expect(r).toEqual({ kind: 'value', value: 'done' });
  });

  it('strips a code fence before parsing', () => {
    const r = resolveNodeOutputField(completed('```json\n{"status":"done"}\n```'), 'n', 'status');
    expect(r).toEqual({ kind: 'value', value: 'done' });
  });

  it('non-JSON output → throws unparseable', () => {
    try {
      resolveNodeOutputField(completed('just prose'), 'n', 'status');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('unparseable');
    }
  });

  it('valid JSON but missing key → throws missing-key', () => {
    try {
      resolveNodeOutputField(completed('{"status":"done"}'), 'n', 'other');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('missing-key');
    }
  });

  it('top-level JSON array → throws unparseable (no named fields)', () => {
    expect(() => resolveNodeOutputField(completed('[1,2,3]'), 'n', 'x')).toThrow(OutputRefError);
  });
});

describe('OutputRefError — unknown-node', () => {
  it('names the unknown id and the whole ref', () => {
    const e = new OutputRefError('typo', 'field', 'unknown-node');
    expect(e.reason).toBe('unknown-node');
    expect(e.message).toContain("'typo'");
    expect(e.message).toContain('$typo.output.field');
    // Accurate for both a typo AND a real node that has not run before the ref.
    expect(e.message).toContain('has not run before this reference');
  });

  it('appends a did-you-mean hint when candidates are supplied', () => {
    const e = new OutputRefError('analze', 'type', 'unknown-node', ['analyze', 'classify']);
    expect(e.message).toContain('Did you mean');
    expect(e.message).toContain("'analyze'");
    expect(e.message).toContain("'classify'");
  });

  it('omits the did-you-mean hint when no candidates are close', () => {
    const e = new OutputRefError('zzz', 'field', 'unknown-node', []);
    expect(e.message).not.toContain('Did you mean');
  });
});

describe('similarNodeIds', () => {
  it('ranks the nearest known id first', () => {
    const result = similarNodeIds('analze', ['analyze', 'build', 'classify']);
    expect(result[0]).toBe('analyze');
  });

  it('returns [] when nothing is close', () => {
    expect(similarNodeIds('xyzzy', ['analyze', 'build'])).toEqual([]);
  });

  it('accepts a Map keys iterable', () => {
    const map = new Map<string, NodeOutput>([['analyze', completed('x')]]);
    expect(similarNodeIds('analze', map.keys())).toContain('analyze');
  });
});
