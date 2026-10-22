import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS, removeTempTree } from '@archon/paths/test-utils';
import { chatRunEventSchema, type ConnectedChat, type ChatRunEvent } from '@archon/chat-contract';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import { terminalWorkflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { createWorkflowRun, pauseWorkflowRun } from '@archon/core/db/workflows';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { ChatSupervisor } from './supervisor';
import { ChatPluginPlatform } from './platform';
import { subscribeChatRunEvents, projectRunEvent } from './run-events';
import { descriptor } from './fixtures/descriptor';

let root: string;
const env = { home: process.env.ARCHON_HOME, database: process.env.DATABASE_URL };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-events-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
});
afterEach(async () => {
  await closeDatabase();
  if (env.home === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = env.home;
  if (env.database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = env.database;
  await removeTempTree(root);
});

async function createRun(platform: string, background = false, cost = 0.25) {
  const conversationId = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)`,
    [conversationId, platform, `thread-${platform}`]
  );
  const workerId = crypto.randomUUID();
  if (background) {
    await getDatabase().query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)`,
      [workerId, platform, `worker-${platform}`]
    );
  }
  return createWorkflowRun({
    workflow_name: 'fixture',
    user_message: 'private',
    origin: background
      ? { conversationId: workerId, parentConversationId: conversationId }
      : { conversationId },
    metadata: {
      total_cost_usd: cost,
      ...(platform === 'fixture-chat' ? { total_cost_incomplete: true } : {}),
    },
  });
}

