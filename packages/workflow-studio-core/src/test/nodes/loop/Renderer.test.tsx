import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { LoopRenderer } from '../../../nodes/loop/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { LoopNodeData } from '../../../nodes/loop/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'l',
  type: 'loop',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<LoopNodeData>>): BuilderNode<LoopNodeData> => ({
  id: 'l',
  variant: 'loop',
  data: {
    loop: {
      prompt: '',
      until: 'COMPLETE',
      max_iterations: 10,
      fresh_context: false,
    } as LoopNodeData['loop'],
  },
  base: {},
  unknown: {},
  ...over,
});

describe('LoopRenderer', () => {
  it('renders `cap N` badge when max_iterations is a number', () => {
    render(
      <ReactFlowProvider>
        <LoopRenderer
          {...(baseProps as any)}
          data={{
            storeId: 'l',
            node: mkNode({
              data: {
                loop: {
                  prompt: '',
                  until: 'COMPLETE',
                  max_iterations: 5,
                  fresh_context: false,
                } as LoopNodeData['loop'],
              },
            }),
          }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('cap 5')).toBeDefined();
  });

  it('renders `loop` badge when max_iterations is not a number', () => {
    render(
      <ReactFlowProvider>
        <LoopRenderer
          {...(baseProps as any)}
          data={{
            storeId: 'l',
            node: mkNode({
              data: {
                loop: {
                  prompt: '',
                  until: 'COMPLETE',
                  fresh_context: false,
                } as unknown as LoopNodeData['loop'],
              },
            }),
          }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('loop')).toBeDefined();
  });

  it('renders `interactive` secondary when loop.interactive is truthy', () => {
    render(
      <ReactFlowProvider>
        <LoopRenderer
          {...(baseProps as any)}
          data={{
            storeId: 'l',
            node: mkNode({
              data: {
                loop: {
                  prompt: '',
                  until: 'COMPLETE',
                  max_iterations: 3,
                  fresh_context: false,
                  interactive: true,
                  gate_message: 'continue?',
                } as LoopNodeData['loop'],
              },
            }),
          }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('interactive')).toBeDefined();
  });
});
