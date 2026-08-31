/**
 * Integration test: workflow-run adoption cutoff against a REAL bun:sqlite
 * database (#2845).
 *
 * SQLite stores `started_at` as TEXT (UTC "YYYY-MM-DD HH:MM:SS") but the
 * `WorkflowRun` type declares it a `Date`. While normalization only parsed
 * metadata, `getWorkflowRun()` handed that raw STRING to
 * `findLatestByCodebaseAndWorkingPath()`, whose cutoff calls `.toISOString()` —
 * adoption crashed with `createdBefore.toISOString is not a function` before any
 * worktree selection or run creation. The mock-based tests on both sides of this
 * boundary fabricate `Date` values throughout, so only a REAL adapter composing
 * getWorkflowRun → isolation lookup can catch it.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter.
 */
import { describe, test, expect, mock } from 'bun:test';
import { toBranchName } from '@archon/git';

// The adapter's logger is lazy but `@archon/git` (pulled in by
// workflow-adoption) statically imports path helpers from '@archon/paths' too,
// so the mock must merge over the REAL module rather than replace it.
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { getWorkflowRun } = await import('./workflows');
const { findLatestByCodebaseAndWorkingPath } = await import('./isolation-environments');
const { resolveWorkflowAdoption } = await import('../operations/workflow-adoption');

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'ops-client', '/tmp/ops-client', 'repo')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

// Insert the terminal run EXACTLY as SQLite writes it: started_at as UTC TEXT
// via the same shape datetime('now') produces, not an ISO string and not a Date.
await db.query(
  `INSERT INTO remote_agent_workflow_runs
     (id, workflow_name, conversation_id, codebase_id, user_message, status, metadata,
      working_path, started_at, completed_at, last_activity_at)
   VALUES ('run-1', 'implement', 'conv-1', 'cb-1', 'correct pr', 'failed', '{}',
     '/tmp/ops-client/.worktrees/run-1', '2026-08-27 07:01:38', '2026-08-27 07:20:00',
     '2026-08-27 07:20:00')`,
  []
);

/** Seed an estate at the adopted run's working_path with its own cutoff relation. */
async function seedEnv(id: string, createdAt: string, status: 'active' | 'destroyed') {
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status, created_at)
     VALUES ($1, 'cb-1', 'task', $2, 'worktree',
       '/tmp/ops-client/.worktrees/run-1', $3, $4, $5)`,
    [id, `wf-${id}`, `impl-${id}`, status, createdAt]
  );
}

// Two estates around the run's start: the one that OWNED the checkout before the
// run began (now destroyed — cleanup removed the worktree but the row survives),
// and a later re-creation after the run had finished. Only the pre-cutoff row may
// be selected as the adoption source.
await seedEnv('env-before', '2026-08-26 09:00:00', 'destroyed');
await seedEnv('env-after', '2026-08-28 10:00:00', 'active');

describe('workflow-run adoption timestamp — real SQLite composition (#2845)', () => {
  test('getWorkflowRun hydrates SQLite TEXT timestamps into Dates', async () => {
    const run = await getWorkflowRun('run-1');
    expect(run).not.toBeNull();
    expect(run?.started_at).toBeInstanceOf(Date);
    expect(run?.started_at).toEqual(new Date('2026-08-27T07:01:38.000Z'));
    expect(run?.completed_at).toEqual(new Date('2026-08-27T07:20:00.000Z'));
  });

  test('the run’s own started_at drives the estate lookup without crashing', async () => {
    const run = await getWorkflowRun('run-1');
    expect(run?.started_at).toBeInstanceOf(Date);
    // Before the #2845 correction `started_at` was still SQLite TEXT here and
    // this call threw `createdBefore.toISOString is not a function`.
    const env = await findLatestByCodebaseAndWorkingPath(
      'cb-1',
      '/tmp/ops-client/.worktrees/run-1',
      run!.started_at
    );
    expect(env?.id).toBe('env-before');
    expect(env?.branch_name).toBe('impl-env-before');
  });

  test('adoption resolves the surviving branch from the pre-cutoff estate', async () => {
    const resolved = await resolveWorkflowAdoption({
      adoptedRunId: 'run-1',
      codebaseId: 'cb-1',
      codebasePath: '/tmp/ops-client',
      codebaseKind: 'repo',
      deps: {
        // Worktree gone; only the historical branch survives on disk.
        existsSync: () => false,
        branchExists: async (_repoPath, branch) => branch === 'impl-env-before',
      },
    });
    expect(resolved.adoptedRun.id).toBe('run-1');
    expect(resolved.lane.kind).toBe('checkout-branch');
    if (resolved.lane.kind === 'checkout-branch') {
      expect(resolved.lane.taskBranch.branch).toBe(toBranchName('impl-env-before'));
    }
  });

  test('a cutoff before every estate returns nothing to adopt', async () => {
    const env = await findLatestByCodebaseAndWorkingPath(
      'cb-1',
      '/tmp/ops-client/.worktrees/run-1',
      new Date(Date.UTC(2026, 7, 25))
    );
    expect(env).toBeNull();
  });
});
