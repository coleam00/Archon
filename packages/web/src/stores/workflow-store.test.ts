import { describe, test, expect, beforeEach } from 'bun:test';
import { useWorkflowStore, selectActiveWorkflow, cleanupWorkflowStore } from './workflow-store';
import type {
  WorkflowStatusEvent,
  WorkflowArtifactEvent,
  DagNodeEvent,
  LoopIterationEvent,
  WorkflowState,
} from '@/lib/types';

beforeEach(() => {
  cleanupWorkflowStore();
});

function statusEvent(
  overrides: Partial<WorkflowStatusEvent> & { runId: string }
): WorkflowStatusEvent {
  return {
    type: 'workflow_status',
    workflowName: 'test',
    status: 'running',
    timestamp: 1000,
    ...overrides,
  };
}

function dagNodeEvent(
  overrides: Partial<DagNodeEvent> & { runId: string; nodeId: string }
): DagNodeEvent {
  return {
    type: 'dag_node',
    name: 'Node',
    status: 'running',
    timestamp: 1000,
    ...overrides,
  };
}

function artifactEvent(
  overrides: Partial<WorkflowArtifactEvent> & { runId: string }
): WorkflowArtifactEvent {
  return {
    type: 'workflow_artifact',
    artifactType: 'commit',
    label: 'test artifact',
    timestamp: 1000,
    ...overrides,
  };
}

describe('handleWorkflowStatus', () => {
  test('creates new entry when runId not in Map', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-1', workflowName: 'test-wf' }));
    const wf = useWorkflowStore.getState().workflows.get('run-1');
    expect(wf).toBeDefined();
    expect(wf!.status).toBe('running');
    expect(wf!.workflowName).toBe('test-wf');
    expect(wf!.dagNodes).toEqual([]);
    expect(wf!.artifacts).toEqual([]);
  });

  test('updates existing entry status', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-2' }));
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-2', status: 'completed', timestamp: 2000 }));
    const wf = useWorkflowStore.getState().workflows.get('run-2');
    expect(wf!.status).toBe('completed');
  });

  test('sets completedAt for terminal statuses on new entry', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(
        statusEvent({ runId: 'run-3', status: 'failed', timestamp: 5000, error: 'something broke' })
      );
    const wf = useWorkflowStore.getState().workflows.get('run-3');
    expect(wf!.completedAt).toBe(5000);
    expect(wf!.error).toBe('something broke');
  });

  test('creates new Map reference on mutation', () => {
    const before = useWorkflowStore.getState().workflows;
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-ref' }));
    const after = useWorkflowStore.getState().workflows;
    expect(before).not.toBe(after);
  });
});

describe('handleDagNode', () => {
  test('adds node to existing workflow', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-d1', workflowName: 'dag-wf' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-d1', nodeId: 'node-a', name: 'Node A' }));
    const wf = useWorkflowStore.getState().workflows.get('run-d1');
    expect(wf!.dagNodes).toHaveLength(1);
    expect(wf!.dagNodes[0].nodeId).toBe('node-a');
  });

  test('updates existing node by nodeId', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-d2', workflowName: 'dag-wf' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-d2', nodeId: 'node-b', name: 'Node B' }));
    useWorkflowStore.getState().handleDagNode(
      dagNodeEvent({
        runId: 'run-d2',
        nodeId: 'node-b',
        name: 'Node B',
        status: 'completed',
        duration: 1200,
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-d2');
    expect(wf!.dagNodes).toHaveLength(1);
    expect(wf!.dagNodes[0].status).toBe('completed');
  });
});

describe('handleWorkflowArtifact', () => {
  test('appends artifact to existing workflow', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-a1' }));
    useWorkflowStore
      .getState()
      .handleWorkflowArtifact(
        artifactEvent({ runId: 'run-a1', label: 'PR #42', artifactType: 'pr' })
      );
    const wf = useWorkflowStore.getState().workflows.get('run-a1');
    expect(wf!.artifacts).toHaveLength(1);
    expect(wf!.artifacts[0].label).toBe('PR #42');
    expect(wf!.artifacts[0].type).toBe('pr');
  });

  test('accumulates multiple artifacts', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-a2' }));
    useWorkflowStore
      .getState()
      .handleWorkflowArtifact(artifactEvent({ runId: 'run-a2', label: 'First' }));
    useWorkflowStore
      .getState()
      .handleWorkflowArtifact(artifactEvent({ runId: 'run-a2', label: 'Second' }));
    const wf = useWorkflowStore.getState().workflows.get('run-a2');
    expect(wf!.artifacts).toHaveLength(2);
  });

  test('no-ops when runId not found', () => {
    const before = useWorkflowStore.getState().workflows;
    useWorkflowStore.getState().handleWorkflowArtifact(artifactEvent({ runId: 'nonexistent' }));
    const after = useWorkflowStore.getState().workflows;
    expect(before).toBe(after);
  });
});

