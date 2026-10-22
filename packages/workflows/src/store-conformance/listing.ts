import { beforeEach, describe, expect, test } from 'bun:test';
import type { IWorkflowStore } from '../store';
import type { WorkflowRun } from '../schemas/workflow-run';
import { workflowNodeSessionSchema } from '../schemas/workflow-node-session';
import { workflowRunNodeSessionSchema } from '../schemas/workflow-run-node-session';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  approval,
  create,
  running,
  rejection,
} from './fixtures';

export function describeListingConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('listing and sessions', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    test('run tree orders children and caps nearest-first ancestry', async () => {
      const root = await create(store);
      const first = await create(store, { parent_run_id: root.id });
      await harness.backdate(first.id, { started_at: new Date(Date.now() - 60_000) });
      const second = await create(store, { parent_run_id: root.id });
      expect((await store.findChildRuns(root.id)).map(run => run.id)).toEqual([
        first.id,
        second.id,
      ]);
      let leaf = first;
      const lineage = [root, first];
      for (let index = 0; index < 35; index++) {
        leaf = await create(store, { parent_run_id: leaf.id });
        lineage.push(leaf);
      }
      expect((await store.getRunAncestry(leaf.id)).map(run => run.id)).toEqual(
        lineage
          .slice(0, -1)
          .reverse()
          .slice(0, 32)
          .map(run => run.id)
      );
      expect(await store.getRunAncestry(root.id)).toEqual([]);
    });
    test('both session kinds upsert without replacing created_at; scope deletion honors every filter', async () => {
      const run = await create(store);
      const key = {
        workflow_name: 'conformance',
        node_id: 'build',
        scope_key: 'scope',
        provider: 'claude',
      };
      await store.upsertWorkflowNodeSession({
        ...key,
        provider_session_id: 'first',
        last_run_id: run.id,
      });
      const initial = await store.listWorkflowNodeSessions(key);
      expect(workflowNodeSessionSchema.safeParse(initial[0]).success).toBe(true);
      await store.upsertWorkflowRunNodeSession({
        workflow_run_id: run.id,
        node_id: 'build',
        provider: 'claude',
        provider_session_id: 'first',
      });
      const runInitial = await store.listWorkflowRunNodeSessions(run.id);
      expect(workflowRunNodeSessionSchema.safeParse(runInitial[0]).success).toBe(true);
      // SQLite's session clock resolves seconds; cross a tick so resetting created_at cannot pass.
      await Bun.sleep(1100);
      await store.upsertWorkflowNodeSession({
        ...key,
        provider_session_id: 'second',
        last_run_id: null,
      });
      const changed = await store.listWorkflowNodeSessions(key);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        provider_session_id: 'second',
        last_run_id: null,
        created_at: initial[0]?.created_at,
      });
      await store.upsertWorkflowNodeSession({
        ...key,
        scope_key: 'other',
        provider_session_id: 'other',
        last_run_id: run.id,
      });
      await store.upsertWorkflowNodeSession({
        ...key,
        node_id: 'other',
        provider_session_id: 'other',
        last_run_id: run.id,
      });
      await store.upsertWorkflowRunNodeSession({
        workflow_run_id: run.id,
        node_id: 'build',
        provider: 'codex',
        provider_session_id: 'second',
      });
      expect(await store.listWorkflowRunNodeSessions(run.id)).toEqual([
        expect.objectContaining({
          provider: 'codex',
          provider_session_id: 'second',
          created_at: runInitial[0]?.created_at,
        }),
      ]);
      expect(
        await store.deleteWorkflowNodeSessions({
          workflow_name: 'conformance',
          scope_key: 'scope',
          node_id: 'build',
        })
      ).toEqual({ deleted: 1 });
      expect(await store.listWorkflowNodeSessions(key)).toHaveLength(1);
      expect(
        await store.deleteWorkflowNodeSessions({ workflow_name: 'conformance', scope_key: 'scope' })
      ).toEqual({ deleted: 1 });
      expect(await store.listWorkflowNodeSessions({ ...key, scope_key: 'other' })).toHaveLength(1);
      expect(await store.deleteWorkflowNodeSessions({ workflow_name: 'conformance' })).toEqual({
        deleted: 1,
      });
    });
    test('listing filters, counts, pagination and UUID prefixes agree', async () => {
      const first = await create(store, {
        id: 'abcdef00-0000-4000-8000-000000000001',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        workflow_name: 'needle',
      });
      await harness.backdate(first.id, { started_at: new Date('2026-01-01T00:00:00.000Z') });
      const second = await running(store, {
        id: 'abcdef00-0000-4000-8000-000000000002',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        workflow_name: 'needle',
      });
      await harness.backdate(second.id, { started_at: new Date('2026-01-02T00:00:00.000Z') });
      await store.pauseWorkflowRun(second.id, approval);
      await create(store, { workflow_name: 'other' });
      const listed = await store.listWorkflowRuns({
        codebaseId: CONFORMANCE_CODEBASE_ID,
        status: ['paused', 'pending'],
        search: 'needle',
        limit: 1,
      });
      expect(listed.runs.map(run => run.id)).toEqual([second.id]);
      expect(listed.total).toBe(2);
      expect(listed.counts).toMatchObject({ all: 2, pending: 1, paused: 1 });
      expect(
        (await store.listWorkflowRuns({ codebaseId: CONFORMANCE_CODEBASE_ID, status: 'paused' }))
          .total
      ).toBe(1);
      expect(
        (
          await store.listWorkflowRuns({ codebaseId: CONFORMANCE_CODEBASE_ID, limit: 1, offset: 1 })
        ).runs.map(run => run.id)
      ).toEqual([first.id]);
      expect(
        (
          await store.listWorkflowRuns({
            codebaseId: CONFORMANCE_CODEBASE_ID,
            after: '2026-01-01T12:00:00.000Z',
            before: '2026-01-03T00:00:00.000Z',
          })
        ).runs.map(run => run.id)
      ).toEqual([second.id]);
      expect(
        (await store.findWorkflowRunsByIdPrefix('ABCDEF00', CONFORMANCE_CODEBASE_ID))
          .map(run => run.id)
          .sort()
      ).toEqual([first.id, second.id]);
      await create(store, {
        id: 'abcdef00-0000-4000-8000-000000000003',
        codebase_id: CONFORMANCE_CODEBASE_ID,
      });
      expect(
        await store.findWorkflowRunsByIdPrefix('abcdef00', CONFORMANCE_CODEBASE_ID)
      ).toHaveLength(2);
      expect(await store.findWorkflowRunsByIdPrefix('abcdef00', crypto.randomUUID())).toEqual([]);
      for (const prefix of ['', '%', '_', 'not-a-uuid'])
        expect(await store.findWorkflowRunsByIdPrefix(prefix, CONFORMANCE_CODEBASE_ID)).toEqual([]);
    });
    test('parent sets scope listing rows, totals and status counts', async () => {
      const first = await create(store);
      const second = await create(store);
      const terminal = await create(store, { parent_run_id: first.id });
      await store.cancelWorkflowRun(terminal.id);
      const leaf = await create(store, { parent_run_id: second.id });
      const grandchild = await create(store, { parent_run_id: terminal.id });
      await create(store);
      const parentRunIds = [first.id, second.id, first.id];
      const listed = await store.listWorkflowRuns({ parentRunIds });
      expect(listed.runs.map(run => run.id).sort()).toEqual([terminal.id, leaf.id].sort());
      expect(listed.total).toBe(2);
      expect(listed.counts).toMatchObject({ all: 2, cancelled: 1, pending: 1 });
      const filtered = await store.listWorkflowRuns({ parentRunIds, status: 'pending', limit: 0 });
      expect(filtered.runs).toEqual([]);
      expect(filtered.total).toBe(1);
      expect(filtered.counts).toMatchObject({ all: 2, cancelled: 1, pending: 1 });
      expect((await store.listWorkflowRuns({ parentRunIds, limit: 0 })).total).toBe(2);
      expect(
        (
          await store.listWorkflowRuns({
            parentRunIds: Array<string>(40_000).fill(first.id),
            limit: 0,
          })
        ).total
      ).toBe(1);
      const empty = await store.listWorkflowRuns({ parentRunIds: [] });
      expect(empty.runs).toEqual([]);
      expect(empty.total).toBe(0);
      expect(empty.counts.all).toBe(0);
      expect((await store.listWorkflowRuns()).total).toBe(6);
      expect(
        (await store.listWorkflowRuns({ parentRunIds: [terminal.id] })).runs.map(run => run.id)
      ).toEqual([grandchild.id]);
    });

    test('frontier counts exclude completed and cancelled leaves but retain unresolved subtrees', async () => {
      const parent = await create(store);
      const expected: string[] = [];
      for (const status of [
        'completed',
        'cancelled',
        'pending',
        'running',
        'failed',
        'paused',
      ] as const) {
        for (const hasChild of [false, true]) {
          const run = await create(store, { parent_run_id: parent.id });
          switch (status) {
            case 'completed':
              await store.updateWorkflowRun(run.id, { status: 'running' });
              await store.completeWorkflowRun(run.id, { duration_ms: 1 });
              break;
            case 'cancelled':
              await store.cancelWorkflowRun(run.id);
              break;
            case 'failed':
              await store.failWorkflowRun(run.id, 'failure');
              break;
            case 'running':
            case 'paused':
              await store.updateWorkflowRun(run.id, { status });
              break;
          }
          if (hasChild) await create(store, { parent_run_id: run.id });
          if (hasChild || (status !== 'completed' && status !== 'cancelled')) expected.push(run.id);
        }
      }
      const options = {
        parentRunIds: [parent.id],
        excludeLeafStatuses: ['completed', 'cancelled'] satisfies WorkflowRun['status'][],
      };
      const result = await store.listWorkflowRuns(options);
      expect(result.runs.map(run => run.id).sort()).toEqual(expected.sort());
      expect(result.total).toBe(10);
      expect(result.counts).toMatchObject({
        all: 10,
        completed: 1,
        cancelled: 1,
        pending: 2,
        running: 2,
        failed: 2,
        paused: 2,
      });
      const probe = await store.listWorkflowRuns({
        ...options,
        limit: 0,
      });
      expect(probe.runs).toEqual([]);
      expect(probe.total).toBe(10);
      const completed = await store.listWorkflowRuns({ ...options, status: 'completed', limit: 0 });
      expect(completed.total).toBe(1);
      expect(completed.counts.all).toBe(10);
      expect(
        (await store.listWorkflowRuns({ parentRunIds: [parent.id], excludeLeafStatuses: [] })).total
      ).toBe(12);
      expect((await store.listWorkflowRuns({ parentRunIds: [parent.id] })).total).toBe(12);
    });

    test('open work excludes adopted failures, adopters are newest first, cleanup deletes only old terminals', async () => {
      const failed = await create(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      await store.failWorkflowRun(failed.id, 'failed');
      const old = new Date(Date.now() - 4 * 86_400_000);
      await harness.backdate(failed.id, { started_at: old });
      expect(
        (await store.findOpenWorkRuns({ codebaseId: CONFORMANCE_CODEBASE_ID })).map(run => run.id)
      ).toEqual([failed.id]);
      const first = await create(store, { adopted_from_run_id: failed.id });
      await harness.backdate(first.id, { started_at: old });
      const second = await create(store, { adopted_from_run_id: failed.id });
      expect((await store.findAdoptingRuns(failed.id)).map(run => run.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(await store.findOpenWorkRuns()).toEqual([]);
      const scope = { workflow_name: 'conformance', scope_key: 'cleanup' };
      await store.upsertWorkflowNodeSession({
        ...scope,
        node_id: 'build',
        provider: 'claude',
        provider_session_id: 'keep',
        last_run_id: failed.id,
      });
      expect(await store.deleteOldWorkflowRuns(2)).toEqual({ count: 1 });
      expect(await store.listWorkflowNodeSessions(scope)).toEqual([
        expect.objectContaining({ provider_session_id: 'keep', last_run_id: null }),
      ]);

      expect(await store.getWorkflowRun(failed.id)).toBeNull();
      expect(await store.listWorkflowEvents(failed.id)).toEqual([]);
      expect(await store.getWorkflowRunStatus(first.id)).toBe('pending');
      expect(await rejection(store.deleteOldWorkflowRuns(-1))).toBeInstanceOf(Error);
    });
    test('origin-free and chat runs round-trip the supplied provenance', async () => {
      const free = await create(store);
      expect(await store.getWorkflowRun(free.id)).toMatchObject({
        origin: null,
        conversation_id: null,
        parent_conversation_id: null,
        user_id: null,
      });
      const origin = { conversationId: CONFORMANCE_CONVERSATION_ID };
      const chat = await create(store, { origin });
      expect((await store.getWorkflowRun(chat.id))?.origin).toEqual(origin);
    });
  });
}
