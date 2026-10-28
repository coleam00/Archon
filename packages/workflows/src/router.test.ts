// @archon-test-isolated
import { describe, it, expect } from 'bun:test';
import { findWorkflow, resolveWorkflowName, suggestWorkflowNames } from './router';
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
    const workflows = [{ name: 'archon-review' }, { name: 'acme/review:run' }];

    it('returns only an exact name, including qualified installed names', () => {
      for (const workflow of workflows) {
        expect(resolveWorkflowName(workflow.name, workflows)).toBe(workflow);
      }
    });

    it.each(['review', 'archon', 'ARCHON-REVIEW', 'acme/REVIEW:run', 'review:run', 'missing'])(
      'does not resolve the non-exact name %s',
      name => {
        expect(resolveWorkflowName(name, workflows)).toBeUndefined();
      }
    );

    it('keeps exact selection and misses stable when containing names are added', () => {
      const expanded = [...workflows, { name: 'custom-review' }, { name: 'archon-review-more' }];
      expect(resolveWorkflowName('archon-review', expanded)).toBe(workflows[0]);
      expect(resolveWorkflowName('review', expanded)).toBeUndefined();
      expect(resolveWorkflowName('review', [])).toBeUndefined();
    });
  });
});

describe('workflow name suggestions', () => {
  it('ranks contained names, case variants and typos without resolving them', () => {
    const workflows = [
      { name: 'unrelated' },
      { name: 'archon-review' },
      { name: 'custom-review' },
      { name: 'plan' },
    ];
    expect(suggestWorkflowNames('review', workflows).slice(0, 2)).toEqual([
      'archon-review',
      'custom-review',
    ]);
    expect(suggestWorkflowNames('ARCHON-REVIEW', workflows)[0]).toBe('archon-review');
    expect(suggestWorkflowNames('archon-reveiw', workflows)[0]).toBe('archon-review');
    expect(suggestWorkflowNames('review', [])).toEqual([]);
  });
});
