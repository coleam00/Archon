import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { fromWorkflowDefinition, type BuilderNode } from '@archon/workflow-studio-core';
import type { DagNode } from '@/lib/api';
import type { DagNodeState } from '@/lib/types';
import { WorkflowDagViewer } from './WorkflowDagViewer';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

// A fixture covering all seven variants. Used to build both the DagNode wire shape
// (consumed by the topology layer) and BuilderNodes (consumed by the variant Renderers).
const FIXTURE_RAW = {
  name: 'variant-matrix',
  description: '',
  nodes: [
    { id: 'c', command: 'classify' },
    { id: 'p', prompt: 'do', depends_on: ['c'] },
    { id: 'b', bash: 'echo hi', depends_on: ['p'] },
    { id: 's', script: 'export {}', runtime: 'bun', depends_on: ['b'] },
    { id: 'l', loop: { prompt: 'iterate', until: 'STOP', max_iterations: 3 }, depends_on: ['s'] },
    { id: 'a', approval: { message: 'gate' }, depends_on: ['l'] },
    { id: 'x', cancel: 'abort', depends_on: ['a'] },
  ],
};

function buildFixture(): { dagNodes: DagNode[]; builderNodes: BuilderNode[] } {
  const { nodes } = fromWorkflowDefinition(FIXTURE_RAW);
  return {
    dagNodes: FIXTURE_RAW.nodes as unknown as DagNode[],
    builderNodes: nodes,
  };
}

describe('WorkflowDagViewer', () => {
  it('renders one adapted node per variant in the fixture', () => {
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={false}
      />
    );
    const wrappers = screen.getAllByTestId('adapted-execution-node');
    expect(wrappers).toHaveLength(7);
    const adapters = screen.getAllByTestId('execution-node-adapter');
    const variants = adapters.map(el => el.getAttribute('data-variant')).sort();
    expect(variants).toEqual(['approval', 'bash', 'cancel', 'command', 'loop', 'prompt', 'script']);
  });

  it('propagates liveStatus through to each adapter', () => {
    const { dagNodes, builderNodes } = buildFixture();
    const liveStatus: DagNodeState[] = [
      { nodeId: 'c', name: 'c', status: 'completed' },
      { nodeId: 'p', name: 'p', status: 'running' },
      { nodeId: 'b', name: 'b', status: 'failed' },
    ];
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={liveStatus}
        isRunning={true}
      />
    );
    const adapters = screen.getAllByTestId('execution-node-adapter');
    const byVariant = new Map(adapters.map(el => [el.getAttribute('data-variant'), el]));
    expect(byVariant.get('command')?.getAttribute('data-status')).toBe('completed');
    expect(byVariant.get('prompt')?.getAttribute('data-status')).toBe('running');
    expect(byVariant.get('bash')?.getAttribute('data-status')).toBe('failed');
  });

  it('shows the approval gate ONLY on the paused approval node', () => {
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={false}
        runStatus="paused"
        approval={{ nodeId: 'a', message: 'go?' }}
      />
    );
    expect(screen.getAllByTestId('approval-approve-button')).toHaveLength(1);
    expect(screen.getAllByTestId('approval-reject-button')).toHaveLength(1);
  });

  it('hides approval gate when runStatus is not paused', () => {
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={true}
        runStatus="running"
        approval={{ nodeId: 'a', message: 'go?' }}
      />
    );
    expect(screen.queryByTestId('approval-approve-button')).toBeNull();
  });

  it('forwards Approve click to onApprove', () => {
    const calls: { comment: string | undefined }[] = [];
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={false}
        runStatus="paused"
        approval={{ nodeId: 'a', message: 'go?' }}
        onApprove={(comment): void => {
          calls.push({ comment });
        }}
      />
    );
    fireEvent.click(screen.getByTestId('approval-approve-button'));
    fireEvent.click(screen.getByTestId('approval-popover-submit'));
    expect(calls).toEqual([{ comment: undefined }]);
  });

  it('forwards Reject click to onReject with reason', () => {
    const calls: string[] = [];
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={false}
        runStatus="paused"
        approval={{ nodeId: 'a', message: 'go?' }}
        onReject={(reason): void => {
          calls.push(reason);
        }}
      />
    );
    fireEvent.click(screen.getByTestId('approval-reject-button'));
    fireEvent.change(screen.getByTestId('approval-popover-textarea'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByTestId('approval-popover-submit'));
    expect(calls).toEqual(['nope']);
  });

  it('disables the Approve button while isApproving is true', () => {
    const { dagNodes, builderNodes } = buildFixture();
    render(
      <WorkflowDagViewer
        dagNodes={dagNodes}
        builderNodes={builderNodes}
        liveStatus={[]}
        isRunning={false}
        runStatus="paused"
        approval={{ nodeId: 'a', message: 'go?' }}
        isApproving={true}
      />
    );
    const approve = screen.getByTestId<HTMLButtonElement>('approval-approve-button');
    expect(approve.disabled).toBe(true);
  });
});
