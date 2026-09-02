import { describe, it, expect } from 'bun:test';

import {
  assertProducerNotFailed,
  canonicalValueText,
  declaredFieldsFromSchema,
  jsonValueSchema,
  OutputRefError,
  parseWholeInputsRef,
  parseWholeOutputRef,
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

// #2637 — THE deterministic value→text rule: strings raw, everything else canonical
// JSON. Pinned per JSON type so any drift from the pre-extraction inline mappings
// (String(number|boolean), JSON.stringify(array|object|null)) fails here first.
describe('canonicalValueText', () => {
  it('passes strings through raw (never quoted)', () => {
    expect(canonicalValueText('hello world')).toBe('hello world');
    expect(canonicalValueText('')).toBe('');
    expect(canonicalValueText('{"already":"json"}')).toBe('{"already":"json"}');
  });

  it('maps numbers and booleans to their JSON text (identical to String())', () => {
    expect(canonicalValueText(42)).toBe('42');
    expect(canonicalValueText(-1.5)).toBe('-1.5');
    expect(canonicalValueText(true)).toBe('true');
    expect(canonicalValueText(false)).toBe('false');
  });

  it('maps null, arrays, and objects to canonical JSON text', () => {
    expect(canonicalValueText(null)).toBe('null');
    expect(canonicalValueText([1, 'a', null])).toBe('[1,"a",null]');
    expect(canonicalValueText({ b: 1, a: [true] })).toBe('{"b":1,"a":[true]}');
  });

  it("defensively maps JSON-unrepresentable values to '' (unreachable from parsed JSON)", () => {
    expect(canonicalValueText(undefined)).toBe('');
    expect(canonicalValueText(Symbol('x'))).toBe('');
  });
});

describe('jsonValueSchema', () => {
  it('accepts every JSON value shape and rejects undefined', () => {
    for (const value of ['s', 0, -2.5, true, false, null, [1, 'a'], { k: { n: null } }]) {
      expect(jsonValueSchema.safeParse(value).success).toBe(true);
    }
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(new Date()).success).toBe(false);
  });
});

describe('parseWholeOutputRef', () => {
  it('parses a whole unfielded and fielded ref, tolerating surrounding whitespace', () => {
    expect(parseWholeOutputRef('$plan.output')).toEqual({ nodeId: 'plan' });
    expect(parseWholeOutputRef('  $plan.output.items ')).toEqual({
      nodeId: 'plan',
      field: 'items',
    });
  });

  it('returns undefined for templates, prose, and non-refs', () => {
    expect(parseWholeOutputRef('before $plan.output')).toBeUndefined();
    expect(parseWholeOutputRef('$plan.output and after')).toBeUndefined();
    expect(parseWholeOutputRef('$INPUTS.name')).toBeUndefined();
    expect(parseWholeOutputRef('literal')).toBeUndefined();
    expect(parseWholeOutputRef('')).toBeUndefined();
  });
});

describe('parseWholeInputsRef', () => {
  it('parses a whole $INPUTS.<name> ref to its name, tolerating whitespace', () => {
    expect(parseWholeInputsRef('$INPUTS.mode')).toBe('mode');
    expect(parseWholeInputsRef('  $INPUTS.foo-bar ')).toBe('foo-bar');
  });

  it('returns undefined for templates, output refs, and non-refs', () => {
    expect(parseWholeInputsRef('v=$INPUTS.mode')).toBeUndefined();
    expect(parseWholeInputsRef('$INPUTS.mode!')).toBeUndefined();
    expect(parseWholeInputsRef('$plan.output')).toBeUndefined();
    expect(parseWholeInputsRef('literal')).toBeUndefined();
    expect(parseWholeInputsRef('')).toBeUndefined();
  });
});

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
      resolveNodeOutputField(
        { state: 'skipped', output: '', cause: { kind: 'condition', expr: 'false' } },
        'n',
        'field'
      );
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

describe('resolveNodeOutputField — producer failed (#2713)', () => {
  it("throws producer-failed even when the failed producer's leftover output is real, valid JSON", () => {
    // Mirrors a loop_group's failure paths: lastIterationOutput is real, non-empty text
    // that happens to be valid JSON — exactly the shape that let the failed producer's
    // stale output silently resolve before this fix (run 6607bf20 / #2696).
    const failed: NodeOutput = {
      state: 'failed',
      output: JSON.stringify({ ready: true }),
      error: 'loop failed at max_iterations',
    };
    try {
      resolveNodeOutputField(failed, 'corrections', 'ready');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('producer-failed');
      expect((e as OutputRefError).message).toContain("'corrections' failed");
    }
  });

  it('throws producer-failed even when structuredOutput carries the field', () => {
    const failed: NodeOutput = {
      state: 'failed',
      output: '',
      error: 'boom',
      structuredOutput: { ready: true },
    };
    expect(() => resolveNodeOutputField(failed, 'corrections', 'ready')).toThrow(OutputRefError);
  });
});

// #2722 — the shared guard every whole-text $node.output reader routes through, mirroring
// resolveNodeOutputField's own state === 'failed' guard for the fielded form.
describe('assertProducerNotFailed', () => {
  it.each(['completed', 'running', 'pending', 'skipped'] as const)(
    'does not throw for a %s producer',
    state => {
      const nodeOutput: NodeOutput =
        state === 'completed' || state === 'running'
          ? { state, output: 'ok' }
          : state === 'skipped'
            ? { state, output: '', cause: { kind: 'condition', expr: 'false' } }
            : { state, output: '' };
      expect(() => assertProducerNotFailed(nodeOutput, () => 'unreachable')).not.toThrow();
    }
  );

  it("throws with the caller's message for a failed producer", () => {
    const failed: NodeOutput = { state: 'failed', output: 'stale', error: 'boom' };
    expect(() =>
      assertProducerNotFailed(failed, f => `custom message referencing ${f.error}`)
    ).toThrow('custom message referencing boom');
  });

  it('passes the narrowed failed NodeOutput to buildMessage (error accessible without a cast)', () => {
    const failed: NodeOutput = { state: 'failed', output: '', error: 'loop failed' };
    let seenError: string | undefined;
    expect(() =>
      assertProducerNotFailed(failed, f => {
        seenError = f.error;
        return 'x';
      })
    ).toThrow();
    expect(seenError).toBe('loop failed');
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
