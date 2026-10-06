import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import {
  getProviderCapabilities,
  providerRegistry,
  registerBuiltinProviders,
} from '@archon/providers';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { createWorkflowStore } from '../workflows/store-adapter';
import { createSqlWorkflowOperations } from '../workflows/sql-host';
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { isApprovalContext } from '@archon/workflows/schemas/workflow-run';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  getWorkflowRun,
  createWorkflowRun,
  pauseWorkflowRun,
  failPausedApproval,
  resumeWorkflowRun,
  cancelWorkflowRun,
} from './workflows';

const { approveWorkflow, rejectWorkflow } = createSqlWorkflowOperations();

const originalHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root: string;
let conversationId: string;

beforeEach(async () => {
  registerBuiltinProviders();
  root = await mkdtemp(join(tmpdir(), 'archon-gate-deferral-'));
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

describe('per-run gate deferral — real SQLite', () => {
  for (const kind of ['loop', 'loop_group'] as const) {
    test.each(['immediate decision', 'failed delivery'] as const)(
      `${kind} persists suspension before %s and leaves no invisible gate`,
      async outcome => {
        let providerCalls = 0;
        let prompts = 0;
        let suspensionVisible = false;
        const store = createWorkflowStore();
        const platform: IWorkflowPlatform = {
          sendMessage: async (_id, message) => {
            if (!message.includes('**Input required**')) return;
            prompts++;
            const runs = await getDatabase().query<{ id: string }>(
              'SELECT id FROM remote_agent_workflow_runs WHERE conversation_id = $1',
              [conversationId]
            );
            const id = runs.rows[0].id;
            const events = await getDatabase().query(
              "SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND step_name = 'review' AND event_type = 'node_suspended'",
              [id]
            );
            suspensionVisible = events.rowCount === 1;
            if (outcome === 'failed delivery') throw new Error('Transport unavailable');
            await approveWorkflow(id, undefined, { kind: 'operator' });
          },
          getPlatformType: () => 'test',
          getStreamingMode: () => 'batch',
        };
        const deps: WorkflowDeps = {
          store,
          providers: providerRegistry,
          getAgentProvider: () => ({
            getType: () => 'claude',
            getCapabilities: () => getProviderCapabilities('claude'),
            checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
            sendQuery: async function* () {
              providerCalls++;
              yield { type: 'agent_message_chunk', text: 'COMPLETE' };
              yield { type: 'result', sessionId: 'review-session' };
              yield { type: 'settled' };
            },
          }),
          loadConfig: async () => ({
            assistant: 'claude',
            baseBranch: 'main',
            assistants: { claude: {}, codex: {} },
            commands: {},
            defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
          }),
        };
        const gate = {
          until: 'COMPLETE',
          interactive: true,
          gate_message: 'Feedback?',
          max_iterations: 2,
        };
        const workflow = makeTestResolvedWorkflow({
          name: `interactive-${kind}`,
          nodes: [
            kind === 'loop'
              ? { id: 'review', loop: { ...gate, prompt: 'Review' } }
              : {
                  id: 'review',
                  loop_group: { ...gate, nodes: [{ id: 'work', prompt: 'Review' }] },
                },
          ],
        });
        const result = await new InProcessWorkflowEngine(deps).submit({
          platform,
          conversationId,
          origin: { conversationId },
          cwd: root,
          workflow,
          userMessage: 'goal',
        });
        const id = result.workflowRunId!;
        expect(prompts).toBe(1);
        expect(suspensionVisible).toBe(true);
        if (outcome === 'failed delivery') {
          expect((await getWorkflowRun(id))?.status).toBe('failed');
          const failed = await getDatabase().query(
            "SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND step_name = 'review' AND event_type = 'node_failed'",
            [id]
          );
          expect(failed.rowCount).toBe(1);
          return;
        }
        await closeDatabase();
        resetDatabase();
        const admission = await new InProcessWorkflowEngine(deps).resume({
          run: (await getWorkflowRun(id))!,
          platform,
          conversationId,
          origin: { conversationId },
          cwd: root,
          legacyWorkflow: workflow,
          userMessage: 'goal',
        });
        expect(admission.accepted).toBe(true);
        if (admission.accepted) await admission.settled;
        expect((await getWorkflowRun(id))?.status).toBe('completed');
        expect(providerCalls).toBe(1);
        expect(prompts).toBe(1);
        expect((await store.getDagResumeSnapshot(id)).completedNodeOutputs.has('review')).toBe(
          true
        );
      }
    );
  }

  test('an early loop-group body approval retains its own identity and decision', async () => {
    let providerQueries = 0;
    const platform: IWorkflowPlatform = {
      sendMessage: async () => {},
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const store = createWorkflowStore();
    const result = await new InProcessWorkflowEngine({
      store,
      providers: providerRegistry,
      getAgentProvider: () => ({
        getType: () => 'claude',
        getCapabilities: () => getProviderCapabilities('claude'),
        checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
        sendQuery: () => {
          providerQueries++;
          throw new Error('Work cannot start before the early gate resolves');
        },
      }),
      loadConfig: async () => ({
        assistant: 'claude',
        baseBranch: 'main',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    }).submit({
      platform,
      conversationId,
      origin: { conversationId },
      cwd: root,
      userMessage: 'goal',
      workflow: makeTestResolvedWorkflow({
        name: 'two-body-gates',
        nodes: [
          {
            id: 'group',
            loop_group: {
              until: 'COMPLETE',
              max_iterations: 2,
              nodes: [
                { id: 'start', approval: { message: 'Start?' } },
                { id: 'work', depends_on: ['start'], prompt: 'Work' },
                { id: 'review', depends_on: ['work'], approval: { message: 'Review?' } },
              ],
            },
          },
        ],
      }),
    });
    const id = result.workflowRunId!;
    expect(providerQueries).toBe(0);
    const approval = (await getWorkflowRun(id))?.metadata.approval;
    if (!isApprovalContext(approval)) throw new Error('Missing early gate');
    expect(approval.nodeId).toBe('start');
    expect(approval.bodyGateId).toBeUndefined();
    await approveWorkflow(id, undefined, { kind: 'operator' });
    const snapshot = await store.getDagResumeSnapshot(id);
    expect(snapshot.completedNodeOutputs.has('group.start')).toBe(true);
    expect(snapshot.completedNodeOutputs.has('group.review')).toBe(false);
    expect(snapshot.completedNodeOutputs.has('group')).toBe(false);
  });

  test('an approval defers behind a same-run wait and presents once after cold resume', async () => {
    const messages: string[] = [];
    const platform: IWorkflowPlatform = {
      sendMessage: async (_id, message) => {
        messages.push(message);
      },
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const store = createWorkflowStore();
    const pause = store.pauseWorkflowRun;
    let waitPaused = () => {};
    const waiting = new Promise<void>(resolve => {
      waitPaused = resolve;
    });
    const pauseWait = store.pauseWorkflowRunForWait;
    store.pauseWorkflowRunForWait = async (...args) => {
      await pauseWait(...args);
      waitPaused();
    };
    store.pauseWorkflowRun = async (...args) => {
      await waiting;
      await pause(...args);
    };
    const deps: WorkflowDeps = {
      store,
      providers: providerRegistry,
      getAgentProvider: () => {
        throw new Error('Unexpected provider');
      },
      loadConfig: async () => ({
        assistant: 'claude',
        baseBranch: 'main',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    };
    const workflow = makeTestResolvedWorkflow({
      name: 'wait-and-gate',
      nodes: [
        { id: 'action', wait: { attention: 'Finish external action' } },
        { id: 'review', approval: { message: 'Review' } },
      ],
    });
    const result = await new InProcessWorkflowEngine(deps).submit({
      platform,
      conversationId,
      origin: { conversationId },
      cwd: root,
      workflow,
      userMessage: 'goal',
    });
    const id = result.workflowRunId!;
    expect((await getWorkflowRun(id))?.status).toBe('paused');
    expect(messages.some(message => message.includes('**Approval required**'))).toBe(false);
    const events = await getDatabase().query<{ event_type: string }>(
      "SELECT event_type FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND step_name = 'review'",
      [id]
    );
    expect(events.rows.map(row => row.event_type)).toEqual(['node_started']);
    await closeDatabase();
    resetDatabase();
    const resume = async () => {
      const admission = await new InProcessWorkflowEngine(deps).resume({
        run: (await getWorkflowRun(id))!,
        platform,
        conversationId,
        origin: { conversationId },
        cwd: root,
        legacyWorkflow: workflow,
        userMessage: 'goal',
      });
      expect(admission.accepted).toBe(true);
      if (admission.accepted) await admission.settled;
    };
    await resume();
    expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(1);
    await approveWorkflow(id, undefined, { kind: 'operator' });
    await resume();
    expect((await getWorkflowRun(id))?.status).toBe('completed');
    expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(1);
  });

  test.each(['approve', 'reject'] as const)(
    'two ordinary gates survive cold resume after %s and retain their own decisions',
    async action => {
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
        providers: providerRegistry,
        getAgentProvider: () => {
          throw new Error('An approval must not start a provider');
        },
        loadConfig: async () => ({
          assistant: 'claude',
          baseBranch: 'main',
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
        origin: { conversationId },
        cwd,
        workflow,
        userMessage: 'goal',
      });
      expect(result.success).toBe(true);
      const id = result.workflowRunId!;
      const initial = await getWorkflowRun(id);
      expect(initial?.status).toBe('paused');
      const first = initial?.metadata?.approval;
      if (!isApprovalContext(first)) throw new Error('Missing first gate');
      expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(1);
      const resume = async (): Promise<void> => {
        const admission = await new InProcessWorkflowEngine(deps).resume({
          run: (await getWorkflowRun(id))!,
          platform,
          conversationId,
          origin: { conversationId },
          cwd,
          legacyWorkflow: workflow,
          userMessage: 'goal',
        });
        expect(admission.accepted).toBe(true);
        if (admission.accepted) await admission.settled;
      };
      const snapshot = await deps.store.getDagResumeSnapshot(id);
      expect(snapshot.completedNodeOutputs.size).toBe(0);
      expect(snapshot.unfinishedInvocations?.size).toBe(2);
      expect(
        await getDatabase().query(
          "SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'node_failed'",
          [id]
        )
      ).toMatchObject({ rowCount: 0 });
      await (action === 'approve' ? approveWorkflow : rejectWorkflow)(id, 'first decision', {
        kind: 'operator',
      });
      await closeDatabase();
      resetDatabase();
      await resume();
      expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(2);
      const second = (await getWorkflowRun(id))?.metadata?.approval;
      if (!isApprovalContext(second)) throw new Error('Missing second gate');
      expect(second.nodeId).not.toBe(first.nodeId);
      await approveWorkflow(id, 'second decision', { kind: 'operator' });
      await resume();
      expect((await getWorkflowRun(id))?.status).toBe('completed');
      expect(messages.filter(message => message.includes('**Approval required**'))).toHaveLength(2);
      const audit = await getDatabase().query<{ step_name: string; data: string }>(
        "SELECT step_name, data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'approval_received' ORDER BY event_order",
        [id]
      );
      expect(
        audit.rows.map(row => ({
          node: row.step_name,
          comment: JSON.parse(row.data).comment ?? JSON.parse(row.data).reason,
        }))
      ).toEqual([
        { node: first.nodeId, comment: 'first decision' },
        { node: second.nodeId, comment: 'second decision' },
      ]);
    }
  );
  test('a failed suspension insert rolls back the pause', async () => {
    const run = await createWorkflowRun({
      workflow_name: 'rollback',
      origin: { conversationId },
      user_message: '',
    });
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
      [run.id]
    );
    await getDatabase()
      .query(`CREATE TRIGGER reject_suspension BEFORE INSERT ON remote_agent_workflow_events
      WHEN NEW.event_type = 'node_suspended' BEGIN SELECT RAISE(ABORT, 'suspension storage unavailable'); END`);
    await expect(
      pauseWorkflowRun(run.id, { nodeId: 'review', message: 'Review' }, undefined, {
        workflow_run_id: run.id,
        step_name: 'review',
        event_type: 'node_suspended',
        data: { suspend_point: 'approval' },
      })
    ).rejects.toThrow('suspension storage unavailable');
    expect((await getWorkflowRun(run.id))?.status).toBe('running');
    expect((await getWorkflowRun(run.id))?.metadata.approval).toBeUndefined();
  });

  test('an undelivered prompt fails only its still-active gate; decisions and cancellation win the race', async () => {
    const run = await createWorkflowRun({
      workflow_name: 'gates',
      origin: { conversationId },
      user_message: '',
    });
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
      [run.id]
    );
    const first = { nodeId: 'first', message: 'Review first', type: 'approval' as const };
    const second = { ...first, nodeId: 'second' };
    await pauseWorkflowRun(run.id, first);
    await approveWorkflow(run.id, undefined, { kind: 'operator' });
    expect(await failPausedApproval(run.id, first, 'late send error')).toEqual({ failed: false });
    await resumeWorkflowRun(run.id);
    await pauseWorkflowRun(run.id, second);
    expect(await failPausedApproval(run.id, first, 'stale send error')).toEqual({ failed: false });
    expect(await failPausedApproval(run.id, second, 'delivery failed')).toEqual({ failed: true });
    expect((await getWorkflowRun(run.id))?.status).toBe('failed');
    const failed = await getDatabase().query<{ data: string }>(
      "SELECT data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'workflow_failed'",
      [run.id]
    );
    expect(failed.rows).toHaveLength(1);
    expect(JSON.parse(failed.rows[0].data)).toMatchObject({
      error: 'delivery failed',
      exit_reason: 'node_error',
    });
    await resumeWorkflowRun(run.id);
    await pauseWorkflowRun(run.id, first);
    await cancelWorkflowRun(run.id);
    expect(await failPausedApproval(run.id, first, 'cancelled send error')).toEqual({
      failed: false,
    });
    expect((await getWorkflowRun(run.id))?.status).toBe('cancelled');
  });

  test('a decision made while prompt delivery is in flight survives the executor finishing that send', async () => {
    const platform: IWorkflowPlatform = {
      sendMessage: async (_id, message) => {
        if (message.includes('**Approval required**')) {
          const runs = await getDatabase().query<{ id: string }>(
            'SELECT id FROM remote_agent_workflow_runs WHERE conversation_id = $1',
            [conversationId]
          );
          await approveWorkflow(runs.rows[0].id, 'immediate decision', { kind: 'operator' });
        }
      },
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const store = createWorkflowStore();
    const result = await new InProcessWorkflowEngine({
      store,
      providers: providerRegistry,
      getAgentProvider: () => {
        throw new Error('Unexpected provider');
      },
      loadConfig: async () => ({
        assistant: 'claude',
        baseBranch: 'main',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    }).submit({
      platform,
      conversationId,
      origin: { conversationId },
      cwd: root,
      workflow: makeTestResolvedWorkflow({
        name: 'fast-approval',
        nodes: [{ id: 'review', approval: { message: 'Review' } }],
      }),
      userMessage: 'goal',
    });
    const snapshot = await store.getDagResumeSnapshot(result.workflowRunId!);
    expect(snapshot.completedNodeOutputs.has('review')).toBe(true);
  });

  test('failed prompt delivery leaves no invisible paused run', async () => {
    const platform: IWorkflowPlatform = {
      sendMessage: async (_id, message) => {
        if (message.includes('**Approval required**')) throw new Error('Transport unavailable');
      },
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const result = await new InProcessWorkflowEngine({
      store: createWorkflowStore(),
      providers: providerRegistry,
      getAgentProvider: () => {
        throw new Error('Unexpected provider');
      },
      loadConfig: async () => ({
        assistant: 'claude',
        baseBranch: 'main',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    }).submit({
      platform,
      conversationId,
      origin: { conversationId },
      cwd: root,
      workflow: makeTestResolvedWorkflow({
        name: 'undelivered',
        nodes: [{ id: 'review', approval: { message: 'Review' } }],
      }),
      userMessage: 'goal',
    });
    const run = await getWorkflowRun(result.workflowRunId!);
    expect(run?.status).toBe('failed');
    expect(run?.metadata?.error).toContain('message failed to deliver');
  });
});
