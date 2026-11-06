import { expect, test } from 'bun:test';
import { CONTINUATION_MODES, readContinuationMode } from './run-metadata';

test.each(Object.values(CONTINUATION_MODES))('reads the schema-owned %s mode', mode => {
  expect(readContinuationMode({ continuation: { mode } })).toBe(mode);
});

test('absent continuation stamps preserve legacy behavior', () => {
  expect(readContinuationMode(undefined)).toBeUndefined();
  expect(readContinuationMode({})).toBeUndefined();
});

test.each([undefined, null, 'adopt', {}, { mode: 'unsupported' }, { mode: 7 }])(
  'rejects a present invalid continuation stamp: %j',
  continuation => {
    expect(() => readContinuationMode({ continuation })).toThrow(
      'Invalid recorded continuation metadata.'
    );
  }
);
