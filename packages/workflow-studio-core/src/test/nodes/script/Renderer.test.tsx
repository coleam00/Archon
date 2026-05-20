import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ScriptRenderer } from '../../../nodes/script/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { ScriptNodeData } from '../../../nodes/script/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 's',
  type: 'script',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<ScriptNodeData>>): BuilderNode<ScriptNodeData> => ({
  id: 's',
  variant: 'script',
  data: { script: '', runtime: 'bun' },
  base: {},
  unknown: {},
  ...over,
});

describe('ScriptRenderer', () => {
  it('renders node id as the label', () => {
    render(
      <ReactFlowProvider>
        <ScriptRenderer
          {...(baseProps as any)}
          data={{ storeId: 'transform', node: mkNode({ id: 'transform' }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('transform')).toBeDefined();
  });

  it('renders the script body truncated to 24 chars as the badge', () => {
    const long = 'c'.repeat(50);
    render(
      <ReactFlowProvider>
        <ScriptRenderer
          {...(baseProps as any)}
          data={{ storeId: 's', node: mkNode({ data: { script: long, runtime: 'bun' } }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('c'.repeat(24))).toBeDefined();
  });
});
