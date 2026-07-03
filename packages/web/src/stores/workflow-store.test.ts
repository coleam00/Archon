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

  test('stores route decision metadata from node_routed dag events', () => {
    const routeDecision = {
      from: 'review',
      outcome: 'positive',
      to: 'done',
      condition: "$review.output.approved == '<redacted>'",
      condition_result: true,
      negative_count: 0,
      max_iterations: 2,
      attempt: 2,
      execution_seq: 7,
    };

    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-route', workflowName: 'route-wf' }));
    useWorkflowStore.getState().handleDagNode(
      dagNodeEvent({
        runId: 'run-route',
        nodeId: 'review-router',
        name: 'Review Router',
        status: 'completed',
        routeDecision,
      } as Partial<DagNodeEvent> & {
        runId: string;
        nodeId: string;
        routeDecision: typeof routeDecision;
      })
    );

    const node = useWorkflowStore
      .getState()
      .workflows.get('run-route')!
      .dagNodes.find(n => n.nodeId === 'review-router') as
      | ({ routeDecision?: typeof routeDecision } & { status: string })
      | undefined;

    expect(node).toMatchObject({
      status: 'completed',
      routeDecision,
    });
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

  test('settles running DAG nodes when workflow is cancelled', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-tg3' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-tg3', nodeId: 'dev-story', name: 'Dev Story' }));

    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-tg3', status: 'cancelled' }));

    const wf = useWorkflowStore.getState().workflows.get('run-tg3');
    expect(wf!.status).toBe('cancelled');
    expect(wf!.dagNodes).toEqual([
      {
        nodeId: 'dev-story',
        name: 'Dev Story',
        status: 'failed',
        error: 'Cancelled by user',
        duration: undefined,
        reason: undefined,
        routeDecision: undefined,
      },
    ]);
  });

  test('ignores late running DAG node events after terminal status', () => {
    useWorkflowStore
      .getState()
      .handleWorkflowStatus(statusEvent({ runId: 'run-tg4', status: 'cancelled' }));

    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-tg4', nodeId: 'dev-story', name: 'Dev Story' }));

    const wf = useWorkflowStore.getState().workflows.get('run-tg4');
    expect(wf!.status).toBe('cancelled');
    expect(wf!.dagNodes).toEqual([]);
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

// ---------------------------------------------------------------------------
// Phase 3 of #975 — subagent task + hook activity aggregation
// ---------------------------------------------------------------------------

import type { WorkflowTaskActivityEvent, WorkflowHookActivityEvent } from '@/lib/types';

function taskEvent(
  overrides: Partial<WorkflowTaskActivityEvent> & { runId: string; nodeId: string; taskId: string }
): WorkflowTaskActivityEvent {
  return {
    type: 'workflow_task_activity',
    activity: 'started',
    timestamp: 1000,
    ...overrides,
  };
}

function hookEvent(
  overrides: Partial<WorkflowHookActivityEvent> & {
    runId: string;
    nodeId: string;
    hookId: string;
  }
): WorkflowHookActivityEvent {
  return {
    type: 'workflow_hook_activity',
    hookName: 'Bash',
    hookEvent: 'PreToolUse',
    activity: 'started',
    timestamp: 1000,
    ...overrides,
  };
}

describe('handleTaskActivity', () => {
  test('no-ops when node not yet in dagNodes (SSE ordering tolerance)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t1' }));
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t1',
        nodeId: 'absent-node',
        taskId: 't-1',
        description: 'Doing work',
      })
    );
    const wf = useWorkflowStore.getState().workflows.get('run-t1');
    expect(wf).toBeDefined();
    expect(wf!.dagNodes.find(n => n.nodeId === 'absent-node')).toBeUndefined();
  });

  test('adds task row when started arrives after node', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t2' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t2', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t2',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'started',
        description: 'Analyzing the bug',
        taskType: 'general-purpose',
      })
    );

    const node = useWorkflowStore
      .getState()
      .workflows.get('run-t2')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.tasks).toHaveLength(1);
    expect(node.tasks?.[0]).toMatchObject({
      taskId: 't-1',
      activity: 'started',
      description: 'Analyzing the bug',
      taskType: 'general-purpose',
    });
  });

  test('progress updates the existing task row in place (mutates, not appends)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t3' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t3', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t3',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'started',
        description: 'Started',
      })
    );
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t3',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'progress',
        summary: 'Reading stack trace',
        lastToolName: 'Read',
        timestamp: 2000,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-t3')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.tasks).toHaveLength(1);
    expect(node.tasks?.[0]).toMatchObject({
      taskId: 't-1',
      activity: 'progress',
      summary: 'Reading stack trace',
      lastToolName: 'Read',
      updatedAt: 2000,
    });
    // Description seeded by started must survive a progress event that omits it
    expect(node.tasks?.[0].description).toBe('Started');
  });

  test('completed activity transitions the row to completed', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t4' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t4', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore
      .getState()
      .handleTaskActivity(
        taskEvent({ runId: 'run-t4', nodeId: 'plan', taskId: 't-1', activity: 'started' })
      );
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t4',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'completed',
        summary: 'Done',
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-t4')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.tasks?.[0].activity).toBe('completed');
    expect(node.tasks?.[0].summary).toBe('Done');
  });

  test('handles out-of-order notification before started (seeds a row)', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t5' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t5', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t5',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'completed',
        summary: 'Done before started arrived',
        timestamp: 5000,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-t5')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.tasks).toHaveLength(1);
    expect(node.tasks?.[0].activity).toBe('completed');
    // The seeded row must carry the event's metadata (not just taskId/activity).
    expect(node.tasks?.[0].summary).toBe('Done before started arrived');
  });

  test('late started after a seeded terminal event does not regress activity or drop metadata', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t7' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t7', nodeId: 'plan', name: 'Plan' }));
    // completed arrives first (out-of-order), carrying metadata
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t7',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'completed',
        summary: 'Done',
        lastToolName: 'Bash',
        timestamp: 5000,
      })
    );
    // a late started must not wipe the completed state or its metadata
    useWorkflowStore.getState().handleTaskActivity(
      taskEvent({
        runId: 'run-t7',
        nodeId: 'plan',
        taskId: 't-1',
        activity: 'started',
        description: 'Plan the work',
        timestamp: 1000,
      })
    );
    const task = useWorkflowStore
      .getState()
      .workflows.get('run-t7')!
      .dagNodes.find(n => n.nodeId === 'plan')!.tasks?.[0];
    expect(task?.activity).toBe('completed');
    expect(task?.summary).toBe('Done');
    expect(task?.lastToolName).toBe('Bash');
    // the late started still backfills the description it carried
    expect(task?.description).toBe('Plan the work');
  });

  test('preserves tasks array after a later dag_node event for the same node', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-t6' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-t6', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore
      .getState()
      .handleTaskActivity(
        taskEvent({ runId: 'run-t6', nodeId: 'plan', taskId: 't-1', activity: 'started' })
      );
    // Simulate the node completing — tasks array must survive
    useWorkflowStore.getState().handleDagNode(
      dagNodeEvent({
        runId: 'run-t6',
        nodeId: 'plan',
        name: 'Plan',
        status: 'completed',
        duration: 5000,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-t6')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.status).toBe('completed');
    expect(node.tasks).toHaveLength(1);
  });
});

