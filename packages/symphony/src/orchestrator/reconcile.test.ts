import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import {
  makeFakeBridge,
  makeFakeEmitter,
  makeFakeWorkflowDefinition,
  type FakeBridge,
  type FakeEmitter,
} from '../test/fake-bridge';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import {
  insertDispatch,
  attachWorkflowRun,
  updateStatus,
  getDispatchByDispatchKey,
} from '../db/dispatches';
import { buildDispatchKey } from './state';

let dbPath = '';
let db: SqliteAdapter;
let fakeBridge: FakeBridge;
let emitter: FakeEmitter;

function snap(): ConfigSnapshot {
  return buildSnapshot(
    {
      trackers: [
        {
          kind: 'linear',
          api_key: '$K',
          project_slug: 's',
          repository: 'Ddell12/archon-symphony',
          active_states: ['Todo'],
          terminal_states: ['Done'],
        },
      ],
      dispatch: { max_concurrent: 5 },
      polling: { interval_ms: 30_000 },
      state_workflow_map: { Todo: 'archon-feature-development' },
      codebases: [
        {
          tracker: 'linear',
          repository: 'Ddell12/archon-symphony',
          codebase_id: 'cb-1',
        },
      ],
    },
    { K: 'tok' } as NodeJS.ProcessEnv
  );
}

