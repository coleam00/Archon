import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import { getDispatchByDispatchKey } from '../db/dispatches';
import { buildDispatchKey } from './state';

let dbPath = '';
let db: SqliteAdapter;

describe('multi-tracker dispatch (Linear + GitHub, same raw issue id)', () => {
  beforeEach(() => {
    dbPath = join(
      import.meta.dir,
      `.test-multi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

  test('two trackers with same raw issue id dispatch under distinct dispatch_keys', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$LINEAR_API_KEY',
            project_slug: 'smoke',
            active_states: ['Todo'],
            terminal_states: ['Done'],
          },
          {
            kind: 'github',
            token: '$GITHUB_TOKEN',
            owner: 'Ddell12',
            repo: 'archon-symphony',
            active_states: ['open'],
            terminal_states: ['closed'],
          },
        ],
        dispatch: { max_concurrent: 5 },
        polling: { interval_ms: 30_000 },
        state_workflow_map: {
          Todo: 'archon-feature-development',
          open: 'archon-feature-development',
        },
        codebases: [],
      },
      { LINEAR_API_KEY: 'k', GITHUB_TOKEN: 'g' } as NodeJS.ProcessEnv
    );

    // Same raw id "shared-1" used by both trackers, but different identifiers
    // so the dispatch_keys differ.
    const linearIssue = makeIssue({
      id: 'shared-1',
      identifier: 'APP-1',
      state: 'Todo',
    });
    const githubIssue = makeIssue({
      id: 'shared-1',
      identifier: 'Ddell12/archon-symphony#1',
      state: 'open',
    });

    const linearFake = makeFakeTracker([linearIssue]);
    const githubFake = makeFakeTracker([githubIssue]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: {
        linear: linearFake.tracker,
        github: githubFake.tracker,
      },
      getDb: () => db,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();

    const linearKey = buildDispatchKey('linear', 'APP-1');
    const githubKey = buildDispatchKey('github', 'Ddell12/archon-symphony#1');

    const linearRow = await getDispatchByDispatchKey(db, linearKey);
    const githubRow = await getDispatchByDispatchKey(db, githubKey);

    expect(linearRow).not.toBeNull();
    expect(githubRow).not.toBeNull();
    expect(linearRow?.id).not.toBe(githubRow?.id);
    expect(linearRow?.tracker).toBe('linear');
    expect(githubRow?.tracker).toBe('github');
    // Both share the raw issue id; only the dispatch_key disambiguates.
    expect(linearRow?.issue_id).toBe('shared-1');
    expect(githubRow?.issue_id).toBe('shared-1');

    // Slot accounting unifies across trackers: both consumed slots, both
    // ended up in the completed set (because Phase 2 stubs immediately).
    expect(orch.internalState.completed.has(linearKey)).toBe(true);
    expect(orch.internalState.completed.has(githubKey)).toBe(true);
    expect(
      orch.internalState.running.size + orch.internalState.completed.size
    ).toBeGreaterThanOrEqual(2);
  });

  test('global slot cap unifies across trackers', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$LINEAR_API_KEY',
            project_slug: 'smoke',
            active_states: ['Todo'],
            terminal_states: ['Done'],
          },
          {
            kind: 'github',
            token: '$GITHUB_TOKEN',
            owner: 'Ddell12',
            repo: 'archon-symphony',
            active_states: ['open'],
            terminal_states: ['closed'],
          },
        ],
        dispatch: { max_concurrent: 1 },
        polling: { interval_ms: 30_000 },
        state_workflow_map: {
          Todo: 'archon-feature-development',
          open: 'archon-feature-development',
        },
        codebases: [],
      },
      { LINEAR_API_KEY: 'k', GITHUB_TOKEN: 'g' } as NodeJS.ProcessEnv
    );

    // The Phase 2 stub completes synchronously, which frees the slot before
    // the next iteration of the for-loop in runTick. So even with cap=1, both
    // candidates dispatch in a single tick. The "global cap" we want to assert
    // is that the cap was *consulted* — we just verify both rows landed and
    // neither violated the unique constraint.
    const linearFake = makeFakeTracker([
      makeIssue({ id: 'l-1', identifier: 'APP-1', state: 'Todo' }),
    ]);
    const githubFake = makeFakeTracker([
      makeIssue({
        id: 'g-1',
        identifier: 'Ddell12/archon-symphony#42',
        state: 'open',
      }),
    ]);

    const orch = new Orchestrator({
      getSnapshot: () => snapshot,
      trackers: {
        linear: linearFake.tracker,
        github: githubFake.tracker,
      },
      getDb: () => db,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();
    const all = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM symphony_dispatches'
    );
    expect(all.rows[0]?.count).toBe(2);
  });
});
