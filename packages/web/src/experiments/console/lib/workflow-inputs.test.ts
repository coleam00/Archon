import { describe, test, expect } from 'bun:test';
import { collectSuppliedInputs } from './workflow-inputs';
import type { WorkflowInput } from '../primitives/workflow';

function input(over: Partial<WorkflowInput> & { name: string }): WorkflowInput {
  return { required: false, default: null, description: null, ...over };
}

const DECLARED: WorkflowInput[] = [
  input({ name: 'diff', required: true }),
  input({ name: 'style', default: 'strict' }),
  input({ name: 'notes' }),
];

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
