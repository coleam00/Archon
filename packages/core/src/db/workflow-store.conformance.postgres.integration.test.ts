// @archon-test-isolated
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resourceStartFixtures } from '@archon/workflows/store-conformance';
import { WorkflowRunDeleteRefusedError, executionClaim } from '@archon/workflows/store';
import { workflowPathPriorityTime } from '@archon/workflows/workflow-path-lock';
import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CONVERSATION_ID,
  CONFORMANCE_CODEBASE_ID,
} from '@archon/workflows/store-conformance';
import {
  makeSqlConformanceHarness,
  describeSqlStatusReadConformance,
} from './workflow-store.conformance-harness';
import { describeItemLandingConformance } from './item-landings.conformance-harness';
import { describeItemLinkConformance } from './item-links.conformance-harness';
import {
  describeLinkedStartConformance,
  link,
  reviews,
  WAIT,
} from './linked-starts.conformance-harness';
import { describeSqlItemAskStartConformance } from './item-ask-starts.conformance';
import { describeSqlItemAskConformance } from './item-asks.conformance';
import { describeSqlRunDeleteConformance } from './workflow-run-delete.conformance';
import {
  HEAD,
  accept,
  checks,
  completeWithWaits,
  describeSqlItemWaitConformance,
  projectKey,
  readReceipt,
  wakeReceipt,
} from './item-waits.conformance';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { getSchemaSQL } from './bundled-schema';
import type { ItemAsk } from '@archon/workflows/schemas/item-ask';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
describe.skipIf(!baseUrl)('scratch PostgreSQL', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: baseUrl });
  });
  afterAll(async () => {
    await admin?.end();
  });
  const makeHarness = async () => {
    const name = `archon_conformance_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${name}`;
    const db = new PostgresAdapter(url.toString());
    const close = async () => {
      try {
        await db.close();
      } finally {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    };
    try {
      const harness = await makeSqlConformanceHarness(db, postgresDialect, 'postgresql', close);
      return { ...harness, db, url: url.toString() };
    } catch (error) {
      await close();
      throw error;
    }
  };
  describeWorkflowStoreConformance('PostgreSQL', makeHarness);
  test.each(['initial', 'resumed', 'recovered', 'legacy-writer'] as const)(
    '%s preserves an admitted holder across submillisecond arrivals in either id order',
    async mode => {
      const harness = await makeHarness();
      try {
        const { db, store } = harness;
        const activate = async (id: string) => {
          await store.claimPendingWorkflowRun(id);
          if (mode === 'resumed') {
            await store.failWorkflowRun(id, 'retry');
            await store.resumeWorkflowRun(id);
          } else if (mode === 'recovered') {
            await store.cancelFanOutRun(id, 'fan_out_orphan');
            await store.recoverCancelledFanOutRun(id);
          }
        };
        const setPriority = async (id: string, fraction: string) => {
          const priority = `2021-01-01T00:00:00.${fraction}Z`;
          const phaseOwnsPriority = mode === 'resumed' || mode === 'recovered';
          await db.query(
            'UPDATE remote_agent_workflow_runs SET started_at = $2, active_phase_started_at = $3 WHERE id = $1',
            [
              id,
              phaseOwnsPriority ? '2020-01-01T00:00:00Z' : priority,
              phaseOwnsPriority
                ? priority
                : mode === 'legacy-writer'
                  ? '2020-01-01T00:00:00Z'
                  : null,
            ]
          );
        };
        const blocker = async (id: string, path: string) => {
          const hydrated = await store.getWorkflowRun(id);
          if (!hydrated) throw new Error('Missing priority fixture');
          return store.getActiveWorkflowRunByPath(path, {
            id,
            startedAt: workflowPathPriorityTime(hydrated),
          });
        };
        for (const holderFirst of [false, true]) {
          const path = `/submillisecond-priority/${holderFirst}`;
          const firstId = randomUUID();
          const secondId = randomUUID();
          const ascending = firstId < secondId;
          const [holderId, contenderId] =
            ascending === holderFirst
              ? ([firstId, secondId] as const)
              : ([secondId, firstId] as const);
          const create = (id: string) =>
            store.createWorkflowRun({
              id,
              workflow_name: 'priority',
              user_message: '',
              working_path: path,
            });
          const holder = await create(holderId);
          await activate(holder.id);
          await setPriority(holder.id, '123100');
          expect(await blocker(holder.id, path)).toBeNull();

          const contender = await create(contenderId);
          await activate(contender.id);
          await setPriority(contender.id, '123900');
          expect((await blocker(contender.id, path))?.id).toBe(holder.id);
          expect(await blocker(holder.id, path)).toBeNull();
          expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(holder.id);
          expect((await store.getWorkflowRun(holder.id))?.status).toBe('running');
        }
      } finally {
        await harness.close();
      }
    }
  );
  test('a pre-phase schema upgrades legacy rows and accepts old-style inserts', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'legacy', user_message: '' });
      await store.failWorkflowRun(run.id, 'failure');
      await harness.backdate(run.id, { started_at: new Date('2020-01-01') });
      await db.query('ALTER TABLE remote_agent_workflow_runs DROP COLUMN active_phase_started_at');
      await db.query(getSchemaSQL());
      expect((await store.getWorkflowRun(run.id))?.active_phase_started_at).toBeNull();
      const resumed = await store.resumeWorkflowRun(run.id);
      expect(resumed.started_at).toEqual(new Date('2020-01-01'));
      expect(resumed.active_phase_started_at).toBeInstanceOf(Date);
      const id = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ($1, $2, 'old-writer', '')",
        [id, CONFORMANCE_CONVERSATION_ID]
      );
      expect((await store.getWorkflowRun(id))?.active_phase_started_at).toBeNull();
    } finally {
      await harness.close();
    }
  });
  test('foreign slot membership blocks guarded starts after its request is lost', async () => {
    const harness = await makeHarness();
    try {
      const { store, db } = harness;
      const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
      const holder = { ...start('queue', 'host', 1), resource: 'foreign' };
      expect((await store.admitResourceStart(holder)).status).toBe('admitted');
      await db.query('DELETE FROM remote_agent_resource_start_requests WHERE id = $1', [
        holder.launch.run.id,
      ]);
      const guarded = start('queue', 'host', 1);
      expect(await store.admitResourceStart(guarded)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      expect(
        await store.admitResourceStart({ ...start('skip', 'host', 1), resource: 'skip' })
      ).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      const reader = { ...start('queue', 'host', 1), resource: 'reader' };
      reader.launch.run.metadata.admission_checkout_guard = false;
      expect((await store.admitResourceStart(reader)).status).toBe('admitted');
      const privateStart = { ...start('queue', 'host', 1), resource: 'private' };
      privateStart.launch.execution.isolation = { kind: 'worktree' };
      expect((await store.admitResourceStart(privateStart)).status).toBe('admitted');
      expect(
        await store.drainResourceStarts({ resource: guarded.resource, hostId: 'host' })
      ).toEqual([]);
      expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('pending');
      await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
        holder.launch.run.id,
      ]);
      expect(
        await store.drainResourceStarts({ resource: guarded.resource, hostId: 'host' })
      ).toMatchObject([{ runId: guarded.launch.run.id }]);
    } finally {
      await harness.close();
    }
  });
  test.each(['missing', 'withdrawn'] as const)(
    'local slot membership refuses a %s request until terminal release',
    async damage => {
      const harness = await makeHarness();
      try {
        const { store, db } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const holder = start('queue', 'host', 2);
        await store.admitResourceStart(holder);
        const waiting = start('queue', 'host', 2, { cwd: holder.launch.execution.cwd });
        expect(await store.admitResourceStart(waiting)).toMatchObject({ status: 'queued' });
        if (damage === 'missing')
          await db.query('DELETE FROM remote_agent_resource_start_requests WHERE id = $1', [
            holder.launch.run.id,
          ]);
        else
          await db.query(
            "UPDATE remote_agent_resource_start_requests SET status = 'withdrawn' WHERE id = $1",
            [holder.launch.run.id]
          );
        for (const guard of [false, true]) {
          const incoming = start('queue', 'host', 2);
          incoming.launch.run.metadata.admission_checkout_guard = guard;
          await expect(store.admitResourceStart(incoming)).rejects.toThrow(
            'no matching admitted request'
          );
        }
        await expect(
          store.drainResourceStarts({ resource: holder.resource, hostId: 'host' })
        ).rejects.toThrow('no matching admitted request');
        expect((await store.getWorkflowRun(holder.launch.run.id))?.status).toBe('pending');
        await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
          holder.launch.run.id,
        ]);
        expect(
          await store.drainResourceStarts({ resource: holder.resource, hostId: 'host' })
        ).toMatchObject([{ runId: waiting.launch.run.id }]);
      } finally {
        await harness.close();
      }
    }
  );
  for (const firstMode of ['admit', 'drain'] as const) {
    for (const secondMode of ['admit', 'drain'] as const) {
      test(`checkout reservations serialize across resources: ${firstMode}/${secondMode}`, async () => {
        const harness = await makeHarness();
        const { store, db } = harness;
        const { start } = resourceStartFixtures(
          CONFORMANCE_CODEBASE_ID,
          CONFORMANCE_CONVERSATION_ID
        );
        const first = start('queue', 'first', 2, { cwd: '/shared' });
        const second = { ...start('queue', 'second', 2, { cwd: '/shared' }), resource: 'other' };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let firstOperation: Promise<unknown> | undefined;
        let secondOperation: Promise<unknown> | undefined;
        let interception: ReturnType<typeof spyOn> | undefined;
        try {
          const holder = await store.createWorkflowRun({
            ...first.launch.run,
            id: randomUUID(),
            working_path: '/shared',
          });
          for (const [mode, intent] of [
            [firstMode, first],
            [secondMode, second],
          ] as const)
            if (mode === 'drain')
              expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'queued' });
          await store.cancelWorkflowRun(holder.id);
          const transaction = db.withTransaction.bind(db);
          let intercepted = false;
          interception = spyOn(db, 'withTransaction').mockImplementation(callback =>
            transaction(query =>
              callback(async <T>(sql: string, params?: unknown[]) => {
                const result = await query<T>(sql, params);
                if (!intercepted && sql.includes('SELECT w.id, w.status, w.metadata')) {
                  intercepted = true;
                  entered.resolve();
                  await release.promise;
                }
                return result;
              })
            )
          );
          const perform = (mode: 'admit' | 'drain', intent: typeof first) =>
            mode === 'admit'
              ? store.admitResourceStart(intent)
              : store.drainResourceStarts({ resource: intent.resource, hostId: intent.hostId });
          firstOperation = perform(firstMode, first);
          await entered.promise;
          secondOperation = perform(secondMode, second);
          let blocked = false;
          for (let attempt = 0; attempt < 1000 && !blocked; attempt++) {
            const result = await db.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS blocked`
            );
            blocked = result.rows[0]?.blocked ?? false;
          }
          expect(blocked).toBe(true);
          release.resolve();
          await Promise.all([firstOperation, secondOperation]);
          expect(await store.getResourceStartRequest(first.launch.run.id)).toMatchObject({
            status: 'admitted',
          });
          expect(await store.getResourceStartRequest(second.launch.run.id)).toMatchObject({
            status: 'queued',
          });
          expect(await store.getWorkflowRun(second.launch.run.id)).toBeNull();
          await store.cancelWorkflowRun(first.launch.run.id);
          expect(
            await store.drainResourceStarts({ resource: second.resource, hostId: second.hostId })
          ).toMatchObject([{ runId: second.launch.run.id }]);
        } finally {
          release.resolve();
          await Promise.allSettled([firstOperation, secondOperation]);
          interception?.mockRestore();
          await harness.close();
        }
      });
    }
  }

  describeSqlStatusReadConformance(makeHarness);
  describeItemLinkConformance(makeHarness);
  describeItemLandingConformance(makeHarness);
  describeLinkedStartConformance(makeHarness);
  test('a linked start and an unlink of its link are ordered: the unlink waits for the completion', async () => {
    const harness = await makeHarness();
    let interception: ReturnType<typeof spyOn> | undefined;
    let unlink: Promise<unknown> | undefined;
    const release = Promise.withResolvers<void>();
    try {
      const { db, store } = harness;
      const linkId = await link(harness, 'waiter', 'dependency', 'depends_on');
      const { start, finish } = reviews(harness);
      const runId = await start('dependency');
      // Pause the completion right after it found the waiter, end the link from another
      // connection, and see whether that end can commit before the completion does.
      const found = Promise.withResolvers<void>();
      const transaction = db.withTransaction.bind(db);
      interception = spyOn(db, 'withTransaction').mockImplementation(callback =>
        transaction(query =>
          callback(async <T>(sql: string, params?: unknown[]) => {
            const result = await query<T>(sql, params);
            if (sql.includes('JOIN remote_agent_items i ON i.id = l.')) {
              found.resolve();
              await release.promise;
            }
            return result;
          })
        )
      );
      const completion = finish(runId, 'dependency', 'approved', WAIT);
      await found.promise;
      interception.mockRestore();
      interception = undefined;
      let ended = false;
      unlink = store.endItemLink({ linkId, via: 'cli', by: null, fromRun: null }).then(() => {
        ended = true;
      });
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting && !ended; attempt++) {
        const result = await db.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting`
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await Bun.sleep(10);
      }
      expect(ended).toBe(false);
      expect(waiting).toBe(true);
      release.resolve();
      // The link was active when the run completed, so the start stands; the end follows.
      expect((await completion).written.map(receipt => receipt.receipt.itemKey)).toEqual([
        'waiter',
      ]);
      await unlink;
      const after = await db.query<{ ended_at: unknown }>(
        'SELECT ended_at FROM remote_agent_item_links WHERE id = $1',
        [linkId]
      );
      expect(after.rows[0]?.ended_at).not.toBeNull();
    } finally {
      release.resolve();
      interception?.mockRestore();
      await unlink?.catch(() => undefined);
      await harness.close();
    }
  });
  describeSqlItemAskConformance(makeHarness);
  describeSqlItemWaitConformance(makeHarness);
  describeSqlItemAskStartConformance(makeHarness);
  describeSqlRunDeleteConformance(makeHarness);
  // A deletion decides on a tree, so a sub-run that becomes live while it runs must make it
  // keep the parent, never split the tree or strip the kept parent's events. The gate holds
  // the overlapping write uncommitted until the deletion is parked behind it.
  const overlaps = {
    'a sub-run is created': async (gate: Pool, parent: string) => {
      const id = randomUUID();
      await gate.query(
        `INSERT INTO remote_agent_workflow_runs (id, workflow_name, user_message, parent_run_id)
         VALUES ($1, 'late-child', '', $2)`,
        [id, parent]
      );
      return id;
    },
    'a finished sub-run is resumed': async (gate: Pool, _parent: string, finished: string) => {
      await gate.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1", [
        finished,
      ]);
      return finished;
    },
  };
  test.each(
    (['delete', 'cleanup'] as const).flatMap(path =>
      (Object.keys(overlaps) as (keyof typeof overlaps)[]).map(overlap => [path, overlap] as const)
    )
  )('%s keeps a parent when %s while it runs', async (path, overlap) => {
    const harness = await makeHarness();
    const gate = new Pool({ connectionString: harness.url, max: 1 });
    let gateOpen = false;
    try {
      const { db, store } = harness;
      const old = new Date(Date.now() - 10 * 86_400_000);
      const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
      const finished = await store.createWorkflowRun({
        workflow_name: 'child',
        user_message: '',
        parent_run_id: parent.id,
      });
      for (const run of [finished, parent]) {
        await store.claimPendingWorkflowRun(run.id);
        await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        await harness.backdate(run.id, { started_at: old, active_phase_started_at: old });
      }
      const events = await store.listWorkflowEvents(parent.id);
      expect(events.length).toBeGreaterThan(0);
      const parked = async () => {
        for (let tries = 0; tries < 200; tries++) {
          const waiting = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`
          );
          if ((waiting.rows[0]?.n ?? 0) >= 1) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Expected the deletion to wait on a lock');
      };

      await gate.query('BEGIN');
      gateOpen = true;
      const live = await overlaps[overlap](gate, parent.id, finished.id);
      const { deleteWorkflowRun } = await import('./workflow-run-writes');
      const deletion = (
        path === 'delete' ? deleteWorkflowRun(parent.id) : store.deleteOldWorkflowRuns(7)
      ).catch((error: unknown) => error);
      await parked();
      await gate.query('COMMIT');
      gateOpen = false;
      const outcome = await deletion;

      if (path === 'delete') {
        expect(outcome).toBeInstanceOf(WorkflowRunDeleteRefusedError);
        expect((outcome as Error).message).toContain(live);
      } else {
        expect(outcome).not.toBeInstanceOf(Error);
      }
      expect(await store.getWorkflowRunStatus(parent.id)).toBe('completed');
      expect(await store.listWorkflowEvents(parent.id)).toEqual(events);
      expect((await store.getWorkflowRun(live))?.parent_run_id).toBe(parent.id);
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await gate.end();
      await harness.close();
    }
  });
  // The deletion's first lock pass reads the snapshot it started with, so a sub-run created
  // and finished while that pass waits is not in it. It must still be locked before the
  // deletion decides, or a resume could make it live under a parent about to be deleted.
  // `parentGate` holds the first pass on the parent row; `eventGate` parks the deletion after
  // it decided, at its events delete, so the resume is tried while the decision stands.
  test.each(['delete', 'cleanup'] as const)(
    '%s locks a sub-run created while it waited, so its resume waits for the deletion',
    async path => {
      const harness = await makeHarness();
      const parentGate = new Pool({ connectionString: harness.url, max: 1 });
      const eventGate = new Pool({ connectionString: harness.url, max: 1 });
      const open = { parentGate: false, eventGate: false };
      try {
        const { db, store } = harness;
        const old = new Date(Date.now() - 10 * 86_400_000);
        const parent = await store.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
        await store.claimPendingWorkflowRun(parent.id);
        await store.completeWorkflowRun(parent.id, { duration_ms: 1 });
        await harness.backdate(parent.id, { started_at: old, active_phase_started_at: old });
        const pid = async (gate: Pool) =>
          (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
        // The backend blocked by `blocker`, once there is one; `settled` ends the wait early.
        const blockedBy = async (blocker: number, settled: { done: boolean }) => {
          for (let tries = 0; tries < 200; tries++) {
            const blocked = await db.query<{ pid: number }>(
              'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
              [blocker]
            );
            const found = blocked.rows[0]?.pid;
            if (found !== undefined) return found;
            if (settled.done) throw new Error('It finished without waiting on the lock');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error('Expected a backend waiting on the lock');
        };

        await parentGate.query('BEGIN');
        open.parentGate = true;
        await parentGate.query(
          'SELECT id FROM remote_agent_workflow_runs WHERE id = $1 FOR KEY SHARE',
          [parent.id]
        );
        await eventGate.query('BEGIN');
        open.eventGate = true;
        await eventGate.query(
          'SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1 FOR UPDATE',
          [parent.id]
        );
        const { deleteWorkflowRun } = await import('./workflow-run-writes');
        const deleted = { done: false };
        const deletion = (
          path === 'delete' ? deleteWorkflowRun(parent.id) : store.deleteOldWorkflowRuns(7)
        ).finally(() => {
          deleted.done = true;
        });
        await blockedBy(await pid(parentGate), deleted);

        // Created and finished while the first pass waits: not in its snapshot.
        const late = await store.createWorkflowRun({
          workflow_name: 'late-child',
          user_message: '',
          parent_run_id: parent.id,
        });
        await store.claimPendingWorkflowRun(late.id);
        await store.failWorkflowRun(late.id, 'interrupted');
        await parentGate.query('COMMIT');
        open.parentGate = false;
        const deleter = await blockedBy(await pid(eventGate), deleted);

        const resumed = { done: false };
        const resume = store.resumeWorkflowRun(late.id).finally(() => {
          resumed.done = true;
        });
        expect(await blockedBy(deleter, resumed)).toBeGreaterThan(0);
        await eventGate.query('COMMIT');
        open.eventGate = false;
        await deletion;
        await resume;

        // The tree had ended when the deletion decided, so the parent is gone, and the
        // resume ran after it: the sub-run is a root of its own, not a split live tree.
        expect(await store.getWorkflowRun(parent.id)).toBeNull();
        expect(await store.getWorkflowRun(late.id)).toMatchObject({
          status: 'running',
          parent_run_id: null,
        });
      } finally {
        if (open.parentGate) await parentGate.query('ROLLBACK');
        if (open.eventGate) await eventGate.query('ROLLBACK');
        await parentGate.end();
        await eventGate.end();
        await harness.close();
      }
    }
  );
  test('two completions of one workflow on one item that overlap leave one open set: the later one', async () => {
    const harness = await makeHarness();
    // Holding the item row FOR UPDATE parks each completion at its ask insert, whose
    // foreign-key check needs the row. Without serialization both are parked after their
    // replace has already run, so neither sees the other's set.
    const gate = new Pool({ connectionString: harness.url, max: 1 });
    let gateOpen = false;
    try {
      const { db, store } = harness;
      const start = async () => {
        const run = await store.createWorkflowRun({
          workflow_name: 'plan',
          user_message: '',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          item_key: 'issue-1',
        });
        return run.id;
      };
      const first = await start();
      const second = await start();
      await store.claimPendingWorkflowRun(first);
      // The claim refuses a second run of `plan` on the item while the first holds it, so the
      // overlap is written directly: an older binary, which has no item hold, can leave it.
      await db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1", [
        second,
      ]);
      const itemRow = await db.query<{ item_id: string }>(
        'SELECT item_id FROM remote_agent_workflow_runs WHERE id = $1',
        [first]
      );
      const itemId = itemRow.rows[0]?.item_id;
      if (itemId === undefined) throw new Error('Missing item fixture');
      const askOf = (question: string): ItemAsk => ({
        question,
        context: 'Two runs end together.',
        options: [
          { id: 'keep', does: 'Keep the flag.', cost: 'One more flag.' },
          { id: 'drop', does: 'Drop the flag.', cost: 'Older configs break.' },
        ],
        recommendation: { option: 'keep', why: 'Nothing depends on dropping it.' },
        artifacts: [],
      });
      const waiters = async (count: number) => {
        for (let tries = 0; tries < 200; tries++) {
          // Outside the gate: a transaction reads one pg_stat_activity snapshot throughout.
          const waiting = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`
          );
          if ((waiting.rows[0]?.n ?? 0) >= count) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Expected ${count} completions waiting on a lock`);
      };

      await gate.query('BEGIN');
      gateOpen = true;
      await gate.query('SELECT id FROM remote_agent_items WHERE id = $1 FOR UPDATE', [itemId]);
      // The first is parked before the second starts, so the second commits later.
      const firstDone = store.completeWorkflowRun(first, { duration_ms: 1 }, undefined, {
        asks: [askOf('First?')],
      });
      await waiters(1);
      const secondDone = store.completeWorkflowRun(second, { duration_ms: 1 }, undefined, {
        asks: [askOf('Second?')],
      });
      await waiters(2);
      await gate.query('COMMIT');
      gateOpen = false;
      await Promise.all([firstDone, secondDone]);

      const rows = await db.query<{
        run_id: string;
        closed_as: string | null;
        replaced_by_run_id: string | null;
      }>(
        'SELECT run_id, closed_as, replaced_by_run_id FROM remote_agent_item_asks WHERE item_id = $1',
        [itemId]
      );
      expect(rows.rows.filter(row => row.closed_as === null).map(row => row.run_id)).toEqual([
        second,
      ]);
      expect(rows.rows.filter(row => row.run_id === first)).toEqual([
        { run_id: first, closed_as: 'replaced', replaced_by_run_id: second },
      ]);
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await gate.end();
      await harness.close();
    }
  });
  test('a redelivery that waits on the first one replays and leaves later waits open', async () => {
    const harness = await makeHarness();
    // The gate stands for a first delivery still in flight: its receipt row is written but
    // not committed. The same delivery arriving now must wait for it and replay; it must
    // not meet the wait opened since (a stage that waited again) for a receipt that is
    // never recorded.
    const gate = new Pool({ connectionString: harness.url, max: 1 });
    let gateOpen = false;
    try {
      await completeWithWaits(harness, [checks(HEAD)]);
      const project = await projectKey(harness);
      const redelivery = wakeReceipt(HEAD, { deliveryId: 'delivery-a' });
      const firstId = randomUUID();
      await gate.query('BEGIN');
      gateOpen = true;
      await gate.query(
        `INSERT INTO remote_agent_start_receipts
         (id, source_instance_id, delivery_id, content_digest, received_at, outcome)
         VALUES ($1, $2, $3, $4, $5, 'unmatched')`,
        [
          firstId,
          redelivery.receipt.sourceInstanceId,
          redelivery.receipt.deliveryId,
          redelivery.receipt.contentDigest,
          redelivery.receipt.receivedAt,
        ]
      );
      const { acceptStartReceipt } = await import('./start-receipt-writes');
      const accepted = acceptStartReceipt(redelivery, async () => project);
      for (let tries = 0; tries < 200; tries++) {
        const waiting = await harness.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        if ((waiting.rows[0]?.n ?? 0) >= 1) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await gate.query('COMMIT');
      gateOpen = false;
      expect(await accepted).toEqual({ receiptId: firstId, replay: true });
      expect((await harness.store.listOpenItemWaits()).map(wait => wait.about)).toEqual([HEAD]);
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await gate.end();
      await harness.close();
    }
  });

  test('two deliveries for one wait that overlap start one stage', async () => {
    const harness = await makeHarness();
    // Holding the wait's row FOR UPDATE parks both acceptances on it, so they overlap: the
    // one that takes the row second must see the set met and start nothing.
    const gate = new Pool({ connectionString: harness.url, max: 1 });
    let gateOpen = false;
    try {
      await completeWithWaits(harness, [checks(HEAD)]);
      const project = await projectKey(harness);
      const waiters = async (count: number) => {
        for (let tries = 0; tries < 200; tries++) {
          const waiting = await harness.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`
          );
          if ((waiting.rows[0]?.n ?? 0) >= count) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Expected ${count} acceptances waiting on a lock`);
      };
      await gate.query('BEGIN');
      gateOpen = true;
      await gate.query('SELECT id FROM remote_agent_item_waits FOR UPDATE');
      const accepted = ['delivery-a', 'delivery-b'].map(deliveryId =>
        accept(wakeReceipt(HEAD, { deliveryId }), project)
      );
      await waiters(2);
      await gate.query('COMMIT');
      gateOpen = false;
      const ids = await Promise.all(accepted);
      const outcomes = await Promise.all(
        ids.map(async id => (await readReceipt(harness, id)).outcome)
      );
      expect(outcomes.sort()).toEqual(['matched', 'unmatched']);
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await gate.end();
      await harness.close();
    }
  });
  test('SQL attention reads report unreadable origins without losing valid rows or writing state', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const { listRunsNeedingAttention, listAttentionQueueRows } = await import(
        './workflow-run-lists'
      );
      const valid = await store.createWorkflowRun({ workflow_name: 'valid', user_message: '' });
      const bad = await store.createWorkflowRun({ workflow_name: 'bad', user_message: '' });
      await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
        '[]',
        bad.id,
      ]);
      for (const id of [valid.id, bad.id]) {
        await db.query(
          "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
          [JSON.stringify({ approval: { nodeId: 'review', message: 'Approve?' } }), id]
        );
      }
      const snapshot = async () => ({
        rows: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
        events: (await db.query('SELECT * FROM remote_agent_workflow_events ORDER BY id')).rows,
      });
      const before = await snapshot();
      for (const read of [
        listRunsNeedingAttention,
        listAttentionQueueRows,
        () => store.listAttentionQueueRows(),
      ]) {
        const { values, degraded } = splitAttentionRead(await read());
        expect(values.map(run => run.id)).toEqual([valid.id]);
        expect(degraded).toEqual([{ type: 'degraded', reason: 'run_unreadable', runId: bad.id }]);
        expect(JSON.stringify(degraded)).not.toContain('private-origin-sentinel');
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      await harness.close();
    }
  });
  test.each([false, true])(
    'source suspension excludes a resume on another connection (resumed=%s)',
    async resumed => {
      const harness = await makeHarness();
      const { store, db } = harness;
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let releasing: Promise<unknown> | undefined;
      let resuming: Promise<unknown> | undefined;
      try {
        let run = await store.createWorkflowRun({ workflow_name: 'source-lock', user_message: '' });
        await store.claimPendingWorkflowRun(run.id);
        if (resumed) {
          await store.pauseWorkflowRun(run.id, {
            nodeId: 'gate',
            type: 'approval',
            message: 'Review',
          });
          run = await store.resumeWorkflowRun(run.id);
        }
        const order: string[] = [];
        releasing = store.releaseRunForUnreadableSource(
          run.id,
          {
            claimId: executionClaim(run.metadata),
            nodeId: 'source',
            error: 'EACCES',
            retryAt: new Date().toISOString(),
          },
          async () => {
            entered.resolve();
            await finish.promise;
            order.push('stopped');
          }
        );
        await entered.promise;
        resuming = store.resumeWorkflowRun(run.id).then(next => {
          order.push('resumed');
          return next;
        });
        // Observe the real row-lock waiter before allowing Docker to finish.
        let blocked = false;
        for (let attempt = 0; attempt < 1000 && !blocked; attempt++) {
          const result = await db.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock') AS blocked`
          );
          blocked = result.rows[0]?.blocked ?? false;
        }
        expect(blocked).toBe(true);
        expect(order).toEqual([]);
        finish.resolve();
        expect(await releasing).toEqual({ released: true });
        expect(await resuming).toMatchObject({ status: 'running' });
        expect(order).toEqual(['stopped', 'resumed']);
      } finally {
        finish.resolve();
        await Promise.allSettled([releasing, resuming]);
        await harness.close();
      }
    }
  );
  test('explicit deletion retains SQL feed payloads from an earlier cursor', async () => {
    const harness = await makeHarness();
    try {
      const { store } = harness;
      const run = await store.createWorkflowRun({ workflow_name: 'delete-feed', user_message: '' });
      const head = await store.getWorkflowEventHead();
      await store.cancelWorkflowRun(run.id);
      const committed = await store.listWorkflowEvents(run.id);
      const { deleteWorkflowRun } = await import('./workflows');
      await deleteWorkflowRun(run.id);
      expect(await store.getWorkflowRun(run.id)).toBeNull();
      expect(await store.listWorkflowEvents(run.id)).toEqual([]);
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
      ).toEqual(committed);
    } finally {
      await harness.close();
    }
  });
  test('an event removed before commit retains final commit order in the archive', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      const run = await store.createWorkflowRun({
        workflow_name: 'removed-before-commit',
        user_message: '',
      });
      const id = randomUUID();
      let head = await store.getWorkflowEventHead();
      await db.withTransaction(async query => {
        await query(
          "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ($1, $2, 'workflow_started')",
          [id, run.id]
        );
        await query('DELETE FROM remote_agent_workflow_events WHERE id = $1', [id]);
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
        });
        head = await store.getWorkflowEventHead();
      });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event.id)
      ).toEqual([id]);
    } finally {
      await harness.close();
    }
  });
  test('archives deleted events after the events table gains a column', async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      await db.query('ALTER TABLE remote_agent_workflow_events ADD COLUMN later_column TEXT');
      await db.query(getSchemaSQL());
      const run = await store.createWorkflowRun({
        workflow_name: 'later-column',
        user_message: '',
      });
      const id = randomUUID();
      await db.query(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, later_column) VALUES ($1, $2, 'workflow_started', 'kept')",
        [id, run.id]
      );
      await db.query('DELETE FROM remote_agent_workflow_events WHERE id = $1', [id]);
      expect(
        (
          await db.query(
            'SELECT later_column FROM remote_agent_workflow_event_archive WHERE id = $1',
            [id]
          )
        ).rows
      ).toEqual([{ later_column: 'kept' }]);
    } finally {
      await harness.close();
    }
  });
  test("the head includes events ordered by the previous binary's trigger", async () => {
    const harness = await makeHarness();
    try {
      const { db, store } = harness;
      await db.query(`CREATE OR REPLACE FUNCTION archon_assign_workflow_event_order() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(3334);
          UPDATE remote_agent_workflow_events
            SET event_order = nextval('remote_agent_workflow_events_event_order_seq') WHERE id = NEW.id;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql`);
      const run = await store.createWorkflowRun({ workflow_name: 'old-writer', user_message: '' });
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      const head = await store.getWorkflowEventHead();
      expect((await store.readWorkflowEventsAfter(head, { limit: 1 })).events).toEqual([]);
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      expect((await store.readWorkflowEventsAfter(head, { limit: 1 })).events).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
  test('trigger admission preserves atomic run/request/holder writes and origin-free claims', async () => {
    const harness = await makeHarness();
    const { store, db } = harness;
    try {
      const launch = (id: string) => ({
        version: 2 as const,
        run: {
          id,
          workflow_name: 'trigger',
          codebase_id: CONFORMANCE_CODEBASE_ID,
          user_message: '',
          metadata: {},
        },
        execution: {
          cwd: `/conformance/${id}`,
          conversationId: id,
          isolation: { kind: 'in-place' as const },
        },
      });
      const first = randomUUID(),
        second = randomUUID(),
        rejected = randomUUID();
      const intent = (id: string) => ({
        resource: 'trigger',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue' as const,
        launch: launch(id),
      });
      const decisions = await Promise.all([
        store.admitResourceStart(intent(first)),
        store.admitResourceStart(intent(second)),
      ]);
      expect(decisions.map(item => item.status).sort()).toEqual(['admitted', 'queued']);
      const admitted = decisions.find(item => item.status === 'admitted');
      if (!admitted) throw new Error('Expected one admitted request');
      const winner = admitted.requestId;
      const queued = winner === first ? second : first;
      expect(await store.getWorkflowRun(winner)).toMatchObject({
        status: 'pending',
        origin: null,
        conversation_id: null,
      });
      expect(await store.getWorkflowRun(queued)).toBeNull();
      expect(
        (
          await db.query(
            'SELECT holder_id FROM remote_agent_resource_slot_holders WHERE resource_key = $1',
            ['trigger']
          )
        ).rows
      ).toEqual([{ holder_id: winner }]);
      const claims = await Promise.all([
        store.claimPendingWorkflowRun(winner),
        store.claimPendingWorkflowRun(winner),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.completeWorkflowRun(winner, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'trigger', hostId: 'host' })).toEqual([
        { status: 'admitted', requestId: queued, runId: queued },
      ]);
      await db.query(
        `ALTER TABLE remote_agent_workflow_runs ADD CONSTRAINT reject_trigger_run CHECK (id <> '${rejected}') NOT VALID`
      );
      await expect(
        store.admitResourceStart({ ...intent(rejected), resource: 'rollback' })
      ).rejects.toThrow();
      expect(await store.getResourceStartRequest(rejected)).toBeNull();
      expect(await store.getWorkflowRun(rejected)).toBeNull();
      expect(
        (
          await db.query('SELECT * FROM remote_agent_resource_slots WHERE resource_key = $1', [
            'rollback',
          ])
        ).rows
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });
  test('a claim or hand admission waits for an admission in flight on the same item', async () => {
    const harness = await makeHarness();
    const { store, db } = harness;
    try {
      const pending = async (item: string): Promise<string> =>
        (
          await store.createWorkflowRun({
            id: randomUUID(),
            workflow_name: 'build',
            codebase_id: CONFORMANCE_CODEBASE_ID,
            user_message: '',
            item_key: item,
          })
        ).id;
      // Another admission holds the lock and makes `holder` hold the item, then commits
      // once `attempt` is waiting on that lock. An implementation that skips the lock never
      // waits on it, and the test fails here instead of racing the commit.
      const racedBy = async <T>(holder: string, attempt: () => Promise<T>): Promise<T> => {
        let raced: Promise<T> | undefined;
        await db.withTransaction(async query => {
          await query('SELECT pg_advisory_xact_lock(1797)');
          await query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1", [
            holder,
          ]);
          raced = attempt();
          raced.catch(() => undefined);
          for (let tries = 0; ; tries++) {
            const waiting = await query<{ count: string | number }>(
              `SELECT COUNT(*) AS count FROM pg_locks
                WHERE locktype = 'advisory' AND classid = 0 AND objid = 1797 AND NOT granted`
            );
            if (Number(waiting.rows[0]?.count) > 0) break;
            if (tries > 200) throw new Error('attempt never waited on the admission lock');
            await Bun.sleep(10);
          }
        });
        if (!raced) throw new Error('attempt did not start');
        return raced;
      };
      const [holder, claim] = [await pending('issue-1'), await pending('issue-1')];
      await expect(
        racedBy(holder, () => store.claimPendingWorkflowRun(claim))
      ).rejects.toMatchObject({ name: 'WorkflowItemHeldError', holderRunId: holder });

      const [slotHolder, admit] = [await pending('issue-2'), await pending('issue-2')];
      expect(
        await racedBy(slotHolder, () =>
          store.admitPendingRun({
            resource: 'builds',
            capacity: 5,
            launch: {
              version: 2,
              run: {
                id: admit,
                workflow_name: 'build',
                codebase_id: CONFORMANCE_CODEBASE_ID,
                user_message: '',
                metadata: {},
              },
              execution: {
                cwd: '/conformance',
                conversationId: 'c',
                isolation: { kind: 'in-place' },
              },
            },
          })
        )
      ).toEqual({ kind: 'run', id: slotHolder });
    } finally {
      await harness.close();
    }
  });
  test('conversation reset rolls back all rows and events when a terminal insert fails', async () => {
    const harness = await makeHarness();
    const { store, db } = harness;
    try {
      const paused = await store.createWorkflowRun({
        workflow_name: 'reset',
        user_message: 'test',
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.claimPendingWorkflowRun(paused.id);
      await store.pauseWorkflowRun(paused.id, {
        nodeId: 'review',
        message: 'Choose',
        type: 'approval',
        pauseId: 'first',
      });
      const failed = await store.createWorkflowRun({
        workflow_name: 'reset',
        user_message: 'test',
        origin: { parentConversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.failWorkflowRun(failed.id, 'failed');
      const ids = [paused.id, failed.id];
      const before = await Promise.all(ids.map(id => store.getWorkflowRun(id)));
      const events = await Promise.all(ids.map(id => store.listWorkflowEvents(id)));
      const reports = harness.terminalReports();
      // Only the terminal INSERT fails; its preceding row update and projection reads succeed.
      await db.query(`ALTER TABLE remote_agent_workflow_events
        ADD CONSTRAINT reject_cancellation CHECK (event_type <> 'workflow_cancelled') NOT VALID`);
      await expect(
        store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID)
      ).rejects.toThrow('Failed to cancel resumable runs for conversation');
      expect(await Promise.all(ids.map(id => store.getWorkflowRun(id)))).toEqual(before);
      expect(await Promise.all(ids.map(id => store.listWorkflowEvents(id)))).toEqual(events);
      expect(harness.terminalReports()).toEqual(reports);
    } finally {
      await harness.close();
    }
  });
});
