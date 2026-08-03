import { describe, test, expect } from 'bun:test';
import {
  assertWorkflowRequirementsMet,
  WorkflowRequirementError,
  assertWorkflowInputsSatisfiable,
  WorkflowMissingInputsError,
} from './workflow-requirements';

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

describe('assertWorkflowInputsSatisfiable (#2470)', () => {
  test('passes with no declared inputs', () => {
    expect(() => assertWorkflowInputsSatisfiable({})).not.toThrow();
    expect(() => assertWorkflowInputsSatisfiable({ inputs: {} })).not.toThrow();
  });

  test('passes when all declared inputs are optional or defaulted', () => {
    expect(() =>
      assertWorkflowInputsSatisfiable({
        inputs: { a: { default: 'x' }, b: { description: 'optional' } },
      })
    ).not.toThrow();
  });

  test('throws naming missing required inputs on a bare top-level run', () => {
    let thrown: unknown;
    try {
      assertWorkflowInputsSatisfiable({
        name: 'block',
        inputs: { diff: { required: true }, plan: { required: true }, style: { default: 's' } },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowMissingInputsError);
    expect((thrown as WorkflowMissingInputsError).missing).toEqual(['diff', 'plan']);
    expect((thrown as WorkflowMissingInputsError).message).toContain("'diff', 'plan'");
    expect((thrown as WorkflowMissingInputsError).message).toContain('with:');
  });
});
