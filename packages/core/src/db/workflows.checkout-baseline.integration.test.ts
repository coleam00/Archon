/**
 * Integration test: the run checkout baseline against a REAL bun:sqlite database
 * (#3305). SQLite stores the observation as JSON TEXT; the write must be write-once in
 * the store itself, and reads must hand back the typed observation.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { CheckoutObservation } from '@archon/workflows/schemas/checkout-observation';

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

const { getWorkflowRun, recordWorkflowRunCheckoutBaseline } = await import('./workflows');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);
for (const id of ['run-1', 'run-legacy', 'run-corrupt']) {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs (id, workflow_name, conversation_id, user_message)
     VALUES ($1, 'implement', 'conv-1', 'msg')`,
    [id]
  );
}
await db.query(
  `UPDATE remote_agent_workflow_runs SET checkout_baseline = '{not json' WHERE id = 'run-corrupt'`,
  []
);

const first: CheckoutObservation = {
  kind: 'git',
  sampledAt: '2026-09-23T10:00:00.000Z',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  worktree: { status: 'clean' },
  cutFromCommit: 'c'.repeat(40),
};
const later: CheckoutObservation = { kind: 'not_git', sampledAt: '2026-09-23T11:00:00.000Z' };

describe('run checkout baseline persistence', () => {
  test('the first recorded baseline sticks and is read back typed', async () => {
    expect(await recordWorkflowRunCheckoutBaseline('run-1', first)).toEqual(first);
    // A later writer (a retry, a racing process) gets the original back, unchanged.
    expect(await recordWorkflowRunCheckoutBaseline('run-1', later)).toEqual(first);
    expect((await getWorkflowRun('run-1'))?.checkout_baseline).toEqual(first);
  });

  test('a run that never recorded one reads as not recorded', async () => {
    expect((await getWorkflowRun('run-legacy'))?.checkout_baseline).toBeNull();
  });

  test('a stored value this build cannot read is not recorded, not an untyped object', async () => {
    expect((await getWorkflowRun('run-corrupt'))?.checkout_baseline).toBeNull();
  });

  test('recording for a missing run fails', async () => {
    await expect(recordWorkflowRunCheckoutBaseline('run-missing', first)).rejects.toThrow(
      'Workflow run not found'
    );
  });
});
