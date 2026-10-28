// @archon-test-isolated
import { describe, it, expect } from 'bun:test';
import { findWorkflow, resolveWorkflowName } from './router';
import type { WorkflowDefinition } from './schemas';

describe('Workflow Router', () => {
  // Sample workflows for testing
  const testWorkflows: WorkflowDefinition[] = [
    {
      name: 'fix-bug',
      description: 'Fix a bug in the codebase',
      nodes: [
        { id: 'analyze', kind: 'agent', source: { kind: 'command', name: 'analyze' } },
        {
          id: 'fix',
          kind: 'agent',
          source: { kind: 'command', name: 'fix' },
          depends_on: ['analyze'],
        },
      ],
    },
    {
      name: 'add-feature',
      description: 'Add a new feature',
      nodes: [
        { id: 'plan', kind: 'agent', source: { kind: 'command', name: 'plan' } },
        {
          id: 'implement',
          kind: 'agent',
          source: { kind: 'command', name: 'implement' },
          depends_on: ['plan'],
        },
      ],
    },
    {
      name: 'feature-development',
      description: 'Full feature development workflow',
      nodes: [
        { id: 'plan', kind: 'agent', source: { kind: 'command', name: 'plan' } },
        {
          id: 'implement',
          kind: 'agent',
          source: { kind: 'command', name: 'implement' },
          depends_on: ['plan'],
        },
        {
          id: 'create-pr',
          kind: 'agent',
          source: { kind: 'command', name: 'create-pr' },
          depends_on: ['implement'],
        },
      ],
    },
  ];

  describe('findWorkflow', () => {
    it('should return workflow by name', () => {
      const workflow = findWorkflow('fix-bug', testWorkflows);

      expect(workflow).toBeDefined();
      expect(workflow?.name).toBe('fix-bug');
      expect(workflow?.description).toBe('Fix a bug in the codebase');
    });

    it('should return undefined for non-existent workflow', () => {
      const workflow = findWorkflow('does-not-exist', testWorkflows);

      expect(workflow).toBeUndefined();
    });

    it('should return undefined when workflows array is empty', () => {
      const workflow = findWorkflow('fix-bug', []);

      expect(workflow).toBeUndefined();
    });

    it('should be case-sensitive for workflow names', () => {
      const workflow = findWorkflow('Fix-Bug', testWorkflows);

      // Workflow names are case-sensitive
      expect(workflow).toBeUndefined();
    });
  });

  describe('resolveWorkflowName', () => {
    it('should return exact match', () => {
      const result = resolveWorkflowName('fix-bug', testWorkflows);
      expect(result?.name).toBe('fix-bug');
    });

    it('should return case-insensitive match', () => {
      const result = resolveWorkflowName('Fix-Bug', testWorkflows);
      expect(result?.name).toBe('fix-bug');
    });

    it('should return suffix match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'acme-assist', description: 'General assistant', nodes: [] },
      ];
      const result = resolveWorkflowName('assist', workflows);
      expect(result?.name).toBe('acme-assist');
    });

    it('should return substring match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'acme-smart-pr-review', description: 'Smart PR review', nodes: [] },
      ];
      const result = resolveWorkflowName('smart', workflows);
      expect(result?.name).toBe('acme-smart-pr-review');
    });

    it('should return undefined for no match', () => {
      const result = resolveWorkflowName('nonexistent', testWorkflows);
      expect(result).toBeUndefined();
    });

    it('should throw on ambiguous suffix match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'archon-review', description: 'Review', nodes: [] },
        { name: 'custom-review', description: 'Custom review', nodes: [] },
      ];
      expect(() => resolveWorkflowName('review', workflows)).toThrow('Ambiguous workflow');
    });

    it('should throw on ambiguous substring match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'alpha-one', description: 'One', nodes: [] },
        { name: 'alpha-two', description: 'Two', nodes: [] },
      ];
      // "alpha" is a substring of both but not a suffix of either (no "-alpha" ending)
      expect(() => resolveWorkflowName('alpha', workflows)).toThrow('Ambiguous workflow');
    });

    it('should prefer exact match over suffix match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'assist', description: 'Short name', nodes: [] },
        { name: 'acme-assist', description: 'Long name', nodes: [] },
      ];
      const result = resolveWorkflowName('assist', workflows);
      expect(result?.name).toBe('assist');
    });

    it('should prefer suffix match over substring match', () => {
      const workflows: WorkflowDefinition[] = [
        { name: 'acme-assist', description: 'Suffix match', nodes: [] },
        { name: 'assist-helper', description: 'Substring match', nodes: [] },
      ];
      const result = resolveWorkflowName('assist', workflows);
      // "assist" is a suffix of "acme-assist" (ends with -assist)
      // and a substring of both, but suffix tier wins
      expect(result?.name).toBe('acme-assist');
    });
  });
});
