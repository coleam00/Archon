// @archon-test-isolated
import { expect, test } from 'bun:test';
import {
  applyStatePatch,
  stateValueSchema,
  StatePatchError,
  validateStateValue,
  StateDocumentTooLargeError,
} from './state-document-store';

test('patch pointers escape segments, create missing objects and arrays, and never mutate inputs', () => {
  const input = { 'a/b': { '~': [1, 2, 3] } };
  expect(
    applyStatePatch(input, [
      { op: 'remove', path: '/a~1b/~0/1' },
      { op: 'set', path: '/a~1b/~0/1', value: 4 },
      { op: 'append', path: '/new/items', value: true },
    ])
  ).toEqual({ 'a/b': { '~': [1, 4] }, new: { items: [true] } });
  expect(input).toEqual({ 'a/b': { '~': [1, 2, 3] } });
  expect(applyStatePatch([], [{ op: 'append', path: '', value: 1 }])).toEqual([1]);
  expect(applyStatePatch({}, [{ op: 'set', path: '', value: [false] }])).toEqual([false]);
  expect(applyStatePatch({}, [{ op: 'set', path: '/', value: 1 }])).toEqual({ '': 1 });
});
test('invalid pointer operations carry the failing index and leave the original intact', () => {
  for (const path of ['/a/01', '/a/-', '/a/3', '/missing', '/a/~2']) {
    expect(() => applyStatePatch({ a: [1] }, [{ op: 'remove', path }], 'ledger')).toThrow(
      StatePatchError
    );
  }
  expect(() =>
    applyStatePatch(
      {},
      [
        { op: 'set', path: '/ok', value: true },
        { op: 'append', path: '/ok', value: 1 },
      ],
      'ledger'
    )
  ).toThrow('operation 1');
  expect(() => applyStatePatch({}, [{ op: 'set', path: '', value: null }])).toThrow(
    StatePatchError
  );
});
test('pointer keys cannot change prototypes or access inherited properties', () => {
  const result = applyStatePatch({}, [
    { op: 'set', path: '/__proto__/polluted', value: true },
    { op: 'append', path: '/constructor', value: 1 },
  ]);
  expect(result).toEqual(JSON.parse('{"__proto__":{"polluted":true},"constructor":[1]}'));
  expect(Object.hasOwn({}, 'polluted')).toBe(false);
});
test('cap counts UTF-8 JSON bytes and accepts exactly 64 KiB', () => {
  validateStateValue('x'.repeat(65534));
  expect(() => validateStateValue('x'.repeat(65535))).toThrow(StateDocumentTooLargeError);
  expect(() => validateStateValue('é'.repeat(32768))).toThrow(StateDocumentTooLargeError);
});

test('JSON validation rejects invalid members without transforming valid objects', () => {
  const source = JSON.parse('{"__proto__":{"kept":true},"nested":[{"__proto__":null}]}') as unknown;
  expect(source).toBe(stateValueSchema.parse(source));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const invalidPrototypeMember = Object.defineProperty({}, '__proto__', {
    value: undefined,
    enumerable: true,
  });
  for (const value of [
    cycle,
    invalidPrototypeMember,
    [undefined],
    new Array(1),
    NaN,
    Infinity,
    new Date(),
  ]) {
    expect(stateValueSchema.safeParse(value).success).toBe(false);
  }
});
