import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import {
  makeFakeBridge,
  makeFakeEmitter,
  makeFakeWorkflowDefinition,
  type FakeBridge,
  type FakeEmitter,
} from '../test/fake-bridge';
import { getDispatchByDispatchKey } from '../db/dispatches';
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

describe('terminal workflow events drive Symphony state transitions', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-term-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

  async function tickAndGetRunId(orch: Orchestrator, identifier: string): Promise<string> {
    await orch.runTick();
    const dk = buildDispatchKey('linear', identifier);
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) {
      throw new Error('expected running entry with workflow_run_id');
    }
    return entry.workflow_run_id;
  }

  test('workflow_completed → DB status=completed, state moves to completed set', async () => {
    const issue = makeIssue({ id: 'l-1', identifier: 'APP-1', state: 'Todo' });
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

    const runId = await tickAndGetRunId(orch, 'APP-1');

    emitter.emit({
      type: 'workflow_completed',
      runId,
      workflowName: 'archon-feature-development',
      duration: 12,
    });
    // Allow the async DB write inside applyTerminalEvent to land
    await new Promise(r => setTimeout(r, 10));

    const dk = buildDispatchKey('linear', 'APP-1');
    const row = await getDispatchByDispatchKey(db, dk);
    expect(row?.status).toBe('completed');
    expect(orch.internalState.completed.has(dk)).toBe(true);
    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.getRetry(dk)).toBeUndefined();

    await orch.stop();
  });

  test('workflow_failed → DB status=failed, retry scheduled', async () => {
    const issue = makeIssue({ id: 'l-2', identifier: 'APP-2', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => emitter,
      scheduleTimeout: (fn, ms) => {
        // Record the retry timer but never auto-fire — keeps the test bounded.
        if (ms > 0) scheduled = setTimeout(() => undefined, 100000);
        return scheduled ?? (0 as unknown as ReturnType<typeof setTimeout>);
      },
      cancelTimeout: handle => {
        if (handle) clearTimeout(handle);
      },
    });
    orch.start();
    const runId = await tickAndGetRunId(orch, 'APP-2');

    emitter.emit({
      type: 'workflow_failed',
      runId,
      workflowName: 'archon-feature-development',
      error: 'turn timeout',
    });
    await new Promise(r => setTimeout(r, 10));

    const dk = buildDispatchKey('linear', 'APP-2');
    const row = await getDispatchByDispatchKey(db, dk);
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('turn timeout');
    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.internalState.completed.has(dk)).toBe(false);
    expect(orch.getRetry(dk)).toBeDefined();
    expect(orch.getRetry(dk)?.delay_type).toBe('failure');

    await orch.stop();
  });

  test('workflow_cancelled → DB status=cancelled, no retry', async () => {
    const issue = makeIssue({ id: 'l-3', identifier: 'APP-3', state: 'Todo' });
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
    const runId = await tickAndGetRunId(orch, 'APP-3');

    emitter.emit({
      type: 'workflow_cancelled',
      runId,
      nodeId: 'n0',
      reason: 'user_requested',
    });
    await new Promise(r => setTimeout(r, 10));

    const dk = buildDispatchKey('linear', 'APP-3');
    const row = await getDispatchByDispatchKey(db, dk);
    expect(row?.status).toBe('cancelled');
    expect(row?.last_error).toBe('user_requested');
    expect(orch.internalState.completed.has(dk)).toBe(true);
    expect(orch.internalState.running.has(dk)).toBe(false);
    expect(orch.getRetry(dk)).toBeUndefined();

    await orch.stop();
  });

  test('terminal events for unrelated runIds are ignored (no Symphony mapping)', async () => {
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
    emitter.emit({
      type: 'workflow_completed',
      runId: 'wfr-not-symphony',
      workflowName: 'something-else',
      duration: 1,
    });
    await new Promise(r => setTimeout(r, 10));

    expect(orch.internalState.running.size).toBe(0);
    expect(orch.internalState.completed.size).toBe(0);
    await orch.stop();
  });

  test('requestCancel triggers upstream cancelWorkflowRun and the cancellation event lands', async () => {
    const issue = makeIssue({ id: 'l-4', identifier: 'APP-4', state: 'Todo' });
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
    const runId = await tickAndGetRunId(orch, 'APP-4');

    const result = orch.requestCancel(buildDispatchKey('linear', 'APP-4'));
    expect(result.ok).toBe(true);
    // Allow the upstream cancel + DB update to settle
    await new Promise(r => setTimeout(r, 10));

    // The fake store sets the run to 'cancelled' (so getWorkflowRunStatus
    // would return that). The orchestrator's mutation only happens when the
    // emitter fires — synthesize that event manually to mirror prod.
    emitter.emit({
      type: 'workflow_cancelled',
      runId,
      nodeId: 'n0',
      reason: 'cancel_requested',
    });
    await new Promise(r => setTimeout(r, 10));

    const dk = buildDispatchKey('linear', 'APP-4');
    const row = await getDispatchByDispatchKey(db, dk);
    expect(row?.status).toBe('cancelled');

    await orch.stop();
  });
});
