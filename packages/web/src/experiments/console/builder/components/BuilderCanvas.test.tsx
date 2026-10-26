import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactFlowProps } from '@xyflow/react';
import type { BuilderFlowEdge, BuilderFlowNode } from '../flow/types';

let onNodesChange: ReactFlowProps<BuilderFlowNode, BuilderFlowEdge>['onNodesChange'];

const xyflow = await import('@xyflow/react');

mock.module('@xyflow/react', () => ({
  ...xyflow,
  ReactFlow: (props: ReactFlowProps<BuilderFlowNode, BuilderFlowEdge>) => {
    onNodesChange = props.onNodesChange;
    return null;
  },
}));

const { BuilderCanvas } = await import('./BuilderCanvas');

test('persists the snapped position on the final drop', () => {
  const nodes: BuilderFlowNode[] = ['moving', 'stationary'].map(id => ({
    id,
    position: id === 'moving' ? { x: 0, y: 300 } : { x: 100, y: 0 },
    measured: { width: 100, height: 50 },
    data: {
      label: id,
      node: { id, variant: 'bash', base: {}, data: { bash: 'echo hi' } },
    },
  }));
  const onMoveNodes = mock();
  const noop = (): void => {};
  renderToStaticMarkup(
    <BuilderCanvas
      nodes={nodes}
      edges={[]}
      onMoveNodes={onMoveNodes}
      onSelectDelta={noop}
      onConnect={noop}
      onAddNode={noop}
      onInit={noop}
      onSetSelection={noop}
      onCopy={noop}
      onCut={noop}
      onPaste={noop}
      onDuplicate={noop}
      onDelete={noop}
      onSelectAll={noop}
      onAutoArrange={noop}
      onFitView={noop}
      hasClipboard={false}
      selectedNodeCount={0}
      selectedEdgeCount={0}
    />
  );
  if (onNodesChange === undefined) throw new Error('ReactFlow did not receive onNodesChange');
  onNodesChange([
    { type: 'position', id: 'moving', position: { x: 104, y: 300 }, dragging: false },
  ]);
  expect(onMoveNodes).toHaveBeenCalledTimes(1);
  expect(onMoveNodes).toHaveBeenCalledWith([{ id: 'moving', position: { x: 100, y: 300 } }]);
});
