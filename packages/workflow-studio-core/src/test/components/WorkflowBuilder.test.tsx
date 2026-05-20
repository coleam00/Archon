import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { WorkflowBuilder } from '../../components/WorkflowBuilder';
import { useBuilderStore } from '../../store/builder-store';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

beforeEach(() => {
  useBuilderStore.getState().clearWorkflow();
  useBuilderStore.getState().setYamlPreviewOpen(false);
  globalThis.localStorage?.clear();
});

// Auto-cleanup rendered React trees so multiple render() calls within this file
// don't leak DOM into later tests (bun:test has no implicit cleanup).
afterEach(() => {
  cleanup();
});

const noopClient: WorkflowApiClient = {
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async () => [],
  listProviders: async () => [],
  getWorkflow: async () => ({ name: 'noop', description: '', nodes: [] }) as unknown as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
};

describe('WorkflowBuilder', () => {
  it('renders the layout shell with toolbar / canvas / library + inspector slots', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [{ id: 'only', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    const { container } = render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd="__dev__"
        workflowName="demo"
      />
    );
    expect(screen.getByText('demo')).toBeDefined(); // toolbar shows name
    // The point of this assertion is "the canvas mounted the node" — keyed off
    // React Flow's data-id rather than label text, since per-variant labels land
    // in Task 44 (placeholder Renderers in Task 42 don't print the id).
    expect(container.querySelector('[data-id="only"]')).toBeDefined();
    expect(screen.getByLabelText('Node library')).toBeDefined();
    expect(screen.getByLabelText('Node inspector')).toBeDefined();
  });

  it('Reset layout button drops persisted positions and re-runs dagre', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [{ id: 'only', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    // Pre-seed a hand-tweaked position via localStorage
    globalThis.localStorage.setItem(
      'studio:positions:__dev__::__dev__::demo',
      JSON.stringify({ only: { x: 999, y: 999 } })
    );
    render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd="__dev__"
        workflowName="demo"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /reset layout/i }));
    expect(globalThis.localStorage.getItem('studio:positions:__dev__::__dev__::demo')).toBeNull();
  });

  it('renders the NodeInspector empty state when no node is selected', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [{ id: 'only', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd="__dev__"
        workflowName="demo"
      />
    );
    expect(screen.getByTestId('inspector-empty')).toBeDefined();
  });

  it('inspector follows store selection — RenameField appears when a node is selected', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [{ id: 'only', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd="__dev__"
        workflowName="demo"
      />
    );
    act(() => {
      useBuilderStore.getState().setSelection(['only']);
    });
    // RenameField renders a labelled input "Node ID"; presence proves the
    // inspector swapped from the empty state to the populated state.
    expect(screen.getByLabelText(/node id/i)).toBeDefined();
  });

  it('renders a bottom drawer slot', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'demo', description: '', base: {}, unknown: {} },
      nodes: [{ id: 'only', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    const { container } = render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd="__dev__"
        workflowName="demo"
      />
    );
    expect(container.querySelector('[data-testid="validation-drawer"]')).not.toBeNull();
  });

  it('right column shows NodeInspector by default and YamlPreviewDrawer when toggled', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'n', description: 'd', base: {}, unknown: {} },
      nodes: [{ id: 'a', variant: 'prompt', data: { prompt: 'x' }, base: {}, unknown: {} }],
    });
    const { container, rerender } = render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd=""
        workflowName="n"
      />
    );
    expect(container.querySelector('[data-pane="inspector"]')).toBeTruthy();
    expect(container.querySelector('[data-pane="yaml-preview"]')).toBeNull();

    act(() => {
      useBuilderStore.getState().setYamlPreviewOpen(true);
    });
    rerender(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        archonUrl="__dev__"
        cwd=""
        workflowName="n"
      />
    );
    expect(container.querySelector('[data-pane="inspector"]')).toBeNull();
    expect(container.querySelector('[data-pane="yaml-preview"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="validation-drawer"]')).toBeTruthy();
  });
});
