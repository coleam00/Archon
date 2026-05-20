import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { PromptRenderer } from '../../../nodes/prompt/Renderer';
import type { BuilderNode } from '../../../nodes/shared/types';
import type { PromptNodeData } from '../../../nodes/prompt/data';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'p',
  type: 'prompt',
  selected: false,
  dragging: false,
  isConnectable: true,
  xPos: 0,
  yPos: 0,
  zIndex: 0,
};

const mkNode = (over: Partial<BuilderNode<PromptNodeData>>): BuilderNode<PromptNodeData> => ({
  id: 'p',
  variant: 'prompt',
  data: { prompt: '' },
  base: {},
  unknown: {},
  ...over,
});

describe('PromptRenderer', () => {
  it('renders node id as the label', () => {
    render(
      <ReactFlowProvider>
        <PromptRenderer
          {...(baseProps as any)}
          data={{ storeId: 'summarize', node: mkNode({ id: 'summarize' }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('summarize')).toBeDefined();
  });

  it('renders the prompt body truncated to 32 chars as secondary', () => {
    const long = 'a'.repeat(50);
    render(
      <ReactFlowProvider>
        <PromptRenderer
          {...(baseProps as any)}
          data={{ storeId: 'p', node: mkNode({ data: { prompt: long } }) }}
        />
      </ReactFlowProvider>
    );
    expect(screen.getByText('a'.repeat(32))).toBeDefined();
  });
});
