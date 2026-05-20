import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { CommandRenderer } from '../../../nodes/command/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { CommandNodeData } from '../../../nodes/command/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'x',
  type: 'command',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<CommandNodeData>>): BuilderNode<CommandNodeData> => ({
  id: 'x',
  variant: 'command',
  data: { command: '' },
  base: {},
  unknown: {},
  ...over,
});

describe('CommandRenderer', () => {
  it('uses data.command as label when set', () => {
    render(
      <ReactFlowProvider>
        <CommandRenderer
          {...(baseProps as any)}
          data={{ storeId: 'x', node: mkNode({ data: { command: 'classify' } }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('classify')).toBeDefined();
  });

  it('falls back to node id when data.command is empty', () => {
    render(
      <ReactFlowProvider>
        <CommandRenderer
          {...(baseProps as any)}
          data={{ storeId: 'classify', node: mkNode({ id: 'classify', data: { command: '' } }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('classify')).toBeDefined();
  });
});
