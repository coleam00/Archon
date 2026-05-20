import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BashRenderer } from '../../../nodes/bash/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { BashNodeData } from '../../../nodes/bash/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'b',
  type: 'bash',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<BashNodeData>>): BuilderNode<BashNodeData> => ({
  id: 'b',
  variant: 'bash',
  data: { bash: '' },
  base: {},
  unknown: {},
  ...over,
});

describe('BashRenderer', () => {
  it('renders node id as the label', () => {
    render(
      <ReactFlowProvider>
        <BashRenderer
          {...(baseProps as any)}
          data={{ storeId: 'lint', node: mkNode({ id: 'lint' }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('lint')).toBeDefined();
  });

  it('renders the bash body truncated to 32 chars as secondary', () => {
    const long = 'b'.repeat(50);
    render(
      <ReactFlowProvider>
        <BashRenderer
          {...(baseProps as any)}
          data={{ storeId: 'b', node: mkNode({ data: { bash: long } }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('b'.repeat(32))).toBeDefined();
  });
});
