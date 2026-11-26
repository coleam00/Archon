import { expect, test } from 'bun:test';
import { CONTINUATION_MODES, readContinuationMode, readSuppliedRunInputs } from './run-metadata';

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

// A run list serializes this for every row, so one row's unrelated corrupt metadata
// must not make it throw.
test('supplied inputs read past corrupt sub-run metadata and leave out unsupplied inputs', () => {
  expect(
    readSuppliedRunInputs({
      dispatch: { base_branch: 'dev', supplied_inputs: ['issue'] },
      inputs: { issue: '42', notes: 'from-default' },
      summary_declared_output_paths: 'not a path contract',
    })
  ).toEqual({ issue: '42' });
});
