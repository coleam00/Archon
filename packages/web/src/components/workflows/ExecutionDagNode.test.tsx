import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';

import { executionDagNode, formatRuntimeMetadata } from './ExecutionDagNode';

function renderExecutionNode(data: React.ComponentProps<typeof executionDagNode>['data']): string {
  const props = {
    id: 'node-1',
    type: 'executionNode',
    data,
    draggable: false,
    selectable: true,
    deletable: false,
    selected: false,
    dragging: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } satisfies React.ComponentProps<typeof executionDagNode>;

  return renderToStaticMarkup(
    React.createElement(ReactFlowProvider, null, React.createElement(executionDagNode, props))
  );
}

describe('formatRuntimeMetadata', () => {
  test('formats provider, model, and reasoning effort', () => {
    expect(
      formatRuntimeMetadata({
        provider: 'claude',
        model: 'sonnet',
        modelReasoningEffort: 'xhigh',
      })
    ).toBe('claude - sonnet - xhigh');
  });

  test('omits metadata when provider is absent', () => {
    expect(formatRuntimeMetadata({ model: 'sonnet', modelReasoningEffort: 'xhigh' })).toBeNull();
  });

  test('falls back to thinking metadata when no effort is present', () => {
    expect(
      formatRuntimeMetadata({
        provider: 'claude',
        model: 'sonnet',
        thinking: { type: 'enabled', budgetTokens: 4000 },
      })
    ).toBe('claude - sonnet - enabled 4000');
  });
});

describe('executionDagNode', () => {
  test('renders runtime AI metadata after a node completes', () => {
    const html = renderExecutionNode({
      id: 'create-story',
      label: 'create-story',
      nodeType: 'prompt',
      status: 'completed',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });

    expect(html).toContain('claude - opus - high');
  });
});
