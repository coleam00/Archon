import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { chatRunEventSchema, type ConnectedChat, type ChatRunEvent } from '@archon/chat-contract';
import { terminalWorkflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { createWorkflowRun } from '@archon/core/db/workflows';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { ChatSupervisor } from './supervisor';
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

async function createRun(platform: string, background = false) {
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
    metadata: { total_cost_usd: 0.25 },
  });
}

test.each([false, true])(
  'owning-plugin routing and presentation with background=%s',
  async background => {
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
    const unsubscribe = subscribeChatRunEvents(plugins);
    try {
      const runs = await Promise.all(
        ['fixture-chat', 'other-chat', 'web'].map(platform => createRun(platform, background))
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
        emitter.unregisterRun(run.id);
        emitter.emit({
          type: 'workflow_completed',
          runId: run.id,
          workflowName: run.workflow_name,
          duration: 10,
        });
      }
      const deadline = Date.now() + 2000;
      while (first.length < 3 || second.length < 3) {
        if (Date.now() > deadline) throw new Error('Events were not forwarded');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(first.map(event => event.runId)).toEqual(Array(3).fill(runs[0]!.id));
      expect(second.map(event => event.runId)).toEqual(Array(3).fill(runs[1]!.id));
      expect(first[0]).toMatchObject({ conversationId: 'thread-fixture-chat' });
      expect(first[2]).toMatchObject({
        type: 'terminal',
        authoredOutcome: 'succeeded',
        totalCostUsd: 0.25,
      });
      expect(JSON.stringify(first)).not.toContain('/private/path');
      expect(
        projectRunEvent({ type: 'container_lifecycle', runId: 'run', phase: 'created' }, 'thread')
      ).toBeUndefined();
      unsubscribe();
      emitter.emit({
        type: 'workflow_completed',
        runId: runs[0]!.id,
        workflowName: 'fixture',
        duration: 0,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(first).toHaveLength(3);
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
