import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { WaitFields } from './WaitFields';
import type { WaitNodeData } from '../../types';

function fieldChange(node: ReactNode, label: string): ((value: string) => void) | undefined {
  let change: ((value: string) => void) | undefined;
  Children.forEach(node, child => {
    if (
      !isValidElement<{ label?: string; children?: ReactNode; onChange?: (v: string) => void }>(
        child
      )
    )
      return;
    if (child.props.label === label) change = child.props.onChange;
    else change ??= fieldChange(child.props.children, label);
  });
  return change;
}

test('editing an attention question keeps its form and options', () => {
  const data: WaitNodeData = {
    attention: 'Which base?',
    form: 'select',
    options: [{ id: 'use-main' }, { id: 'use-dev' }],
  };
  let next: WaitNodeData | undefined;
  const change = fieldChange(
    WaitFields({
      data,
      onChange: value => {
        next = value;
      },
    }),
    'Question'
  );
  change?.('Which base now?');
  expect(next).toEqual({ ...data, attention: 'Which base now?' });
});
