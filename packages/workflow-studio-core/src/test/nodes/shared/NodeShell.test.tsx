import { describe, it, expect, beforeAll } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { NodeShell } from '../../../nodes/shared/NodeShell';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

describe('NodeShell', () => {
  it('renders label and applies the variant color stripe', () => {
    const { container } = render(
      <ReactFlowProvider>
        <NodeShell variant="loop" label="iterate" selected={false} />
      </ReactFlowProvider>
    );
    expect(screen.getByText('iterate')).toBeDefined();
    const stripe = container.querySelector('[data-stripe="true"]') as HTMLElement;
    expect(stripe.style.background).toContain('--node-loop');
  });

  it('renders the badge when supplied', () => {
    render(
      <ReactFlowProvider>
        <NodeShell variant="loop" label="iterate" selected={false} badge="cap 5" />
      </ReactFlowProvider>
    );
    expect(screen.getByText('cap 5')).toBeDefined();
  });

  it('renders secondary text when supplied', () => {
    render(
      <ReactFlowProvider>
        <NodeShell variant="bash" label="run" selected={false} secondary="echo hi" />
      </ReactFlowProvider>
    );
    expect(screen.getByText('echo hi')).toBeDefined();
  });

  it('reflects the selected prop on data-attribute', () => {
    const { container } = render(
      <ReactFlowProvider>
        <NodeShell variant="command" label="x" selected={true} />
      </ReactFlowProvider>
    );
    expect(container.querySelector('[data-selected="true"]')).toBeTruthy();
  });
});
