// @archon-test-isolated
import { describe, it, expect } from 'bun:test';
import { resolveWorkflowName, suggestWorkflowNames } from './router';

describe('Workflow Router', () => {
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
