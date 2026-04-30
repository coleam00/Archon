import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
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
      codebases: [],
    },
    env
  );
}

let dbPath = '';
let db: SqliteAdapter;

describe('orchestrator dispatch loop (Phase 2 stub)', () => {
  beforeEach(() => {
    dbPath = join(
      import.meta.dir,
      `.test-disploop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
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
    expect(rowA?.workflow_run_id).toBeNull();
    expect(rowA?.workflow_name).toBe('archon-feature-development');
    expect(rowB?.workflow_name).toBe('archon-continue');
    expect(rowA?.status).toBe('pending');

    expect(orch.internalState.completed.has(buildDispatchKey('linear', 'APP-1'))).toBe(true);
    expect(orch.internalState.completed.has(buildDispatchKey('linear', 'APP-2'))).toBe(true);
    expect(orch.internalState.running.size).toBe(0);
  });

  test('next tick does not re-dispatch already-completed dispatch_keys', async () => {
    const snapshot = buildLinearOnlySnapshot();
    const issue = makeIssue({ id: 'lin-x', identifier: 'APP-X', state: 'Todo' });
    const { tracker, controls } = makeFakeTracker([issue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
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
    // Still exactly one dispatch row — the eligibility "completed" gate
    // prevented a second insert (which would have hit the UNIQUE constraint
    // and surfaced as a dispatch_db_conflict log line).
    const all = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM symphony_dispatches WHERE dispatch_key = $1',
      [dispatchKey]
    );
    expect(all.rows[0]?.count).toBe(1);
  });

  test('skips dispatch when state has no workflow mapping', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$K',
            project_slug: 'sandbox',
            active_states: ['Todo'],
            terminal_states: ['Done'],
          },
        ],
        dispatch: { max_concurrent: 5 },
        polling: { interval_ms: 30_000 },
        state_workflow_map: {}, // empty — no mapping
        codebases: [],
      },
      { K: 'tok' } as NodeJS.ProcessEnv
    );
    const issue = makeIssue({ id: 'lin-no', identifier: 'APP-NO', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: { linear: tracker },
      getDb: () => db,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();

    const row = await getDispatchByDispatchKey(db, buildDispatchKey('linear', 'APP-NO'));
    expect(row).toBeNull();
    // Not added to completed either — a config fix could make it eligible.
    expect(orch.internalState.completed.has(buildDispatchKey('linear', 'APP-NO'))).toBe(false);
    expect(orch.internalState.claimed.has(buildDispatchKey('linear', 'APP-NO'))).toBe(false);
  });
});
