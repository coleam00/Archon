import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { CancelRenderer } from '../../../nodes/cancel/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { CancelNodeData } from '../../../nodes/cancel/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'c',
  type: 'cancel',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<CancelNodeData>>): BuilderNode<CancelNodeData> => ({
  id: 'c',
  variant: 'cancel',
  data: { cancel: '' },
  base: {},
  unknown: {},
  ...over,
});

describe('CancelRenderer', () => {
  it('renders node id as label and `cancel` badge', () => {
    render(
      <ReactFlowProvider>
        <CancelRenderer
          {...(baseProps as any)}
          data={{ storeId: 'abort', node: mkNode({ id: 'abort' }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('abort')).toBeDefined();
    expect(screen.getByText('cancel')).toBeDefined();
  });
});
