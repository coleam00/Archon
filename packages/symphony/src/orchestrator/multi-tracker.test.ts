import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import { makeFakeBridge, makeFakeWorkflowDefinition, type FakeBridge } from '../test/fake-bridge';
import { getDispatchByDispatchKey } from '../db/dispatches';
import { buildDispatchKey } from './state';

let dbPath = '';
let db: SqliteAdapter;
let fakeBridge: FakeBridge;

async function seedCodebase(id: string, name: string): Promise<void> {
  await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
    id,
    name,
    `/tmp/${id}`,
  ]);
}

describe('multi-tracker dispatch (Linear + GitHub, same raw issue id)', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-multi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    // The symphony_dispatches.codebase_id FK requires real rows.
    await seedCodebase('cb-l', 'Linear codebase');
    await seedCodebase('cb-gh', 'GitHub codebase');
    const codebases = new Map([
      ['cb-l', { id: 'cb-l', name: 'Linear codebase', default_cwd: '/tmp/cb-l' }],
      ['cb-gh', { id: 'cb-gh', name: 'GitHub codebase', default_cwd: '/tmp/cb-gh' }],
    ]);
    fakeBridge = makeFakeBridge({
      db,
      codebases,
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

  test('two trackers with same raw issue id dispatch under distinct dispatch_keys', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$LINEAR_API_KEY',
            project_slug: 'smoke',
            repository: 'Ddell12/archon-symphony-smoke-test',
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
        codebases: [
          {
            tracker: 'linear',
            repository: 'Ddell12/archon-symphony-smoke-test',
            codebase_id: 'cb-l',
          },
          {
            tracker: 'github',
            repository: 'Ddell12/archon-symphony',
            codebase_id: 'cb-gh',
          },
        ],
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
      bridge: fakeBridge.bridge,
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
    expect(linearRow?.codebase_id).toBe('cb-l');
    expect(githubRow?.codebase_id).toBe('cb-gh');
    expect(linearRow?.workflow_run_id).toBeTruthy();
    expect(githubRow?.workflow_run_id).toBeTruthy();
    expect(linearRow?.status).toBe('running');
    expect(githubRow?.status).toBe('running');
    // Both share the raw issue id; only the dispatch_key disambiguates.
    expect(linearRow?.issue_id).toBe('shared-1');
    expect(githubRow?.issue_id).toBe('shared-1');

    // Slot accounting unifies across trackers: both consumed slots and ended
    // up in the running set with their workflow_run_ids tracked.
    expect(orch.internalState.running.has(linearKey)).toBe(true);
    expect(orch.internalState.running.has(githubKey)).toBe(true);
    expect(orch.internalState.running.size).toBe(2);
    expect(fakeBridge.runs.length).toBe(2);
  });

  test('global slot cap unifies across trackers', async () => {
    const snapshot = buildSnapshot(
      {
        trackers: [
          {
            kind: 'linear',
            api_key: '$LINEAR_API_KEY',
            project_slug: 'smoke',
            repository: 'Ddell12/archon-symphony-smoke-test',
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
        codebases: [
          {
            tracker: 'linear',
            repository: 'Ddell12/archon-symphony-smoke-test',
            codebase_id: 'cb-l',
          },
          {
            tracker: 'github',
            repository: 'Ddell12/archon-symphony',
            codebase_id: 'cb-gh',
          },
        ],
      },
      { LINEAR_API_KEY: 'k', GITHUB_TOKEN: 'g' } as NodeJS.ProcessEnv
    );

    // With max_concurrent=1, only the first candidate of one tick should
    // launch; the second waits for a slot to free.
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
      bridge: fakeBridge.bridge,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });

    await orch.runTick();
    const all = await db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM symphony_dispatches'
    );
    // Exactly one row landed under the global cap of 1. The other candidate
    // is still eligible (no claim) and would be picked up on the next tick.
    expect(all.rows[0]?.count).toBe(1);
    expect(orch.internalState.running.size).toBe(1);
  });
});
