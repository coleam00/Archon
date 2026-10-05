import { describe, expect, test } from 'bun:test';
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BuilderNode } from '../types';
import { Inspector } from './Inspector';
import { WhenBuilder } from './WhenBuilder';

const opaqueNode: BuilderNode = {
  id: 'selected',
  variant: 'opaque',
  base: {
    depends_on: ['upstream'],
    when: "$upstream.output == 'ready'",
    trigger_rule: 'all_done',
    output_type: 'report',
  },
  data: { kind: 'workflow', fields: { workflow: 'child' } },
};

const editableNode: BuilderNode = {
  id: 'selected',
  variant: 'prompt',
  base: opaqueNode.base,
  data: { prompt: 'Review' },
};

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
  test('opaque nodes hide unsupported controls and retain graph fields', () => {
    const html = renderInspector(opaqueNode);
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

  test('editable nodes retain trigger rule and output type controls', () => {
    const html = renderInspector(editableNode);
    expect(html).toContain('Trigger rule');
    expect(html).toContain('value="all_done" selected');
    expect(html).toContain('Output type');
    expect(html).toContain('value="report"');
  });

  test('editing an opaque condition emits the changed base and preserves opaque data', () => {
    const patches: BuilderNode[] = [];
    let conditionInput: ConditionInputProps | undefined;
    function Probe(): ReactElement {
      const tree = Inspector({
        node: opaqueNode,
        selectionCount: 1,
        otherIds: ['upstream'],
        onPatch: node => patches.push(node),
        onRename: () => undefined,
      });
      if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error('Missing inspector');
      const condition = Children.toArray(tree.props.children).find(
        child => isValidElement(child) && child.type === WhenBuilder
      );
      if (!isValidElement<ComponentProps<typeof WhenBuilder>>(condition)) {
        throw new Error('Missing condition editor');
      }
      const editor = WhenBuilder(condition.props);
      if (!isValidElement<{ children: ReactNode }>(editor)) throw new Error('Missing editor');
      const input = Children.toArray(editor.props.children).find(
        child => isValidElement(child) && child.type === 'input'
      );
      if (!isValidElement<ConditionInputProps>(input)) throw new Error('Missing condition input');
      conditionInput = input.props;
      return tree;
    }
    renderToStaticMarkup(<Probe />);
    if (!conditionInput) throw new Error('Condition input was not rendered');
    const when = "$upstream.output == 'done'";
    conditionInput.onChange({ target: { value: when } });
    expect(patches).toEqual([{ ...opaqueNode, base: { ...opaqueNode.base, when } }]);
    expect(opaqueNode.base.when).toBe("$upstream.output == 'ready'");
  });
});

interface ConditionInputProps {
  onChange: (event: { target: { value: string } }) => void;
}