describe('handleWorkflowStatus — approval field', () => {
  test('stores approval on new paused entry', () => {
    useWorkflowStore.getState().handleWorkflowStatus(
      statusEvent({
        runId: 'run-ap1',
        status: 'paused',
        approval: { nodeId: 'gate', message: 'Please review' },
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-ap1');
    expect(wf!.approval).toEqual({ nodeId: 'gate', message: 'Please review' });
  });

  test('sets approval when existing workflow transitions to paused', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-ap2' }));
    useWorkflowStore.getState().handleWorkflowStatus(
      statusEvent({
        runId: 'run-ap2',
        status: 'paused',
        approval: { nodeId: 'gate', message: 'Please review' },
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-ap2');
    expect(wf!.approval).toEqual({ nodeId: 'gate', message: 'Please review' });
  });

  test('clears approval when workflow transitions out of paused', () => {
    useWorkflowStore.getState().handleWorkflowStatus(
      statusEvent({
        runId: 'run-ap3',
        status: 'paused',
        approval: { nodeId: 'gate', message: 'Please review' },
      })
    );
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-ap3', status: 'running' }));
    const wf = useWorkflowStore.getState().workflows.get('run-ap3');
    expect(wf!.approval).toBeUndefined();
  });
});

describe('handleWorkflowStatus — terminal guard', () => {
  test('does not allow running SSE event to resurrect a completed workflow', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(
        statusEvent({ runId: 'run-tg1', status: 'completed', timestamp: 2000 })
      );
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-tg1', status: 'running', timestamp: 3000 }));
    const wf = useWorkflowStore.getState().workflows.get('run-tg1');
    expect(wf!.status).toBe('completed');
  });

  test('does not set completedAt when status is running on existing entry', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-tg2' }));
    const wf = useWorkflowStore.getState().workflows.get('run-tg2');
    expect(wf!.completedAt).toBeUndefined();
  });
});

describe('hydrateWorkflow', () => {
  const makeWorkflow = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
    runId: 'run-h1',
    workflowName: 'test',
    status: 'running',
    dagNodes: [],
    artifacts: [],

    startedAt: 1000,
    ...overrides,
  });

  test('inserts when not present', () => {
    useWorkflowStore.getState().hydrateWorkflow(makeWorkflow());
    expect(useWorkflowStore.getState().workflows.get('run-h1')).toBeDefined();
  });

  test('does NOT override if existing is non-terminal and incoming is non-terminal', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h2' }));
    useWorkflowStore
      .getState()
      .hydrateWorkflow(makeWorkflow({ runId: 'run-h2', status: 'running', startedAt: 500 }));
    const wf = useWorkflowStore.getState().workflows.get('run-h2');
    expect(wf!.startedAt).toBe(1000);
  });

  test('DOES override stale running with terminal REST data', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h3' }));
    useWorkflowStore
      .getState()
      .hydrateWorkflow(makeWorkflow({ runId: 'run-h3', status: 'completed', completedAt: 2000 }));
    const wf = useWorkflowStore.getState().workflows.get('run-h3');
    expect(wf!.status).toBe('completed');
  });

  test('DOES override stale pending with terminal REST data', () => {
    // Use hydrateWorkflow to insert a pending workflow (SSE never emits 'pending')
    useWorkflowStore
      .getState()
      .hydrateWorkflow(makeWorkflow({ runId: 'run-h4', status: 'pending' }));
    expect(useWorkflowStore.getState().workflows.get('run-h4')!.status).toBe('pending');
    useWorkflowStore
      .getState()
      .hydrateWorkflow(makeWorkflow({ runId: 'run-h4', status: 'completed', completedAt: 2000 }));
    const wf = useWorkflowStore.getState().workflows.get('run-h4');
    expect(wf!.status).toBe('completed');
  });

  test('does NOT override terminal existing with non-terminal incoming', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-h5', status: 'completed', timestamp: 2000 }));
    useWorkflowStore
      .getState()
      .hydrateWorkflow(makeWorkflow({ runId: 'run-h5', status: 'running', startedAt: 500 }));
    const wf = useWorkflowStore.getState().workflows.get('run-h5');
    expect(wf!.status).toBe('completed');
  });
});

describe('selectActiveWorkflow / activeWorkflowId', () => {
  test('returns most recent running workflow', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'old', workflowName: 'wf1', timestamp: 1000 }));
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'new', workflowName: 'wf2', timestamp: 2000 }));
    expect(useWorkflowStore.getState().activeWorkflowId).toBe('new');
    const active = selectActiveWorkflow(useWorkflowStore.getState());
    expect(active!.runId).toBe('new');
  });

  test('returns most recent any if none running', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(
        statusEvent({ runId: 'done-old', status: 'completed', timestamp: 1000 })
      );
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'done-new', status: 'failed', timestamp: 2000 }));
    expect(useWorkflowStore.getState().activeWorkflowId).toBe('done-new');
    const active = selectActiveWorkflow(useWorkflowStore.getState());
    expect(active!.runId).toBe('done-new');
  });

  test('returns null for empty store', () => {
    expect(useWorkflowStore.getState().activeWorkflowId).toBeNull();
    expect(selectActiveWorkflow(useWorkflowStore.getState())).toBeNull();
  });

  test('updates when status transitions to terminal', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'a', timestamp: 1000 }));
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'b', timestamp: 2000 }));
    expect(useWorkflowStore.getState().activeWorkflowId).toBe('b');

    // b completes — a is now the active running workflow
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'b', status: 'completed', timestamp: 3000 }));
    expect(useWorkflowStore.getState().activeWorkflowId).toBe('a');
  });
});

