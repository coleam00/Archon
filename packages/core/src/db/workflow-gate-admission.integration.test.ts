import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { registerBuiltinProviders } from '@archon/providers';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { createWorkflowStore } from '../workflows/store-adapter';
import { approveWorkflow } from '../operations/workflow-operations';
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { readGateQueue, type ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  createWorkflowRun,
  getWorkflowRun,
  resolveApprovalGate,
  resolveAndCancelApprovalGate,
  resumeWorkflowRun,
} from './workflows';
import {
  registerWorkflowGate,
  getWorkflowGateState,
  settleWorkflowGates,
  claimWorkflowGatePresentation,
  confirmWorkflowGatePresentation,
  failWorkflowGatePresentation,
  reconcileWorkflowGateChild,
  consumeWorkflowGateContinuation,
} from './workflow-gate-admission';

const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root: string;
let conversationId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-gate-admission-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  conversationId = crypto.randomUUID();
  await getDatabase().query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'test', $1)`,
    [conversationId]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

async function seed(parentRunId?: string, nodeId?: string): Promise<string> {
  const run = await createWorkflowRun({
    workflow_name: 'gates',
    conversation_id: conversationId,
    user_message: '',
    parent_run_id: parentRunId,
    metadata: { unrelated: { keep: true }, ...(nodeId ? { parent_node_id: nodeId } : {}) },
  });
  await getDatabase().query(
    "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
    [run.id]
  );
  return run.id;
}

function gate(nodeId: string, fields: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    nodeId,
    message: `Review ${nodeId}`,
    type: 'approval',
    gateId: crypto.randomUUID(),
    ...fields,
  };
}

async function queue(runId: string) {
  const row = await getWorkflowRun(runId);
  expect(row?.status).toBe('paused');
  return readGateQueue(row!.metadata)!;
}

async function resolve(runId: string, context: ApprovalContext) {
  return resolveApprovalGate(
    runId,
    {
      approval: { ...context, resolved: 'approved' },
      approval_response: 'approve',
    },
    [{ event_type: 'approval_received', step_name: context.nodeId, data: { decision: 'approve' } }]
  );
}

describe('durable workflow gate admission', () => {
  test('refuses presentation and resume when a modern root queue is missing', async () => {
    const id = await seed();
    await registerWorkflowGate(id, gate('lost'));
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET metadata = json_remove(metadata, '$.gate_queue') WHERE id = $1",
      [id]
    );
    await expect(getWorkflowGateState(id)).rejects.toThrow(
      'Gate projection has no admission queue'
    );
    await expect(resumeWorkflowRun(id)).rejects.toThrow('Gate projection has no admission queue');
    expect((await getWorkflowRun(id))?.status).toBe('paused');
  });

  test('contending admissions retain both gates; settlement and presentation are exact claims', async () => {
    const id = await seed();
    const first = gate('first', {
      type: 'interactive_loop',
      iteration: 2,
      completionSignaled: true,
    });
    const second = gate('second');
    const admissions = await Promise.all([
      registerWorkflowGate(id, first, { pending_writeback: { envId: 'overlay' } }),
      registerWorkflowGate(id, second),
    ]);
    expect(admissions.map(result => result.status === 'registered' && result.position)).toEqual([
      'active',
      'queued',
    ]);
    expect(await registerWorkflowGate(id, second)).toEqual(admissions[1]);
    const collecting = await queue(id);
    expect(collecting.active?.id).toBe(first.gateId);
    expect(collecting.pending.map(record => record.id)).toEqual([second.gateId!]);
    expect(await claimWorkflowGatePresentation(id)).toBeNull();
    expect(await resolve(id, first)).toEqual({ resolved: false });
    expect((await getWorkflowRun(id))?.metadata).toMatchObject({
      unrelated: { keep: true },
      pending_writeback: { envId: 'overlay' },
    });
    await settleWorkflowGates(id);
    const claims = await Promise.all([
      claimWorkflowGatePresentation(id),
      claimWorkflowGatePresentation(id),
    ]);
    expect(claims.filter(Boolean).map(record => record!.id)).toEqual([first.gateId!]);
    await confirmWorkflowGatePresentation(id, first.gateId!);
    expect(await resolve(id, first)).toEqual({
      resolved: true,
      admissionOwnerId: id,
      promotedGateId: second.gateId,
    });
    expect(await resolve(id, first)).toEqual({ resolved: false });
    expect(await resolve(id, second)).toEqual({ resolved: false });
    expect((await claimWorkflowGatePresentation(id))?.id).toBe(second.gateId);
    await confirmWorkflowGatePresentation(id, second.gateId!);
    expect(await resolve(id, second)).toEqual({
      resolved: true,
      admissionOwnerId: id,
    });
    const final = await queue(id);
    expect(final.active).toBeNull();
    expect(final.resolved.map(record => record.context.nodeId)).toEqual(['first', 'second']);
    expect(await registerWorkflowGate(id, first)).toMatchObject({
      status: 'already_resolved',
      gate: { id: first.gateId },
    });
    expect((await queue(id)).active).toBeNull();
    const events = await getDatabase().query<{ event_type: string; data: string }>(
      'SELECT event_type, data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 ORDER BY id',
      [id]
    );
    expect(events.rows.filter(row => row.event_type === 'approval_received')).toHaveLength(2);
    expect(events.rows.filter(row => row.event_type === 'approval_requested')).toHaveLength(2);
    expect(
      JSON.parse(events.rows.find(row => row.event_type === 'approval_requested')!.data)
    ).toMatchObject({
      gate_id: first.gateId,
      iteration: 2,
      completionSignaled: true,
    });
  });

  test('two ordinary gates survive a cold engine resume and record only their own decisions', async () => {
    registerBuiltinProviders();
    const cwd = join(root, 'project');
    await mkdir(cwd);
    const messages: string[] = [];
    const platform: IWorkflowPlatform = {
      sendMessage: async (_id, message) => {
        messages.push(message);
      },
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const deps: WorkflowDeps = {
      store: createWorkflowStore(),
      getAgentProvider: () => {
        throw new Error('An approval must not start a provider');
      },
      loadConfig: async () => ({
        assistant: 'claude',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    };
    const workflow = makeTestResolvedWorkflow({
      name: 'gates',
      nodes: ['first', 'second'].map(id => ({
        id,
        approval: { message: `Review ${id}`, decisions: [{ id: 'approve' }, { id: 'reject' }] },
      })),
    });
    const result = await new InProcessWorkflowEngine(deps).submit({
      platform,
      conversationId,
      conversationDbId: conversationId,
      cwd,
      workflow,
      userMessage: 'goal',
    });
    expect(result.success).toBe(true);
    const id = result.workflowRunId!;
    const initial = await queue(id);
    const first = initial.active!;
    const second = initial.pending[0];
    const resume = async (): Promise<void> => {
      const admission = await new InProcessWorkflowEngine(deps).resume({
        run: (await getWorkflowRun(id))!,
        platform,
        conversationId,
        conversationDbId: conversationId,
        cwd,
        legacyWorkflow: workflow,
        userMessage: 'goal',
      });
      expect(admission.accepted).toBe(true);
      if (admission.accepted) await admission.settled;
    };
    await approveWorkflow(id, 'first decision', first.id);
    await resume();
    await resume();
    expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(2);
    expect((await queue(id)).active?.id).toBe(second.id);
    await expect(approveWorkflow(id, 'stale click', first.id)).rejects.toThrow('gate has changed');
    await approveWorkflow(id, 'second decision', second.id);
    await resume();
    expect((await getWorkflowRun(id))?.status).toBe('completed');
    const audit = await getDatabase().query<{ step_name: string; data: string }>(
      "SELECT step_name, data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'approval_received' ORDER BY event_order",
      [id]
    );
    expect(
      audit.rows.map(row => ({ node: row.step_name, comment: JSON.parse(row.data).comment }))
    ).toEqual([
      { node: first.context.nodeId, comment: 'first decision' },
      { node: second.context.nodeId, comment: 'second decision' },
    ]);
  });

  test('a presentation failure cannot fail the sibling promoted while the send was in flight', async () => {
    const id = await seed();
    const first = gate('first');
    const second = gate('second');
    await registerWorkflowGate(id, first);
    await registerWorkflowGate(id, second);
    await settleWorkflowGates(id);
    await claimWorkflowGatePresentation(id);
    await resolve(id, first);
    expect(await failWorkflowGatePresentation(id, first.gateId!, 'send failed')).toEqual({
      failed: false,
    });
    expect((await queue(id)).active?.id).toBe(second.gateId);
    await claimWorkflowGatePresentation(id);
    expect(await failWorkflowGatePresentation(id, second.gateId!, 'send failed')).toEqual({
      failed: true,
    });
    expect((await getWorkflowRun(id))?.status).toBe('failed');
  });

  test('resume cannot replay a parked layer; consuming a resolved gate leaves its sibling intact', async () => {
    const id = await seed();
    const first = gate('first');
    const second = gate('second');
    await registerWorkflowGate(id, first);
    await registerWorkflowGate(id, second);
    await settleWorkflowGates(id);
    await claimWorkflowGatePresentation(id);
    await resolve(id, first);
    await expect(resumeWorkflowRun(id)).rejects.toThrow('not resumable');
    await consumeWorkflowGateContinuation(id, first.gateId!);
    const state = await queue(id);
    expect(state.resolved).toEqual([]);
    expect(state.active?.id).toBe(second.gateId);
    expect(state.active?.presentation).toBe('unclaimed');
  });

  test('a completed resolved child cannot clear the active sibling; a terminal unresolved child ends the parent', async () => {
    const parent = await seed();
    const child1 = await seed(parent, 'first');
    const child2 = await seed(parent, 'second');
    const first = gate('review');
    const second = gate('review');
    await registerWorkflowGate(child1, first);
    await registerWorkflowGate(child2, second);
    await settleWorkflowGates(child1);
    await settleWorkflowGates(child2);
    await settleWorkflowGates(parent);
    await claimWorkflowGatePresentation(parent);
    await resolve(child1, first);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [child1]
    );
    await reconcileWorkflowGateChild(child1);
    expect((await queue(parent)).active?.id).toBe(second.gateId);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1",
      [child2]
    );
    await reconcileWorkflowGateChild(child2);
    expect((await getWorkflowRun(parent))?.status).toBe('failed');
  });

  test('a parent blocked on a child wait can admit a human gate without inventing a wait decision', async () => {
    const parent = await seed();
    const child = await seed(parent, 'child');
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $2 WHERE id = $1",
      [
        child,
        JSON.stringify({
          parent_node_id: 'child',
          wait: {
            owner: 'node',
            nodeId: 'deadline',
            kind: 'time',
            waitingSince: '2026-10-04T12:00:00Z',
            resumeAt: '2026-10-05T12:00:00Z',
          },
        }),
      ]
    );
    expect(
      await registerWorkflowGate(parent, {
        nodeId: 'child',
        type: 'child_workflow',
        childRunId: child,
        message: 'Waiting for child',
      })
    ).toEqual({ status: 'blocked_on_child', ownerId: parent });
    await registerWorkflowGate(parent, gate('review'));
    const state = await queue(parent);
    expect(state.active?.context.nodeId).toBe('review');
    expect(state.pending).toEqual([]);
    expect(state.resolved).toEqual([]);
    expect((await getWorkflowRun(child))?.metadata.wait).toMatchObject({
      kind: 'time',
      nodeId: 'deadline',
    });
  });

  test('a separate SQLite writer commits before admission reads and preserves both requests', async () => {
    const id = await seed();
    const first = gate('first');
    const second = gate('second');
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `
      import { registerWorkflowGate } from './packages/core/src/db/workflow-gate-admission.ts';
      import { getDatabase, closeDatabase } from './packages/core/src/db/connection.ts';
      await registerWorkflowGate(process.env.GATE_TEST_RUN_ID, {
        gateId: process.env.GATE_TEST_FIRST_ID, nodeId: 'first', message: 'Review first', type: 'approval'
      });
      await getDatabase().withTransaction(async query => {
        await query("UPDATE remote_agent_workflow_runs SET metadata = json_set(metadata, '$.other_process', true) WHERE id = $1", [process.env.GATE_TEST_RUN_ID]);
        console.log('GATE_WRITER_LOCKED');
        await Bun.sleep(100);
      });
      await closeDatabase();
    `,
      ],
      {
        cwd: join(import.meta.dir, '../../../..'),
        env: {
          ...process.env,
          DATABASE_URL: '',
          ARCHON_HOME: root,
          GATE_TEST_RUN_ID: id,
          GATE_TEST_FIRST_ID: first.gateId,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    try {
      const reader = child.stdout.getReader();
      let output = '';
      while (!output.split('\n').includes('GATE_WRITER_LOCKED')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('The scratch SQLite writer exited before taking its lock');
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(await registerWorkflowGate(id, second)).toMatchObject({
        status: 'registered',
        position: 'queued',
      });
      expect(await child.exited).toBe(0);
      const state = await queue(id);
      expect(state.active?.id).toBe(first.gateId);
      expect(state.pending.map(record => record.id)).toEqual([second.gateId!]);
      expect((await getWorkflowRun(id))?.metadata.other_process).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });

  test('child gates share the root slot and promotion does not wait for child completion', async () => {
    const parent = await seed();
    const firstChild = await seed(parent, 'first');
    const secondChild = await seed(parent, 'second');
    const first = gate('review');
    const second = gate('review');
    await registerWorkflowGate(firstChild, first);
    await registerWorkflowGate(secondChild, second);
    await settleWorkflowGates(firstChild);
    await settleWorkflowGates(secondChild);
    expect(await claimWorkflowGatePresentation(firstChild)).toBeNull();
    await settleWorkflowGates(parent);
    expect((await claimWorkflowGatePresentation(parent))?.runId).toBe(firstChild);
    await confirmWorkflowGatePresentation(parent, first.gateId!);
    expect(await resolve(secondChild, second)).toEqual({ resolved: false });
    expect(await resolve(firstChild, first)).toEqual({
      resolved: true,
      admissionOwnerId: parent,
      promotedGateId: second.gateId,
    });
    expect((await getWorkflowRun(firstChild))?.status).toBe('paused');
    expect((await getWorkflowRun(parent))?.metadata.approval).toMatchObject({
      type: 'child_workflow',
      nodeId: 'second',
      childRunId: secondChild,
    });
    expect((await claimWorkflowGatePresentation(parent))?.runId).toBe(secondChild);
    const block = await registerWorkflowGate(parent, {
      type: 'child_workflow',
      nodeId: 'second',
      childRunId: secondChild,
      message: 'Blocked on child',
    });
    expect(block).toMatchObject({ status: 'registered', gateId: second.gateId });
    expect((await queue(parent)).pending).toEqual([]);
  });

  test('a delivery claim survives a cold read and is never automatically claimed again', async () => {
    const id = await seed();
    await registerWorkflowGate(id, gate('review'));
    await settleWorkflowGates(id);
    expect(await claimWorkflowGatePresentation(id)).not.toBeNull();
    await closeDatabase();
    resetDatabase();
    expect((await queue(id)).active?.presentation).toBe('claimed');
    expect(await claimWorkflowGatePresentation(id)).toBeNull();
  });

  test('legacy resolution cannot bypass modern gate identity and terminal rejection keeps pending gates inert', async () => {
    const id = await seed();
    const first = gate('first');
    const second = gate('second');
    await registerWorkflowGate(id, first);
    await registerWorkflowGate(id, second);
    await settleWorkflowGates(id);
    await claimWorkflowGatePresentation(id);
    expect(
      await resolveApprovalGate(
        id,
        {
          approval: { nodeId: 'first', message: 'Review first', resolved: 'approved' },
        },
        []
      )
    ).toEqual({ resolved: false });
    expect(
      await resolveAndCancelApprovalGate(
        id,
        [],
        { step_name: 'second', reason: 'Reject second' },
        second.gateId
      )
    ).toEqual({ resolved: false });
    expect(
      await resolveAndCancelApprovalGate(
        id,
        [{ event_type: 'approval_received', step_name: 'first', data: { decision: 'reject' } }],
        { step_name: 'first', reason: 'Reject first' },
        first.gateId
      )
    ).toEqual({ resolved: true, admissionOwnerId: id, terminalRunIds: [id] });
    const row = await getWorkflowRun(id);
    expect(row?.status).toBe('cancelled');
    expect(readGateQueue(row!.metadata)?.pending.map(record => record.id)).toEqual([
      second.gateId!,
    ]);
    expect(readGateQueue(row!.metadata)?.resolved).toEqual([]);
    expect(await claimWorkflowGatePresentation(id)).toBeNull();
  });

  test('an audit failure rolls back resolution and promotion', async () => {
    const id = await seed();
    const first = gate('first');
    await registerWorkflowGate(id, first);
    await registerWorkflowGate(id, gate('second'));
    await settleWorkflowGates(id);
    await claimWorkflowGatePresentation(id);
    await getDatabase()
      .query(`CREATE TRIGGER reject_gate_event BEFORE INSERT ON remote_agent_workflow_events
      WHEN NEW.event_type = 'approval_received' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`);
    await expect(resolve(id, first)).rejects.toThrow('test audit failure');
    expect((await queue(id)).active?.id).toBe(first.gateId);
    expect((await queue(id)).resolved).toEqual([]);
  });

  test('registration and presentation cannot revive an externally stopped owner', async () => {
    expect(await registerWorkflowGate('deleted-run', gate('review'))).toEqual({
      status: 'externally_stopped',
      runId: 'deleted-run',
      runStatus: null,
    });
    const id = await seed();
    const first = gate('first');
    await registerWorkflowGate(id, first);
    await settleWorkflowGates(id);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'cancelled' WHERE id = $1",
      [id]
    );
    expect(await registerWorkflowGate(id, gate('second'))).toEqual({
      status: 'externally_stopped',
      runId: id,
      runStatus: 'cancelled',
    });
    expect(await claimWorkflowGatePresentation(id)).toBeNull();
    expect(await resolve(id, first)).toEqual({ resolved: false });
    expect((await getWorkflowRun(id))?.status).toBe('cancelled');
  });

  test('legacy presented gates normalize without notification and preserve their continuation', async () => {
    const id = await seed();
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $2 WHERE id = $1",
      [
        id,
        JSON.stringify({
          unrelated: { keep: true },
          approval: {
            nodeId: 'old',
            message: 'Old gate',
            type: 'interactive_loop',
            resolved: 'approved',
            iteration: 2,
          },
          loop_user_input: 'specific feedback',
          loop_feedback_given: true,
        }),
      ]
    );
    await registerWorkflowGate(id, gate('new'));
    const state = await queue(id);
    expect(state.resolved[0]?.response).toMatchObject({
      resolved: 'approved',
      loop_user_input: 'specific feedback',
      loop_feedback_given: true,
    });
    expect(state.active?.context.nodeId).toBe('new');
    expect(state.active?.readyForPresentation).toBe(false);
    expect(await claimWorkflowGatePresentation(id)).toBeNull();
  });
});
