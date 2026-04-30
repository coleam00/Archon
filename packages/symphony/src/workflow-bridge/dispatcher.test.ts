import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { dispatchToWorkflow } from './dispatcher';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeIssue } from '../test/fake-tracker';
import { makeFakeBridge, makeFakeWorkflowDefinition, type FakeBridge } from '../test/fake-bridge';
import { getDispatchByDispatchKey } from '../db/dispatches';

let dbPath = '';
let db: SqliteAdapter;
let fakeBridge: FakeBridge;

function buildSnap(): ConfigSnapshot {
  return buildSnapshot(
    {
      trackers: [
        {
          kind: 'github',
          token: '$GH',
          owner: 'Ddell12',
          repo: 'archon-symphony',
          active_states: ['open'],
          terminal_states: ['closed'],
        },
      ],
      dispatch: { max_concurrent: 5 },
      polling: { interval_ms: 30_000 },
      state_workflow_map: {
        open: 'archon-feature-development',
      },
      codebases: [
        {
          tracker: 'github',
          repository: 'Ddell12/archon-symphony',
          codebase_id: 'cb-gh',
        },
      ],
    },
    { GH: 'g' } as NodeJS.ProcessEnv
  );
}

describe('dispatchToWorkflow', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['cb-gh', 'GitHub codebase', '/tmp/cb-gh']
    );
    fakeBridge = makeFakeBridge({
      db,
      codebases: new Map([
        ['cb-gh', { id: 'cb-gh', name: 'GitHub codebase', default_cwd: '/tmp/cb-gh' }],
      ]),
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

  test('launches when codebase + workflow + isolation are all valid', async () => {
    const snap = buildSnap();
    const issue = makeIssue({
      id: 'g-1',
      identifier: 'Ddell12/archon-symphony#7',
      state: 'open',
    });
    const outcome = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 1,
      codebaseId: 'cb-gh',
      abort: new AbortController(),
    });
    expect(outcome.status).toBe('launched');
    expect(outcome.workflowRunId).toBeTruthy();
    expect(outcome.dispatchId).toBeTruthy();

    const row = await getDispatchByDispatchKey(db, 'github:Ddell12/archon-symphony#7');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('running');
    expect(row?.workflow_run_id).toBe(outcome.workflowRunId ?? '');
    expect(row?.codebase_id).toBe('cb-gh');
    expect(row?.workflow_name).toBe('archon-feature-development');

    expect(fakeBridge.runs.length).toBe(1);
    const run = fakeBridge.runs[0];
    expect(run?.input.cwd).toBe('/tmp/cb-gh/.archon/wt');
    expect(run?.input.workerPlatformId).toMatch(/^symphony-github-/);
    expect(run?.input.preCreatedRunId).toBe(outcome.workflowRunId ?? '');
    expect(run?.input.codebaseId).toBe('cb-gh');

    expect(fakeBridge.platform.dbIds.has(run?.input.workerPlatformId ?? '')).toBe(true);
  });

  test('hard-fails with failed_no_codebase when codebaseId is null', async () => {
    const snap = buildSnap();
    const issue = makeIssue({
      id: 'g-2',
      identifier: 'Ddell12/archon-symphony#8',
      state: 'open',
    });
    const outcome = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 1,
      codebaseId: null,
      abort: new AbortController(),
    });
    expect(outcome.status).toBe('failed_no_codebase');
    expect(outcome.reason).toContain('no codebase mapped');

    const row = await getDispatchByDispatchKey(db, 'github:Ddell12/archon-symphony#8');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('failed');
    expect(row?.codebase_id).toBeNull();
    expect(row?.workflow_run_id).toBeNull();
    expect(row?.last_error).toContain('no codebase mapped');
    expect(fakeBridge.runs.length).toBe(0);
  });

  test('failed_no_workflow when state is unmapped — no DB row, no run', async () => {
    const snap = buildSnap();
    const issue = makeIssue({
      id: 'g-3',
      identifier: 'Ddell12/archon-symphony#9',
      state: 'closed', // not in state_workflow_map
    });
    const outcome = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 1,
      codebaseId: 'cb-gh',
      abort: new AbortController(),
    });
    expect(outcome.status).toBe('failed_no_workflow');
    const row = await getDispatchByDispatchKey(db, 'github:Ddell12/archon-symphony#9');
    expect(row).toBeNull();
    expect(fakeBridge.runs.length).toBe(0);
  });

  test('failed_no_workflow when workflow definition is missing — writes failed row', async () => {
    const snap = buildSnap();
    fakeBridge.setResolveWorkflow(async () => null);
    const issue = makeIssue({
      id: 'g-4',
      identifier: 'Ddell12/archon-symphony#10',
      state: 'open',
    });
    const outcome = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 1,
      codebaseId: 'cb-gh',
      abort: new AbortController(),
    });
    expect(outcome.status).toBe('failed_no_workflow');
    const row = await getDispatchByDispatchKey(db, 'github:Ddell12/archon-symphony#10');
    expect(row?.status).toBe('failed');
    expect(row?.workflow_run_id).toBeNull();
    expect(row?.last_error).toContain('not found');
  });

  test('failed_db_conflict when dispatch_key already exists', async () => {
    const snap = buildSnap();
    const issue = makeIssue({
      id: 'g-5',
      identifier: 'Ddell12/archon-symphony#11',
      state: 'open',
    });
    const first = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 1,
      codebaseId: 'cb-gh',
      abort: new AbortController(),
    });
    expect(first.status).toBe('launched');

    const second = await dispatchToWorkflow(db, fakeBridge.bridge, {
      issue,
      trackerKind: 'github',
      snap,
      attempt: 2,
      codebaseId: 'cb-gh',
      abort: new AbortController(),
    });
    expect(second.status).toBe('failed_db_conflict');
  });
});
