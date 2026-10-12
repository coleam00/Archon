import { expect, test } from 'bun:test';
import { isJsonPointer, resolveJsonPointer } from './json-pointer';

const document = { nested: { items: [null, { 'a/b': { '~key': false } }] }, '': 7 };
test.each([
  ['', document],
  ['/nested/items/0', null],
  ['/nested/items/1/a~1b/~0key', false],
  ['/', 7],
  ['/nested/items/01', undefined],
  ['/nested/items/-', undefined],
  ['/nested/items/2', undefined],
  ['/nested/items/0/x', undefined],
  ['/toString', undefined],
  ['/constructor', undefined],
  ['/missing', undefined],
] as const)('resolves %s through own JSON properties', (pointer, expected) => {
  expect(resolveJsonPointer(document, pointer)).toEqual(expected);
});
test.each(['abc', '/~', '/~2', '/a~x'])('rejects invalid pointer %s', pointer => {
  expect(isJsonPointer(pointer)).toBe(false);
});
