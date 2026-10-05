import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromWorkflowDefinition } from '../model/from-workflow';
import type { BuilderNode, WireDagNode } from '../types';
import { Inspector } from './Inspector';

function importNode(mode: Partial<WireDagNode>): BuilderNode {
  const { workflow } = fromWorkflowDefinition({
    name: 'inspector',
    description: 'Inspector controls',
    nodes: [
      {
        id: 'selected',
        depends_on: ['upstream'],
        when: "$upstream.output == 'ready'",
        trigger_rule: 'all_done',
        output_type: 'report',
        ...mode,
      },
    ],
  });
  const node = workflow.nodes[0];
  if (node === undefined) throw new Error('Inspector fixture did not import a node');
  return node;
}

function renderInspector(node: BuilderNode): string {
  return renderToStaticMarkup(
    <Inspector
      node={node}
      selectionCount={1}
      otherIds={['upstream']}
      onPatch={() => undefined}
      onRename={() => undefined}
    />
  );
}

describe('Inspector', () => {
  const opaqueModes: Partial<WireDagNode>[] = [
    {
      loop_group: {
        max_iterations: 3,
        fresh_context: true,
        until_bash: 'test -f done',
        nodes: [{ id: 'check', bash: 'true' }],
      },
    },
    { workflow: 'child' },
    { include: 'shared' },
  ];

  for (const mode of opaqueModes) {
    const node = importNode(mode);
    test(`${Object.keys(mode)[0]} hides unsupported controls and retains graph fields`, () => {
      expect(node.variant).toBe('opaque');
      const html = renderInspector(node);
      expect(html).not.toContain('Trigger rule');
      expect(html).not.toContain('Output type');
      expect(html).toContain('Read-only');
      expect(html).toContain('Depends on (edit via canvas edges)');
      expect(html).toContain('upstream');
      expect(html).toContain('When (condition)');
      expect(html).toContain('value="$upstream.output == &#x27;ready&#x27;"');
      expect(html).not.toContain('disabled');
      expect(html).not.toContain('readonly');
    });
  }

  test('editable nodes retain trigger rule and output type controls', () => {
    const node = importNode({ prompt: 'Review' });
    expect(node.variant).not.toBe('opaque');
    const html = renderInspector(node);
    expect(html).toContain('Trigger rule');
    expect(html).toContain('value="all_done" selected');
    expect(html).toContain('Output type');
    expect(html).toContain('value="report"');
  });
});
