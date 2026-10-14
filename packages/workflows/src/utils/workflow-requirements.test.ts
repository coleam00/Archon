import { describe, test, expect } from 'bun:test';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
  resolveTopLevelInputs,
  WorkflowMissingInputsError,
} from './workflow-requirements';
import { WorkflowInputContractError } from '../workflow-inputs';

describe('assertWorkflowRequirementsMet', () => {
  test('passes when there are no requirements', () => {
    expect(() => assertWorkflowRequirementsMet({}, { githubConnected: false })).not.toThrow();
    expect(() =>
      assertWorkflowRequirementsMet({ requires: [] }, { githubConnected: false })
    ).not.toThrow();
  });

  test('passes when github is required and the user is connected', () => {
    expect(() =>
      assertWorkflowRequirementsMet({ requires: ['github'] }, { githubConnected: true })
    ).not.toThrow();
  });

  test('throws WorkflowRequirementError when github is required but not connected', () => {
    let thrown: unknown;
    try {
      assertWorkflowRequirementsMet({ requires: ['github'] }, { githubConnected: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowRequirementError);
    expect((thrown as WorkflowRequirementError).requirement).toBe('github');
    // user-facing message names a connect path
    expect((thrown as WorkflowRequirementError).message).toContain('connect github');
  });
});

describe('resolveTopLevelInputs (#2470, #2554)', () => {
  test('returns undefined with no declared inputs and nothing supplied', () => {
    expect(resolveTopLevelInputs({}, undefined)).toBeUndefined();
    expect(resolveTopLevelInputs({ inputs: {} }, undefined)).toBeUndefined();
  });

  test('passes when all declared inputs are optional or defaulted', () => {
    expect(
      resolveTopLevelInputs(
        { inputs: { a: { default: 'x' }, b: { description: 'opt' } } },
        undefined
      )
    ).toBeUndefined();
  });

  test('returns ONLY the supplied values — declared defaults stay derived at execution', () => {
    // `style` has a default, but nothing was supplied for it, so it must not appear here:
    // persisting a derived default would freeze a snapshot of the workflow's current YAML.
    expect(
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, style: { default: 'strict' } } },
        { diff: 'D' }
      )
    ).toEqual({ diff: 'D' });
  });

  test('a required input that IS supplied satisfies the gate — the whole point of #2554', () => {
    expect(
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, plan: { required: true } } },
        { diff: 'D', plan: 'P' }
      )
    ).toEqual({ diff: 'D', plan: 'P' });
  });

  test('throws naming missing required inputs, and names the channels that can supply them', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(
        {
          name: 'block',
          inputs: { diff: { required: true }, plan: { required: true }, style: { default: 's' } },
        },
        undefined
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowMissingInputsError);
    const err = thrown as WorkflowMissingInputsError;
    expect(err.missing).toEqual(['diff', 'plan']);
    expect(err.message).toContain("'diff', 'plan'");
    expect(err.message).toContain('--input');
    expect(err.message).toContain('console');
    // The framing this issue removed: a required-input workflow is NOT uncallable.
    expect(err.message).not.toContain('reusable block');
  });

  test('throws when only SOME required inputs are supplied, naming just the missing one', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(
        { name: 'block', inputs: { diff: { required: true }, plan: { required: true } } },
        { diff: 'D' }
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as WorkflowMissingInputsError).missing).toEqual(['plan']);
  });

  test('rejects an undeclared key the same way a composing `with:` map is rejected', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs({ name: 'block', inputs: { style: {} } }, { stlye: 'terse' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowInputContractError);
    const err = thrown as WorkflowInputContractError;
    expect(err.undeclared).toEqual(['stlye']);
    expect(err.message).toContain('stlye');
    expect(err.message).toContain('style');
  });

  test('a workflow declaring no inputs keeps Phase-1 passthrough for supplied values', () => {
    expect(resolveTopLevelInputs({ name: 'legacy' }, { anything: 'goes' })).toEqual({
      anything: 'goes',
    });
  });
});
