// @archon-test-isolated
/**
 * Every SQL terminal writer walks the run's artifacts before its write transaction, so the
 * SQLite write lock covers database work only, and the persisted manifest is bounded.
 *
 * Runs in its own `bun test` invocation: it mock.module's ./connection with a real adapter.
 */
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { getTerminalRecord } from '@archon/workflows/terminal-record';

const home = await realpath(await mkdtemp(join(tmpdir(), 'archon-terminal-walk-')));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = home;
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(home);
});

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');
const realConnection = await import('./connection');
mock.module('./connection', () => ({
  ...realConnection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const {
  completeWorkflowRun,
  failWorkflowRun,
  cancelWorkflowRun,
  cancelFanOutRun,
  cancelResumableRunsForConversation,
  resolveAndCancelApprovalGate,
} = await import('./workflows');

const outputRoot = join(home, 'workspaces', 'owner', 'repo');
const approval = { approval: { nodeId: 'review', message: 'Approve?', type: 'approval' } };

const writers = {
  complete: {
    status: 'running',
    write: (id: string) => completeWorkflowRun(id, { duration_ms: 1 }),
  },
  fail: { status: 'running', write: (id: string) => failWorkflowRun(id, 'boom') },
  cancel: { status: 'running', write: (id: string) => cancelWorkflowRun(id) },
  'fan-out': { status: 'running', write: (id: string) => cancelFanOutRun(id, 'fan_out_sibling') },
  reject: {
    status: 'paused',
    write: (id: string) => resolveAndCancelApprovalGate(id, [], { step_name: 'review' }),
  },
  reset: { status: 'paused', write: (id: string) => cancelResumableRunsForConversation(id) },
} as const;

async function seedRun(id: string, status: string): Promise<void> {
  // Each run gets its own conversation so a reset cancels exactly that run.
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'web', $1)`,
    [id]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, metadata, output_root)
     VALUES ($1, 'implement', $1, 'msg', $2, $3, $4)`,
    [id, status, JSON.stringify(status === 'paused' ? approval : {}), outputRoot]
  );
  const artifacts = getRunArtifactsDirForRoot(outputRoot, id);
  await mkdir(join(artifacts, 'evidence', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(artifacts, 'report.md'), 'report');
  await writeFile(join(artifacts, 'evidence', 'node_modules', 'pkg', 'index.js'), '');
}

describe('terminal writers walk artifacts outside the write transaction', () => {
  test.each(Object.keys(writers) as (keyof typeof writers)[])('%s', async name => {
    const { status, write } = writers[name];
    const id = `walk-${name}`;
    await seedRun(id, status);

    let inTransaction = false;
    const walks: boolean[] = [];
    const withTransaction = db.withTransaction.bind(db);
    const transactionSpy = spyOn(db, 'withTransaction').mockImplementation(async fn =>
      withTransaction(async query => {
        inTransaction = true;
        try {
          return await fn(query);
        } finally {
          inTransaction = false;
        }
      })
    );
    const readdir = fsPromises.readdir;
    const lstat = fsPromises.lstat;
    const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(((...args: unknown[]) => {
      walks.push(inTransaction);
      return (readdir as (...a: unknown[]) => unknown)(...args);
    }) as typeof readdir);
    const lstatSpy = spyOn(fsPromises, 'lstat').mockImplementation(((...args: unknown[]) => {
      walks.push(inTransaction);
      return (lstat as (...a: unknown[]) => unknown)(...args);
    }) as typeof lstat);
    try {
      await write(id);
    } finally {
      transactionSpy.mockRestore();
      readdirSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    expect(walks.length).toBeGreaterThan(0);
    expect(walks.filter(Boolean)).toEqual([]);

    const runStatus = name === 'complete' ? 'completed' : name === 'fail' ? 'failed' : 'cancelled';
    const events = await db.query<{ event_type: string; data: unknown }>(
      'SELECT event_type, data FROM remote_agent_workflow_events WHERE workflow_run_id = $1',
      [id]
    );
    const artifacts = getTerminalRecord(runStatus, events.rows)?.artifacts;
    expect(artifacts?.files.map(file => file.path)).toEqual(['report.md']);
    expect(artifacts?.limitations).toEqual([
      { path: 'evidence/node_modules', kind: 'unsupported_entry', code: 'excluded_directory' },
    ]);
  });
});
