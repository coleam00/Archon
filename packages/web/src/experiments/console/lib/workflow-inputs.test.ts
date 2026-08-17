import { describe, test, expect } from 'bun:test';
import { missingRequiredInputs, collectSuppliedInputs } from './workflow-inputs';
import type { WorkflowInput } from '../primitives/workflow';

function input(over: Partial<WorkflowInput> & { name: string }): WorkflowInput {
  return { required: false, default: null, description: null, ...over };
}

const DECLARED: WorkflowInput[] = [
  input({ name: 'diff', required: true }),
  input({ name: 'style', default: 'strict' }),
  input({ name: 'notes' }),
];

describe('missingRequiredInputs', () => {
  test('names required inputs with no value, in declaration order', () => {
    const declared = [
      input({ name: 'diff', required: true }),
      input({ name: 'style' }),
      input({ name: 'plan', required: true }),
    ];
    expect(missingRequiredInputs(declared, {})).toEqual(['diff', 'plan']);
  });

  test('treats a whitespace-only value as unfilled', () => {
    expect(missingRequiredInputs(DECLARED, { diff: '   ' })).toEqual(['diff']);
  });

  test('is empty once every required input has a value', () => {
    expect(missingRequiredInputs(DECLARED, { diff: 'D1' })).toEqual([]);
  });

  test('never blocks on an optional input, defaulted or not', () => {
    expect(missingRequiredInputs([input({ name: 'style', default: 'strict' })], {})).toEqual([]);
  });

  test('is empty for a workflow declaring no inputs', () => {
    expect(missingRequiredInputs([], {})).toEqual([]);
  });
});

describe('collectSuppliedInputs', () => {
  test('sends only the filled inputs', () => {
    expect(collectSuppliedInputs(DECLARED, { diff: 'D1', style: '', notes: 'n' })).toEqual({
      diff: 'D1',
      notes: 'n',
    });
  });

  test('omits an untouched defaulted input so its declared default still applies', () => {
    // Sending `style: ''` would override `default: strict` with nothing — the exact
    // silent-wrong-value bug this omission prevents.
    expect(collectSuppliedInputs(DECLARED, { diff: 'D1' })).toEqual({ diff: 'D1' });
  });

  test('ignores values for names the workflow does not declare', () => {
    // A stale value from a previously selected workflow must never be submitted:
    // the server rejects undeclared keys, so this would fail the whole run.
    expect(collectSuppliedInputs(DECLARED, { diff: 'D1', stlye: 'terse' })).toEqual({ diff: 'D1' });
  });

  test('preserves whitespace inside a value it does send', () => {
    expect(collectSuppliedInputs(DECLARED, { diff: '  padded  ' })).toEqual({
      diff: '  padded  ',
    });
  });

  test('is empty when nothing is filled', () => {
    expect(collectSuppliedInputs(DECLARED, {})).toEqual({});
  });
});
