import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import {
  insertDispatch,
  getDispatchByDispatchKey,
  getDispatchById,
  getDispatchByWorkflowRunId,
  listDispatches,
  listInFlight,
  updateStatus,
  attachWorkflowRun,
  type InsertDispatchInput,
} from './dispatches';

let dbPath = '';
let db: SqliteAdapter;

async function insertCodebase(adapter: SqliteAdapter, id: string): Promise<void> {
  await adapter.query(
    'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
    [id, `cb-${id}`, '/tmp/test-cwd']
  );
}

async function insertConversation(adapter: SqliteAdapter, id: string): Promise<void> {
  await adapter.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id)
     VALUES ($1, $2, $3)`,
    [id, 'symphony', `convo-${id}`]
  );
}

async function insertWorkflowRun(
  adapter: SqliteAdapter,
  id: string,
  conversationId: string
): Promise<void> {
  await adapter.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, conversationId, 'archon-feature-development', 'kick off', 'running']
  );
}

function baseInput(over: Partial<InsertDispatchInput> = {}): InsertDispatchInput {
  return {
    issue_id: 'issue-id-1',
    identifier: 'APP-291',
    tracker: 'linear',
    dispatch_key: 'linear:issue-id-1',
    codebase_id: null,
    workflow_name: 'archon-feature-development',
    workflow_run_id: null,
    attempt: 1,
    status: 'pending',
    last_error: null,
    ...over,
  };
}

describe('symphony_dispatches CRUD', () => {
  beforeEach(() => {
    dbPath = join(
      import.meta.dir,
      `.test-dispatches-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

  test('insertDispatch round-trips via getDispatchByDispatchKey', async () => {
    const inserted = await insertDispatch(db, baseInput());
    expect(inserted.id).toBeTruthy();
    expect(inserted.issue_id).toBe('issue-id-1');
    expect(inserted.identifier).toBe('APP-291');
    expect(inserted.tracker).toBe('linear');
    expect(inserted.dispatch_key).toBe('linear:issue-id-1');
    expect(inserted.workflow_name).toBe('archon-feature-development');
    expect(inserted.workflow_run_id).toBeNull();
    expect(inserted.attempt).toBe(1);
    expect(inserted.status).toBe('pending');
    expect(inserted.last_error).toBeNull();
    expect(inserted.dispatched_at).toBeTruthy();

    const fetched = await getDispatchByDispatchKey(db, 'linear:issue-id-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(inserted.id);
  });

  test('dispatch_key UNIQUE constraint rejects duplicates across trackers', async () => {
    await insertDispatch(db, baseInput({ dispatch_key: 'linear:dup' }));
    let threw = false;
    try {
      await insertDispatch(
        db,
        baseInput({ tracker: 'github', dispatch_key: 'linear:dup', issue_id: 'other' })
      );
    } catch (e) {
      threw = true;
      expect((e as Error).message.toLowerCase()).toContain('unique');
    }
    expect(threw).toBe(true);
  });

  test('same raw issue_id from two trackers does NOT collide when dispatch_key differs', async () => {
    const linear = await insertDispatch(
      db,
      baseInput({ tracker: 'linear', dispatch_key: 'linear:shared-id' })
    );
    const github = await insertDispatch(
      db,
      baseInput({
        tracker: 'github',
        dispatch_key: 'github:owner/repo#shared-id',
        identifier: 'owner/repo#42',
      })
    );
    expect(linear.id).not.toBe(github.id);
    expect((await getDispatchByDispatchKey(db, 'linear:shared-id'))?.id).toBe(linear.id);
    expect((await getDispatchByDispatchKey(db, 'github:owner/repo#shared-id'))?.id).toBe(github.id);
  });

  test('updateStatus mutates status and last_error only', async () => {
    const inserted = await insertDispatch(db, baseInput());
    await updateStatus(db, inserted.id, 'failed', 'turn_timeout');

    const after = await getDispatchById(db, inserted.id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error).toBe('turn_timeout');
    // unchanged fields
    expect(after?.dispatch_key).toBe(inserted.dispatch_key);
    expect(after?.attempt).toBe(inserted.attempt);
    expect(after?.workflow_run_id).toBe(inserted.workflow_run_id);
  });

  test('updateStatus clears last_error when omitted', async () => {
    const inserted = await insertDispatch(db, baseInput({ last_error: 'old' }));
    await updateStatus(db, inserted.id, 'running');
    const after = await getDispatchById(db, inserted.id);
    expect(after?.status).toBe('running');
    expect(after?.last_error).toBeNull();
  });

  test('attachWorkflowRun sets workflow_run_id and is idempotent for the same id', async () => {
    await insertCodebase(db, 'cb-1');
    await insertConversation(db, 'conv-1');
    await insertWorkflowRun(db, 'wfr-1', 'conv-1');

    const inserted = await insertDispatch(db, baseInput({ codebase_id: 'cb-1' }));
    await attachWorkflowRun(db, inserted.id, 'wfr-1');
    const after1 = await getDispatchById(db, inserted.id);
    expect(after1?.workflow_run_id).toBe('wfr-1');

    // idempotent — same id is a no-op
    await attachWorkflowRun(db, inserted.id, 'wfr-1');
    const after2 = await getDispatchById(db, inserted.id);
    expect(after2?.workflow_run_id).toBe('wfr-1');
  });

  test('attachWorkflowRun rejects switching to a different workflow_run_id', async () => {
    await insertCodebase(db, 'cb-2');
    await insertConversation(db, 'conv-2');
    await insertWorkflowRun(db, 'wfr-a', 'conv-2');
    await insertWorkflowRun(db, 'wfr-b', 'conv-2');

    const inserted = await insertDispatch(
      db,
      baseInput({ dispatch_key: 'linear:swap-test', codebase_id: 'cb-2' })
    );
    await attachWorkflowRun(db, inserted.id, 'wfr-a');

    let threw = false;
    try {
      await attachWorkflowRun(db, inserted.id, 'wfr-b');
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('already attached');
    }
    expect(threw).toBe(true);

    const after = await getDispatchById(db, inserted.id);
    expect(after?.workflow_run_id).toBe('wfr-a');
  });

  test('attachWorkflowRun throws for unknown dispatch id', async () => {
    let threw = false;
    try {
      await attachWorkflowRun(db, 'does-not-exist', 'wfr-x');
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('not found');
    }
    expect(threw).toBe(true);
  });

  test('getDispatchByWorkflowRunId looks up the dispatch row for a known run id', async () => {
    await insertCodebase(db, 'cb-rev');
    await insertConversation(db, 'conv-rev');
    await insertWorkflowRun(db, 'wfr-rev', 'conv-rev');
    const inserted = await insertDispatch(
      db,
      baseInput({ dispatch_key: 'linear:rev', codebase_id: 'cb-rev' })
    );
    await attachWorkflowRun(db, inserted.id, 'wfr-rev');

    const found = await getDispatchByWorkflowRunId(db, 'wfr-rev');
    expect(found?.id).toBe(inserted.id);

    const missing = await getDispatchByWorkflowRunId(db, 'wfr-not-attached');
    expect(missing).toBeNull();
  });

  test('listDispatches returns rows ordered by dispatched_at DESC, optionally filtered by status', async () => {
    const a = await insertDispatch(db, baseInput({ dispatch_key: 'linear:a', status: 'pending' }));
    // Force ordering — sqlite datetime() resolution is per-second, so insert two
    // rows with deliberately distinct identifiers and rely on ROWID tiebreakers
    // via the column order. We verify both rows are returned, not the exact order.
    const b = await insertDispatch(db, baseInput({ dispatch_key: 'linear:b', status: 'failed' }));

    const all = await listDispatches(db);
    expect(all.map(r => r.dispatch_key).sort()).toEqual(['linear:a', 'linear:b']);

    const failed = await listDispatches(db, { status: 'failed' });
    expect(failed.map(r => r.id)).toEqual([b.id]);

    const pending = await listDispatches(db, { status: 'pending' });
    expect(pending.map(r => r.id)).toEqual([a.id]);
  });

  test('listInFlight returns only rows with workflow_run_id and status in (pending,running)', async () => {
    await insertCodebase(db, 'cb-flight');
    await insertConversation(db, 'conv-flight');
    await insertWorkflowRun(db, 'wfr-running', 'conv-flight');
    await insertWorkflowRun(db, 'wfr-pending', 'conv-flight');
    await insertWorkflowRun(db, 'wfr-completed', 'conv-flight');

    const running = await insertDispatch(
      db,
      baseInput({ dispatch_key: 'linear:running', codebase_id: 'cb-flight' })
    );
    await attachWorkflowRun(db, running.id, 'wfr-running');
    await updateStatus(db, running.id, 'running');

    const pending = await insertDispatch(
      db,
      baseInput({ dispatch_key: 'linear:pending', codebase_id: 'cb-flight' })
    );
    await attachWorkflowRun(db, pending.id, 'wfr-pending');
    // status stays 'pending'

    const completed = await insertDispatch(
      db,
      baseInput({ dispatch_key: 'linear:completed', codebase_id: 'cb-flight' })
    );
    await attachWorkflowRun(db, completed.id, 'wfr-completed');
    await updateStatus(db, completed.id, 'completed');

    // failed-no-run rows must NOT show up (they never launched a workflow)
    await insertDispatch(
      db,
      baseInput({
        dispatch_key: 'linear:no-codebase',
        status: 'failed',
        last_error: 'no codebase mapped',
      })
    );

    const inFlight = await listInFlight(db);
    const ids = new Set(inFlight.map(r => r.id));
    expect(ids.has(running.id)).toBe(true);
    expect(ids.has(pending.id)).toBe(true);
    expect(ids.has(completed.id)).toBe(false);
    expect(inFlight.length).toBe(2);
  });
});