function loopIterationEvent(
  overrides: Partial<LoopIterationEvent> & { runId: string; iteration: number }
): LoopIterationEvent {
  return {
    type: 'workflow_step',
    nodeId: 'loop-node',
    step: overrides.iteration - 1,
    total: 5,
    name: `iteration-${String(overrides.iteration)}`,
    status: 'running',
    timestamp: 1000,
    ...overrides,
  };
}

describe('handleLoopIteration', () => {
  test('no-ops when event has no nodeId (non-DAG loop)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li0' }));
    const before = useWorkflowStore.getState().workflows;
    useWorkflowStore
      .getState()
      .handleLoopIteration(
        loopIterationEvent({ runId: 'run-li0', iteration: 1, nodeId: undefined })
      );
    // Map reference must not change — no mutation
    expect(useWorkflowStore.getState().workflows).toBe(before);
  });

  test('no-ops when nodeId not yet in dagNodes', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li1' }));
    useWorkflowStore
      .getState()
      .handleLoopIteration(
        loopIterationEvent({ runId: 'run-li1', iteration: 1, nodeId: 'ghost-node' })
      );
    // Node was not registered — dagNodes must remain empty
    const wf = useWorkflowStore.getState().workflows.get('run-li1')!;
    expect(wf.dagNodes).toHaveLength(0);
  });

  test('appends first iteration to existing node', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li2' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-li2', nodeId: 'loop-node', name: 'My Loop' }));
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li2',
        nodeId: 'loop-node',
        iteration: 1,
        total: 3,
        status: 'running',
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-li2')!;
    const node = wf.dagNodes.find(n => n.nodeId === 'loop-node')!;
    expect(node.iterations).toHaveLength(1);
    expect(node.iterations![0]).toEqual({ iteration: 1, status: 'running', duration: undefined });
    expect(node.currentIteration).toBe(1);
    expect(node.maxIterations).toBe(3);
  });

  test('updates existing iteration entry (upsert by iteration number)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li3' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-li3', nodeId: 'loop-node', name: 'My Loop' }));
    // First: started
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li3',
        nodeId: 'loop-node',
        iteration: 1,
        status: 'running',
      })
    );
    // Then: completed with duration
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li3',
        nodeId: 'loop-node',
        iteration: 1,
        status: 'completed',
        total: 0,
        duration: 1500,
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-li3')!;
    const node = wf.dagNodes.find(n => n.nodeId === 'loop-node')!;
    expect(node.iterations).toHaveLength(1); // no duplicate
    expect(node.iterations![0].status).toBe('completed');
    expect(node.iterations![0].duration).toBe(1500);
  });

  test('preserves prior maxIterations when total: 0 (completed/failed events)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li4' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-li4', nodeId: 'loop-node', name: 'My Loop' }));
    // started with known total
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li4',
        nodeId: 'loop-node',
        iteration: 1,
        total: 4,
        status: 'running',
      })
    );
    // completed with total: 0 (intentional bridge omission)
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li4',
        nodeId: 'loop-node',
        iteration: 1,
        total: 0,
        status: 'completed',
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-li4')!
      .dagNodes.find(n => n.nodeId === 'loop-node')!;
    expect(node.maxIterations).toBe(4); // preserved, not overwritten to 0
  });

  test('accumulates multiple distinct iterations', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li5' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-li5', nodeId: 'loop-node', name: 'My Loop' }));
    for (let i = 1; i <= 3; i++) {
      useWorkflowStore.getState().handleLoopIteration(
        loopIterationEvent({
          runId: 'run-li5',
          nodeId: 'loop-node',
          iteration: i,
          status: 'completed',
        })
      );
    }
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-li5')!
      .dagNodes.find(n => n.nodeId === 'loop-node')!;
    expect(node.iterations).toHaveLength(3);
    expect(node.currentIteration).toBe(3);
  });

  test('preserves iteration data after node_completed dag event overwrites node', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-li6' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-li6', nodeId: 'loop-node', name: 'My Loop' }));
    useWorkflowStore.getState().handleLoopIteration(
      loopIterationEvent({
        runId: 'run-li6',
        nodeId: 'loop-node',
        iteration: 1,
        total: 2,
        status: 'completed',
      })
    );
    // Simulate the loop node completing — handleDagNode must preserve the iteration data
    useWorkflowStore.getState().handleDagNode(
      dagNodeEvent({
        runId: 'run-li6',
        nodeId: 'loop-node',
        name: 'My Loop',
        status: 'completed',
        duration: 5000,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-li6')!
      .dagNodes.find(n => n.nodeId === 'loop-node')!;
    expect(node.status).toBe('completed');
    expect(node.iterations).toHaveLength(1); // iteration data preserved after node completion
    expect(node.maxIterations).toBe(2);
  });
});
