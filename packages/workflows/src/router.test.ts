import { describe, it, expect } from 'bun:test';
import { parseWorkflowInvocation, findWorkflow, resolveWorkflowName } from './router';
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

  describe('parseWorkflowInvocation', () => {
    it('should detect /invoke-workflow pattern at start', () => {
      const response = `/invoke-workflow feature-development
The user wants to add a new authentication system.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('feature-development');
      expect(result.remainingMessage).toContain('authentication system');
    });

    it('should return null workflow when no /invoke-workflow pattern', () => {
      const response = `I can help you with that. Let me explain how to add authentication.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe(response);
    });

    it('should return null workflow with error when workflow name not found', () => {
      const response = `/invoke-workflow non-existent-workflow
Some intent here.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe(response);
      expect(result.error).toContain('non-existent-workflow');
      expect(result.error).toContain('Available');
    });

    it('should extract remainingMessage from text after /invoke-workflow', () => {
      const response = `/invoke-workflow fix-bug
The user wants to fix issue X.
They mentioned it should work with Y.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.remainingMessage).toContain('fix issue X');
      expect(result.remainingMessage).toContain('work with Y');
    });

    it('should handle /invoke-workflow with extra whitespace', () => {
      const response = `/invoke-workflow   fix-bug
Intent text here.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
    });

    it('should handle /invoke-workflow with no text after', () => {
      const response = `/invoke-workflow add-feature`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('add-feature');
      expect(result.remainingMessage).toBe('');
    });

    it('should be case-insensitive for command pattern', () => {
      const response = `/INVOKE-WORKFLOW fix-bug
Some text`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
    });

    it('should match /invoke-workflow at start of any line (multiline mode)', () => {
      // AI models sometimes add analysis before the command, so we use multiline mode
      // to match /invoke-workflow at the start of any line, not just the start of the message
      const response = `Some text before
/invoke-workflow fix-bug
Some text after`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.remainingMessage).toBe('Some text after');
    });

    it('should handle workflow name with hyphens', () => {
      const response = `/invoke-workflow feature-development
Intent here`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('feature-development');
    });

    it('should handle empty response', () => {
      const result = parseWorkflowInvocation('', testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe('');
    });

    it('should handle response with only whitespace', () => {
      const result = parseWorkflowInvocation('   \n\t  \n   ', testWorkflows);

      expect(result.workflowName).toBeNull();
    });

    it('should handle /invoke-workflow: without name', () => {
      const response = `/invoke-workflow
No name provided`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      // Pattern requires a name after the command
      expect(result.workflowName).toBeNull();
    });

    it('should preserve full intent text including code blocks', () => {
      const response = `/invoke-workflow fix-bug
User wants to fix this code:
\`\`\`javascript
function broken() {
  return null;
}
\`\`\``;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.remainingMessage).toContain('```javascript');
      expect(result.remainingMessage).toContain('function broken()');
    });
  });

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

  describe('error information', () => {
    it('should return error message for unknown workflow', () => {
      const response = '/invoke-workflow non-existent';
      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.error).toContain('non-existent');
      expect(result.error).toContain('Available');
      expect(result.error).toContain('fix-bug');
    });

    it('should match workflow names case-insensitively', () => {
      const response = '/invoke-workflow Fix-Bug';
      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.error).toBeUndefined();
    });

    it('should not have error when no /invoke-workflow pattern found', () => {
      const response = 'Just a normal message';
      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it('should prefer exact match over case-insensitive match', () => {
      const response = '/invoke-workflow fix-bug';
      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.error).toBeUndefined();
    });

    it('should include all available workflow names in error', () => {
      const response = '/invoke-workflow unknown';
      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.error).toContain('fix-bug');
      expect(result.error).toContain('add-feature');
      expect(result.error).toContain('feature-development');
    });
  });
});
