import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ApprovalRenderer } from '../../../nodes/approval/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { ApprovalNodeData } from '../../../nodes/approval/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'a',
  type: 'approval',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<ApprovalNodeData>>): BuilderNode<ApprovalNodeData> => ({
  id: 'a',
  variant: 'approval',
  data: {
    approval: { message: 'Approve?' } as ApprovalNodeData['approval'],
  },
  base: {},
  unknown: {},
  ...over,
});

describe('ApprovalRenderer', () => {
  it('renders node id as the label', () => {
    render(
      <ReactFlowProvider>
        <ApprovalRenderer
          {...(baseProps as any)}
          data={{ storeId: 'gate', node: mkNode({ id: 'gate' }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('gate')).toBeDefined();
  });

  it('always renders the `approval` badge', () => {
    render(
      <ReactFlowProvider>
        <ApprovalRenderer {...(baseProps as any)} data={{ storeId: 'a', node: mkNode({}) }} />
      </ReactFlowProvider>
    );
    expect(screen.getByText('approval')).toBeDefined();
  });

  it('renders the message truncated to 32 chars as secondary', () => {
    const long = 'm'.repeat(60);
    render(
      <ReactFlowProvider>
        <ApprovalRenderer
          {...(baseProps as any)}
          data={{
            storeId: 'a',
            node: mkNode({
              data: { approval: { message: long } as ApprovalNodeData['approval'] },
            }),
          }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('m'.repeat(32))).toBeDefined();
  });
});