test.each([
  { background: false, cost: 0.25 },
  { background: true, cost: 0.25 },
  { background: false, cost: -0.2 },
  { background: true, cost: -0.2 },
])(
  'owning-plugin routing and presentation with background=$background, cost=$cost',
  async ({ background, cost }) => {
    const first: ChatRunEvent[] = [];
    const second: ChatRunEvent[] = [];
    const make = (id: string, events: ChatRunEvent[]) => {
      const supervisor = new ChatSupervisor(
        { descriptor: { ...descriptor, id }, argv: [process.execPath] },
        () => {},
        () => {}
      );
      const connection: ConnectedChat = {
        descriptor,
        closed: Promise.resolve(),
        start: async () => {},
        close: async () => {},
        send: async () => {},
        resultFooter: async () => {},
        onInbound() {},
        onRunAction() {},
        attentionNotice: async () => ({}),
        runEvent: async event => {
          events.push(event);
        },
      };
      supervisor.request = operation => operation(connection);
      return supervisor;
    };
    const plugins = new Map([
      ['fixture-chat', make('fixture-chat', first)],
      ['other-chat', make('other-chat', second)],
    ]);
    const unsubscribe = subscribeChatRunEvents(plugins, new Map());
    try {
      const runs = await Promise.all(
        ['fixture-chat', 'other-chat', 'web'].map(platform => createRun(platform, background, cost))
      );
      const emitter = getWorkflowEventEmitter();
      for (const [index, run] of runs.entries()) {
        emitter.registerRun(run.id, `thread-${['fixture-chat', 'other-chat', 'web'][index]}`);
        emitter.emit({
          type: 'workflow_started',
          runId: run.id,
          workflowName: run.workflow_name,
          conversationId: run.conversation_id,
          transcriptPath: '/private/path',
        });
        emitter.emit({ type: 'node_started', runId: run.id, nodeId: 'node', nodeName: 'Node' });
        await getDatabase().query(
          `UPDATE remote_agent_workflow_runs SET outcome = 'succeeded' WHERE id = $1`,
          [run.id]
        );
        emitter.emit({
          type: 'approval_pending',
          runId: run.id,
          nodeId: 'gate',
          message: 'Choose',
        });
        emitter.unregisterRun(run.id);
        emitter.emit({
          type: 'workflow_completed',
          runId: run.id,
          workflowName: run.workflow_name,
          duration: 10,
        });
      }
      const deadline = Date.now() + DEFAULT_TEST_TIMEOUT_MS;
      while (first.length < 4 || second.length < 4) {
        if (Date.now() > deadline) throw new Error('Events were not forwarded');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(first.map(event => event.runId)).toEqual(Array(4).fill(runs[0]!.id));
      expect(second.map(event => event.runId)).toEqual(Array(4).fill(runs[1]!.id));
      expect(first[0]).toMatchObject({ conversationId: 'thread-fixture-chat' });
      expect(first[2]).toMatchObject({ type: 'approval_pending', authoredOutcome: 'succeeded' });
      expect(first[3]).toMatchObject({
        type: 'terminal',
        authoredOutcome: 'succeeded',
        totalCostUsd: cost,
        totalCostIncomplete: true,
      });
      expect(chatRunEventSchema.safeParse(first[3]).success).toBe(true);
      expect(second[3]).not.toHaveProperty('totalCostIncomplete');
      expect(JSON.stringify(first)).not.toContain('/private/path');
      expect(
        projectRunEvent({ type: 'container_lifecycle', runId: 'run', phase: 'created' })
      ).toBeUndefined();
      unsubscribe();
      emitter.emit({
        type: 'workflow_completed',
        runId: runs[0]!.id,
        workflowName: 'fixture',
        duration: 0,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(first).toHaveLength(4);
    } finally {
      unsubscribe();
    }
  }
);

test('terminal chat statuses conform exactly to engine terminal statuses', () => {
  const terminal = chatRunEventSchema.options.find(
    branch => branch.shape.type.value === 'terminal'
  );
  expect(terminal).toBeDefined();
  const statuses = terminalWorkflowRunStatusSchema.options;
  for (const status of statuses) {
    expect(chatRunEventSchema.safeParse({ type: 'terminal', runId: 'run', status }).success).toBe(
      true
    );
  }
  expect(terminal?.shape).toHaveProperty('status');
  if (terminal && 'status' in terminal.shape) {
    expect(new Set(terminal.shape.status.options)).toEqual(new Set(statuses));
  }
});

test('a stalled plugin does not delay run events for another plugin', async () => {
  const delivered: ChatRunEvent[] = [];
  const make = (id: string, runEvent: ConnectedChat['runEvent']) => {
    const supervisor = new ChatSupervisor(
      { descriptor: { ...descriptor, id }, argv: [process.execPath] },
      () => {},
      () => {}
    );
    supervisor.runEvent = runEvent;
    return supervisor;
  };
  const plugins = new Map([
    ['fixture-chat', make('fixture-chat', () => new Promise<void>(() => {}))],
    [
      'other-chat',
      make('other-chat', async event => {
        delivered.push(event);
      }),
    ],
  ]);
  const unsubscribe = subscribeChatRunEvents(plugins, new Map());
  try {
    const stalled = await createRun('fixture-chat');
    const healthy = await createRun('other-chat');
    const emitter = getWorkflowEventEmitter();
    for (const run of [stalled, stalled, healthy]) {
      emitter.emit({
        type: 'node_started',
        runId: run.id,
        nodeId: 'node',
        nodeName: 'Node',
      });
    }
    const deadline = Date.now() + DEFAULT_TEST_TIMEOUT_MS;
    while (delivered.length < 1) {
      if (Date.now() > deadline) throw new Error('Healthy plugin was blocked');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(delivered.map(event => event.runId)).toEqual([healthy.id]);
  } finally {
    unsubscribe();
  }
});

test('a cancelled run carries its cancellation reason to the plugin', async () => {
  const delivered: ChatRunEvent[] = [];
  const supervisor = new ChatSupervisor(
    { descriptor, argv: [process.execPath] },
    () => {},
    () => {}
  );
  supervisor.runEvent = async event => {
    delivered.push(event);
  };
  const unsubscribe = subscribeChatRunEvents(new Map([['fixture-chat', supervisor]]), new Map());
  try {
    const run = await createRun('fixture-chat');
    getWorkflowEventEmitter().emit({
      type: 'workflow_cancelled',
      runId: run.id,
      nodeId: 'node',
      reason: 'Cancelled by the run owner',
    });
    const deadline = Date.now() + DEFAULT_TEST_TIMEOUT_MS;
    while (delivered.length < 1) {
      if (Date.now() > deadline) throw new Error('Event was not forwarded');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(delivered[0]).toMatchObject({
      type: 'terminal',
      status: 'cancelled',
      error: 'Cancelled by the run owner',
    });
  } finally {
    unsubscribe();
  }
});

test('suspended and prior-success nodes retain the Slack rendering states', () => {
  expect(
    projectRunEvent({
      type: 'node_suspended',
      runId: 'run',
      nodeId: 'node',
      nodeName: 'Node',
      execution: {
        runId: 'run',
        path: 'node',
        node: { id: 'node', kind: 'workflow' },
        invocation: { id: 'inv', startedAt: '2026-10-13T00:00:00Z', loopPath: [] },
        attempt: { id: 'attempt', startedAt: '2026-10-13T00:00:00Z' },
        binding: {},
        timing: { startedAt: '2026-10-13T00:00:00Z' },
        spend: {
          tokens: { source: 'unavailable', reason: 'not_applicable' },
          costUsd: { source: 'unavailable', reason: 'not_applicable' },
          stopReason: { source: 'unavailable', reason: 'not_applicable' },
          numTurns: { source: 'unavailable', reason: 'not_applicable' },
        },
        accounting: 'node',
        lifecycle: { status: 'suspended', point: 'child_workflow' },
      },
    })
  ).toMatchObject({ type: 'node_state', state: 'running' });
  expect(
    projectRunEvent({
      type: 'node_skipped_prior_success',
      runId: 'run',
      nodeId: 'node',
      nodeName: 'Node',
    })
  ).toMatchObject({ type: 'node_state', state: 'completed' });
});

test('approval projections resolve choices through the workflow owner', () => {
  for (const decisions of [undefined, [{ id: 'ship', label: 'Ship it' }, { id: 'hold' }]]) {
    const projected = projectRunEvent({
      type: 'approval_pending',
      runId: 'run',
      nodeId: 'gate',
      message: 'Choose',
      decisions,
    });
    expect(projected).toMatchObject({ decisions: getApprovalDecisions({ decisions }) });
  }
});

test.each(['matching', 'stale-pause', 'stale-node', 'missing-platform'] as const)(
  'child guidance routing: %s',
  async identity => {
    const delivered: ChatRunEvent[] = [];
    const supervisor = new ChatSupervisor(
      { descriptor, argv: [process.execPath] },
      () => {},
      () => {}
    );
    let routed!: () => void;
    const finished = new Promise<void>(resolve => {
      routed = resolve;
    });
    supervisor.runEvent = async event => {
      delivered.push(event);
      if (event.type === 'terminal') routed();
    };
    const platform = new ChatPluginPlatform(
      { ...descriptor, workflowCommand: { prefix: '/archon-workflow ' } },
      supervisor,
      {}
    );
    const unsubscribe = subscribeChatRunEvents(
      new Map([[descriptor.id, supervisor]]),
      identity === 'missing-platform' ? new Map() : new Map([[descriptor.id, platform]])
    );
    try {
      const run = await createRun(descriptor.id);
      await getDatabase().query(
        "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
        [run.id]
      );
      await pauseWorkflowRun(run.id, {
        nodeId: 'sub',
        pauseId: 'current',
        type: 'child_workflow',
        childRunId: 'child-full-id',
        message: 'Waiting',
      });
      const emitter = getWorkflowEventEmitter();
      emitter.emit({
        type: 'approval_pending',
        runId: run.id,
        nodeId: identity === 'stale-node' ? 'other' : 'sub',
        pauseId: identity === 'stale-pause' ? 'old' : 'current',
        message: 'Waiting',
      });
      emitter.emit({
        type: 'workflow_completed',
        runId: run.id,
        workflowName: 'fixture',
        duration: 0,
      });
      await finished;
      const card = delivered.find(event => event.type === 'approval_pending');
      if (identity === 'matching') {
        expect(card?.message).toContain('/archon-workflow approve child-full-id');
        expect(card?.message).not.toContain('/workflow ');
      } else if (identity === 'missing-platform') {
        expect(card).toBeUndefined();
      } else {
        expect(card?.message).toBe('Waiting');
      }
    } finally {
      unsubscribe();
    }
  }
);
