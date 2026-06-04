import { describe, expect, test } from 'bun:test';
import { validateBundledWorkflowAliases } from './workflow-discovery';
import type { WorkflowDefinition } from './schemas';

function makeWorkflow(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'test',
    description: 'test',
    nodes: [],
    ...overrides,
  } as WorkflowDefinition;
}

describe('validateBundledWorkflowAliases', () => {
  test('returns null for a workflow with tier keyword model', () => {
    const wf = makeWorkflow({ model: 'large' });
    expect(validateBundledWorkflowAliases(wf, 'archon-test.yaml')).toBeNull();
  });

  test('returns null for a workflow with literal model string', () => {
    const wf = makeWorkflow({ model: 'claude-opus' });
    expect(validateBundledWorkflowAliases(wf, 'archon-test.yaml')).toBeNull();
  });

  test('returns null for a workflow with no model field', () => {
    const wf = makeWorkflow({});
    expect(validateBundledWorkflowAliases(wf, 'archon-test.yaml')).toBeNull();
  });

  test('rejects workflow-level @custom alias on model', () => {
    const wf = makeWorkflow({ model: '@cheap' });
    const err = validateBundledWorkflowAliases(wf, 'archon-test.yaml');
    expect(err).not.toBeNull();
    expect(err?.error).toMatch(/@alias/);
    expect(err?.error).toMatch(/@cheap/);
    expect(err?.errorType).toBe('validation_error');
  });

  test('rejects node-level @custom alias on model', () => {
    const wf = makeWorkflow({
      nodes: [{ id: 'n1', prompt: 'hi', model: '@deep' }],
    });
    const err = validateBundledWorkflowAliases(wf, 'archon-test.yaml');
    expect(err).not.toBeNull();
    expect(err?.error).toMatch(/n1/);
    expect(err?.error).toMatch(/@deep/);
  });

  test('reports both workflow-level and node-level violations', () => {
    const wf = makeWorkflow({
      model: '@wf-alias',
      nodes: [{ id: 'n1', prompt: 'hi', model: '@node-alias' }],
    });
    const err = validateBundledWorkflowAliases(wf, 'archon-test.yaml');
    expect(err).not.toBeNull();
    expect(err?.error).toMatch(/@wf-alias/);
    expect(err?.error).toMatch(/@node-alias/);
  });

  test('allows mix of tier keywords and literals across nodes', () => {
    const wf = makeWorkflow({
      model: 'medium',
      nodes: [
        { id: 'n1', prompt: 'hi', model: 'small' },
        { id: 'n2', prompt: 'hi', model: 'claude-opus' },
        { id: 'n3', prompt: 'hi' },
      ],
    });
    expect(validateBundledWorkflowAliases(wf, 'archon-test.yaml')).toBeNull();
  });
});
