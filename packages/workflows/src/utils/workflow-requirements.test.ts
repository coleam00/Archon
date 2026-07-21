import { describe, test, expect } from 'bun:test';
import { assertWorkflowRequirementsMet, WorkflowRequirementError } from './workflow-requirements';

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
