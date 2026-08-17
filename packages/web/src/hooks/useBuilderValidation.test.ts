import { describe, test, expect } from 'bun:test';
import type { Edge } from '@xyflow/react';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import { getDebouncedIssues } from './useBuilderValidation';

function node(
  id: string,
  data: { when?: string; promptText?: string; bashScript?: string } = {}
): DagFlowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { id, label: id, nodeType: 'prompt', ...data },
  } as DagFlowNode;
}

function refIssues(nodes: DagFlowNode[], edges: Edge[] = []): string[] {
  return getDebouncedIssues(nodes, edges)
    .filter(issue => issue.message.includes('.output'))
    .map(issue => issue.message);
}

describe('getDebouncedIssues — $nodeId.output references', () => {
  test('flags a dangling HYPHENATED reference', () => {
    // The regression: the old `/\$(\w+)\.output/g` excluded `-`, so this ref —
    // the shape the bundled workflows use — was never checked at all.
    const issues = refIssues([node('use', { promptText: 'read $check-reproduction.output' })]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('$check-reproduction.output');
  });

  test('accepts a hyphenated reference to a node that exists', () => {
    expect(
      refIssues([
        node('check-reproduction', { promptText: 'reproduce it' }),
        node('use', { promptText: 'read $check-reproduction.output' }),
      ])
    ).toEqual([]);
  });

  test('scans when, promptText and bashScript alike', () => {
    const issues = refIssues([
      node('a', { when: "$ghost-when.output == 'x'" }),
      node('b', { promptText: 'read $ghost-prompt.output' }),
      node('c', { bashScript: 'echo $ghost-bash.output' }),
    ]);

    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('$ghost-bash.output');
  });

  test('reports a repeated dangling ref once per body, not once per occurrence', () => {
    expect(
      refIssues([node('use', { promptText: '$ghost.output then $ghost.output again' })])
    ).toHaveLength(1);
  });

  test('ignores a reference whose id starts with a digit', () => {
    expect(refIssues([node('use', { promptText: 'cost is $1.output' })])).toEqual([]);
  });
});