describe('handleHookActivity', () => {
  test('adds hook row on started', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h1' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-h1', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h1',
        nodeId: 'plan',
        hookId: 'h-1',
        hookName: 'Bash',
        hookEvent: 'PreToolUse',
        activity: 'started',
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-h1')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.hooks).toHaveLength(1);
    expect(node.hooks?.[0]).toMatchObject({
      hookId: 'h-1',
      hookName: 'Bash',
      hookEvent: 'PreToolUse',
      activity: 'started',
    });
  });

  test('response overwrites the started row with outcome and exitCode', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h2' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-h2', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h2',
        nodeId: 'plan',
        hookId: 'h-1',
        hookName: 'Bash',
        hookEvent: 'PreToolUse',
        activity: 'started',
      })
    );
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h2',
        nodeId: 'plan',
        hookId: 'h-1',
        hookName: 'Bash',
        hookEvent: 'PreToolUse',
        activity: 'response',
        outcome: 'success',
        exitCode: 0,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-h2')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.hooks).toHaveLength(1);
    expect(node.hooks?.[0]).toMatchObject({
      hookId: 'h-1',
      activity: 'response',
      outcome: 'success',
      exitCode: 0,
    });
  });

  test('out-of-order response (before started) seeds a response row', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h3' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-h3', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h3',
        nodeId: 'plan',
        hookId: 'h-1',
        hookName: 'Bash',
        hookEvent: 'PreToolUse',
        activity: 'response',
        outcome: 'error',
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-h3')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.hooks).toHaveLength(1);
    expect(node.hooks?.[0].outcome).toBe('error');
  });

  test('late started after a seeded response does not regress activity or drop outcome', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h5' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-h5', nodeId: 'plan', name: 'Plan' }));
    // response arrives first (out-of-order)
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h5',
        nodeId: 'plan',
        hookId: 'h-1',
        activity: 'response',
        outcome: 'success',
        timestamp: 5000,
      })
    );
    // a late started must not regress 'response' → 'started' or drop the outcome
    useWorkflowStore.getState().handleHookActivity(
      hookEvent({
        runId: 'run-h5',
        nodeId: 'plan',
        hookId: 'h-1',
        activity: 'started',
        timestamp: 1000,
      })
    );
    const hook = useWorkflowStore
      .getState()
      .workflows.get('run-h5')!
      .dagNodes.find(n => n.nodeId === 'plan')!.hooks?.[0];
    expect(hook?.activity).toBe('response');
    expect(hook?.outcome).toBe('success');
  });

  test('preserves hooks array after a later dag_node event for the same node', () => {
    useWorkflowStore.getState().handleWorkflowStatus(statusEvent({ runId: 'run-h4' }));
    useWorkflowStore
      .getState()
      .handleDagNode(dagNodeEvent({ runId: 'run-h4', nodeId: 'plan', name: 'Plan' }));
    useWorkflowStore
      .getState()
      .handleHookActivity(
        hookEvent({ runId: 'run-h4', nodeId: 'plan', hookId: 'h-1', activity: 'started' })
      );
    useWorkflowStore.getState().handleDagNode(
      dagNodeEvent({
        runId: 'run-h4',
        nodeId: 'plan',
        name: 'Plan',
        status: 'completed',
        duration: 2000,
      })
    );
    const node = useWorkflowStore
      .getState()
      .workflows.get('run-h4')!
      .dagNodes.find(n => n.nodeId === 'plan')!;
    expect(node.status).toBe('completed');
    expect(node.hooks).toHaveLength(1);
  });
});
