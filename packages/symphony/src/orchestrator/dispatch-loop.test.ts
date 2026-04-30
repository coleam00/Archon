import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import { makeFakeBridge, makeFakeWorkflowDefinition, type FakeBridge } from '../test/fake-bridge';
import { getDispatchByDispatchKey } from '../db/dispatches';
import { buildDispatchKey } from './state';

function buildLinearOnlySnapshot(env: NodeJS.ProcessEnv = { K: 'tok' }): ConfigSnapshot {
  return buildSnapshot(
    {
      trackers: [
        {
          kind: 'linear',
          api_key: '$K',
          project_slug: 'sandbox',
          repository: 'Ddell12/archon-symphony-smoke-test',
          active_states: ['Todo', 'In Progress'],
          terminal_states: ['Done', 'Canceled'],
        },
      ],
      dispatch: { max_concurrent: 5 },
      polling: { interval_ms: 30_000 },
      state_workflow_map: {
        Todo: 'archon-feature-development',
        'In Progress': 'archon-continue',
      },
      codebases: [
        {
          tracker: 'linear',
          repository: 'Ddell12/archon-symphony-smoke-test',
          codebase_id: 'cb-l',
        },
      ],
    },
    env
  );
}

let dbPath = '';
let db: SqliteAdapter;
let fakeBridge: FakeBridge;

describe('orchestrator dispatch loop', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-disploop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    // FK seed: symphony_dispatches.codebase_id needs a real codebase row.
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['cb-l', 'Linear codebase', '/tmp/cb-l']
    );
    const codebases = new Map([
      ['cb-l', { id: 'cb-l', name: 'Linear codebase', default_cwd: '/tmp/cb-l' }],
    ]);
    fakeBridge = makeFakeBridge({
      db,
      codebases,
      workflows: {
        'archon-feature-development': makeFakeWorkflowDefinition('archon-feature-development'),
        'archon-continue': makeFakeWorkflowDefinition('archon-continue'),
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

  test('runTick dispatches eligible Linear issues exactly once', async () => {
    const snapshot = buildLinearOnlySnapshot();
    const issueA = makeIssue({ id: 'lin-a', identifier: 'APP-1', state: 'Todo' });
    const issueB = makeIssue({ id: 'lin-b', identifier: 'APP-2', state: 'In Progress' });
    const { tracker } = makeFakeTracker([issueA, issueB]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      // never auto-reschedule — we drive ticks manually so the test stays
      // deterministic and we don't burn into the next polling interval.
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();

    const rowA = await getDispatchByDispatchKey(db, buildDispatchKey('linear', 'APP-1'));
    const rowB = await getDispatchByDispatchKey(db, buildDispatchKey('linear', 'APP-2'));
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    expect(rowA?.workflow_run_id).toBeTruthy();
    expect(rowA?.workflow_name).toBe('archon-feature-development');
    expect(rowB?.workflow_name).toBe('archon-continue');
    expect(rowA?.status).toBe('running');
    expect(rowB?.status).toBe('running');

    // Both ended up in `running` (with workflow_run_id) — terminal events
    // would later move them to `completed`.
    expect(orch.internalState.running.has(buildDispatchKey('linear', 'APP-1'))).toBe(true);
    expect(orch.internalState.running.has(buildDispatchKey('linear', 'APP-2'))).toBe(true);
    expect(orch.internalState.completed.size).toBe(0);
    expect(fakeBridge.runs.length).toBe(2);
  });

  test('next tick does not re-dispatch already-running dispatch_keys', async () => {
    const snapshot = buildLinearOnlySnapshot();
    const issue = makeIssue({ id: 'lin-x', identifier: 'APP-X', state: 'Todo' });
    const { tracker, controls } = makeFakeTracker([issue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();
    const dispatchKey = buildDispatchKey('linear', 'APP-X');
    const rowAfterFirst = await getDispatchByDispatchKey(db, dispatchKey);
    expect(rowAfterFirst).not.toBeNull();
    const firstCallCount = controls.candidateCalls;

    await orch.runTick();
    expect(controls.candidateCalls).toBeGreaterThan(firstCallCount);
    // Still exactly one dispatch row — the eligibility "running" gate
    // prevented a second insert (which would have hit the UNIQUE constraint
    // and surfaced as a dispatch_db_conflict log line).
    const all = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM symphony_dispatches WHERE dispatch_key = $1',
      [dispatchKey]
    );
    expect(all.rows[0]?.count).toBe(1);
    expect(fakeBridge.runs.length).toBe(1);
  });

  test('skips dispatch when state has no workflow mapping', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$K',
            project_slug: 'sandbox',
            repository: 'Ddell12/archon-symphony-smoke-test',
            active_states: ['Todo'],
            terminal_states: ['Done'],
          },
        ],
        dispatch: { max_concurrent: 5 },
        polling: { interval_ms: 30_000 },
        state_workflow_map: {}, // empty — no mapping
        codebases: [
          {
            tracker: 'linear',
            repository: 'Ddell12/archon-symphony-smoke-test',
            codebase_id: 'cb-l',
          },
        ],
      },
      { K: 'tok' } as NodeJS.ProcessEnv
    );
    const issue = makeIssue({ id: 'lin-no', identifier: 'APP-NO', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();

    const row = await getDispatchByDispatchKey(db, buildDispatchKey('linear', 'APP-NO'));
    expect(row).toBeNull();
    // Dispatcher returned `failed_no_workflow` BEFORE inserting any row, so
    // the orchestrator marks the key completed (no retry — config error).
    expect(orch.internalState.completed.has(buildDispatchKey('linear', 'APP-NO'))).toBe(true);
    expect(orch.internalState.claimed.has(buildDispatchKey('linear', 'APP-NO'))).toBe(false);
    expect(orch.internalState.running.has(buildDispatchKey('linear', 'APP-NO'))).toBe(false);
    expect(fakeBridge.runs.length).toBe(0);
  });

  test('hard-fails dispatch when codebase is not mapped (writes failed row)', async () => {
    // No codebase mapping for the linear tracker → orchestrator passes
    // codebaseId=null → dispatcher writes a failed row, no run.
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$K',
            project_slug: 'sandbox',
            repository: 'Ddell12/archon-symphony-smoke-test',
            active_states: ['Todo'],
            terminal_states: ['Done'],
          },
        ],
        dispatch: { max_concurrent: 5 },
        polling: { interval_ms: 30_000 },
        state_workflow_map: { Todo: 'archon-feature-development' },
        codebases: [],
      },
      { K: 'tok' } as NodeJS.ProcessEnv
    );
    const issue = makeIssue({ id: 'lin-c', identifier: 'APP-C', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();

    const dispatchKey = buildDispatchKey('linear', 'APP-C');
    const row = await getDispatchByDispatchKey(db, dispatchKey);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.codebase_id).toBeNull();
    expect(row?.workflow_run_id).toBeNull();
    expect(row?.last_error).toContain('no codebase mapped');
    expect(orch.internalState.completed.has(dispatchKey)).toBe(true);
    expect(fakeBridge.runs.length).toBe(0);
  });
});