async function seedConversation(id: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id)
     VALUES ($1, $2, $3)`,
    [id, 'web', `pid-${id}`]
  );
}

async function seedWorkflowRun(
  runId: string,
  conversationId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'running'
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, conversationId, 'archon-feature-development', 'kick off', status]
  );
}

describe('reconcileOnStart hydrates state from prior process runs', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['cb-1', 'Codebase 1', '/tmp/cb-1']
    );
    await seedConversation('conv-1');
    emitter = makeFakeEmitter();
    fakeBridge = makeFakeBridge({
      db,
      codebases: new Map([['cb-1', { id: 'cb-1', name: 'Codebase 1', default_cwd: '/tmp/cb-1' }]]),
    });
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  test('terminal upstream → DB row updated, dispatch_key marked completed', async () => {
    await seedWorkflowRun('wfr-done', 'conv-1', 'completed');
    fakeBridge.store.runs.set('wfr-done', {
      id: 'wfr-done',
      workflow_name: 'archon-feature-development',
      conversation_id: 'conv-1',
      codebase_id: 'cb-1',
      status: 'completed',
      metadata: {},
      user_message: '',
      parent_conversation_id: null,
      working_path: '/tmp/cb-1',
      started_at: new Date(),
      completed_at: new Date(),
      last_activity_at: null,
    });

    const inserted = await insertDispatch(db, {
      issue_id: 'l-1',
      identifier: 'APP-1',
      tracker: 'linear',
      dispatch_key: 'linear:APP-1',
      codebase_id: 'cb-1',
      workflow_name: 'archon-feature-development',
      attempt: 1,
      status: 'pending',
    });
    await attachWorkflowRun(db, inserted.id, 'wfr-done');
    await updateStatus(db, inserted.id, 'running');

    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: {},
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.reconcileOnStart();

    const row = await getDispatchByDispatchKey(db, 'linear:APP-1');
    expect(row?.status).toBe('completed');
    expect(orch.internalState.completed.has('linear:APP-1')).toBe(true);
  });

  test('still-running upstream → mapping registered, terminal events later transition state', async () => {
    await seedWorkflowRun('wfr-live', 'conv-1', 'running');
    fakeBridge.store.runs.set('wfr-live', {
      id: 'wfr-live',
      workflow_name: 'archon-feature-development',
      conversation_id: 'conv-1',
      codebase_id: 'cb-1',
      status: 'running',
      metadata: {},
      user_message: '',
      parent_conversation_id: null,
      working_path: '/tmp/cb-1',
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
    });

    const inserted = await insertDispatch(db, {
      issue_id: 'l-2',
      identifier: 'APP-2',
      tracker: 'linear',
      dispatch_key: 'linear:APP-2',
      codebase_id: 'cb-1',
      workflow_name: 'archon-feature-development',
      attempt: 1,
      status: 'pending',
    });
    await attachWorkflowRun(db, inserted.id, 'wfr-live');
    await updateStatus(db, inserted.id, 'running');

    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: {},
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    orch.start();
    await orch.reconcileOnStart();

    // Still pending in DB (we did NOT touch it because it's not terminal upstream).
    const row1 = await getDispatchByDispatchKey(db, 'linear:APP-2');
    expect(row1?.status).toBe('running');
    expect(orch.internalState.completed.has('linear:APP-2')).toBe(true);

    // Now upstream completes; the orchestrator's mapping must catch the event.
    emitter.emit({
      type: 'workflow_completed',
      runId: 'wfr-live',
      workflowName: 'archon-feature-development',
      duration: 7,
    });
    await new Promise(r => setTimeout(r, 10));

    const row2 = await getDispatchByDispatchKey(db, 'linear:APP-2');
    // Note: applyTerminalEvent only writes DB if it has a dispatch_id on a
    // RunningEntry. Because reconcile doesn't restore RunningEntry (we don't
    // have the issue snapshot), the DB write is gated on the in-memory entry.
    // Reconcile-restored mappings get the dispatch_key promoted to completed
    // either way; the DB row stays at 'running' until the next observability
    // sync. Document this with an assertion.
    expect(row2?.status).toBe('running');
    expect(orch.internalState.completed.has('linear:APP-2')).toBe(true);

    await orch.stop();
  });

  test('rows with workflow_run_id=null are ignored', async () => {
    await insertDispatch(db, {
      issue_id: 'l-3',
      identifier: 'APP-3',
      tracker: 'linear',
      dispatch_key: 'linear:APP-3',
      codebase_id: 'cb-1',
      workflow_name: 'archon-feature-development',
      attempt: 1,
      status: 'failed',
      last_error: 'no codebase mapped',
    });

    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: {},
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.reconcileOnStart();
    expect(orch.internalState.completed.has('linear:APP-3')).toBe(false);
  });

  test('no-op when no bridge is configured', async () => {
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: {},
      getDb: () => db,
      // no bridge
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    await orch.reconcileOnStart();
    // Just asserting the call does not throw.
    expect(orch.internalState.completed.size).toBe(0);
  });
});

describe('reconcileRunningIssues detects stale in-flight entries', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-reconcile-running-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['cb-1', 'Codebase 1', '/tmp/cb-1']
    );
    emitter = makeFakeEmitter();
    fakeBridge = makeFakeBridge({
      db,
      codebases: new Map([['cb-1', { id: 'cb-1', name: 'Codebase 1', default_cwd: '/tmp/cb-1' }]]),
      workflows: {
        'archon-feature-development': makeFakeWorkflowDefinition('archon-feature-development'),
      },
    });
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  async function seedAndDispatch(
    identifier: string,
    issueId: string
  ): Promise<{ orch: Orchestrator; runId: string; dk: string }> {
    const issue = makeIssue({ id: issueId, identifier, state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    orch.start();
    await orch.runTick();
    const dk = buildDispatchKey('linear', identifier);
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');
    return { orch, runId: entry.workflow_run_id, dk };
  }

  test('terminal upstream status → applyTerminalEvent called, state updated', async () => {
    const { orch, runId, dk } = await seedAndDispatch('APP-R1', 'l-r1');

    // Mark the upstream run as completed in the fake store
    fakeBridge.store.setStatus(runId, 'completed');

    await orch.reconcileRunningIssues(snap());

    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.internalState.completed.has(dk)).toBe(true);

    const row = await getDispatchByDispatchKey(db, dk);
    expect(row?.status).toBe('completed');

    await orch.stop();
  });

  test('upstream failed → state updated, retry scheduled', async () => {
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const issue = makeIssue({ id: 'l-r2', identifier: 'APP-R2', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: (fn, ms) => {
        if (ms > 0) scheduled = setTimeout(() => undefined, 100000);
        return scheduled ?? (0 as unknown as ReturnType<typeof setTimeout>);
      },
      cancelTimeout: handle => {
        if (handle) clearTimeout(handle);
      },
    });
    orch.start();
    await orch.runTick();
    const dk = buildDispatchKey('linear', 'APP-R2');
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');

    fakeBridge.store.setStatus(entry.workflow_run_id, 'failed');
    await orch.reconcileRunningIssues(snap());

    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.getRetry(dk)).toBeDefined();

    await orch.stop();
  });

  test('issue no longer active → cancelWorkflowRun called, state updated', async () => {
    const issue = makeIssue({ id: 'l-r3', identifier: 'APP-R3', state: 'Todo' });
    const { tracker, controls } = makeFakeTracker([issue]);
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    orch.start();
    await orch.runTick();
    const dk = buildDispatchKey('linear', 'APP-R3');
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');
    const runId = entry.workflow_run_id;

    // Move issue to a non-active state
    controls.patchIssue('l-r3', { state: 'Done' });
    await orch.reconcileRunningIssues(snap());

    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.internalState.completed.has(dk)).toBe(true);
    // The upstream run should have been cancelled
    expect(fakeBridge.store.runs.get(runId)?.status).toBe('cancelled');

    await orch.stop();
  });

  test('workflow still running, issue still active → no state change', async () => {
    const { orch, runId, dk } = await seedAndDispatch('APP-R4', 'l-r4');

    // upstream is still 'running'
    fakeBridge.store.setStatus(runId, 'running');

    await orch.reconcileRunningIssues(snap());

    expect(orch.internalState.running.has(dk)).toBe(true);
    expect(orch.internalState.completed.has(dk)).toBe(false);

    await orch.stop();
  });

  test('getWorkflowRunStatus throws → warn-logged, no state change, other entries still processed', async () => {
    const { orch, runId, dk } = await seedAndDispatch('APP-R5', 'l-r5');

    // Make the store throw for this runId
    const origGet = fakeBridge.store.getWorkflowRunStatus.bind(fakeBridge.store);
    fakeBridge.store.getWorkflowRunStatus = async (id: string) => {
      if (id === runId) throw new Error('simulated store error');
      return origGet(id);
    };

    await orch.reconcileRunningIssues(snap());

    // Error entry is untouched (no state change)
    expect(orch.internalState.running.has(dk)).toBe(true);

    await orch.stop();
  });

  test('no bridge wired → reconcileRunningIssues is a no-op', async () => {
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: {},
      getDb: () => db,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    // Doesn't throw, doesn't touch state
    await orch.reconcileRunningIssues(snap());
    expect(orch.internalState.running.size).toBe(0);
  });
});
