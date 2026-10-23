import { beforeEach, describe, expect, test } from 'bun:test';
import { WorkflowNotResumableError, type IWorkflowStore } from '../store';
import {
  attentionLabels,
  attentionRevision,
  pausedAttentionWait,
  queuedRunAttention,
  type WorkflowWaitContext,
  type WorkflowRun,
} from '../schemas/workflow-run';
import { join } from 'node:path';
import { getArchonWorkspacesPath, projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  countAttentionQueue,
  listAttentionQueue,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueItem,
  type AttentionQueueSource,
  type ProjectRef,
} from '../attention-queue';
import { watchAttentionQueue, type AttentionStreamLine } from '../attention-watch';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  CONFORMANCE_CODEBASE_ID,
  approval,
  wait,
  attentionWait,
  attentionAnswer,
  eight,
  running,
  rejection,
  gateEvents,
} from './fixtures';

export function describeAttentionConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('attention', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getHarness().store;
    });

    test('every write that opens, revises, answers or closes a queue item, or ends a run, commits an event for that run', async () => {
      // What the attention queue reports for a run, as its stream compares it.
      const reported = async (id: string): Promise<string> => {
        const run = await store.getWorkflowRun(id);
        if (run === null) throw new Error(`run ${id} vanished`);
        const attention = queuedRunAttention(run);
        const wait = pausedAttentionWait(run);
        return JSON.stringify({
          status: run.status,
          kind: attention?.kind,
          occurrence:
            attention !== undefined && 'occurrence' in attention ? attention.occurrence : null,
          labels: wait === undefined ? {} : attentionLabels(wait),
          revision: wait === undefined ? 1 : attentionRevision(wait),
        });
      };
      const commits = async (id: string, write: () => Promise<unknown>): Promise<void> => {
        const head = await store.getWorkflowEventHead();
        const before = await reported(id);
        await write();
        expect(await reported(id)).not.toBe(before);
        const page = await store.readWorkflowEventsAfter(head, { limit: 100 });
        expect(page.events.map(({ event }) => event.workflow_run_id)).toContain(id);
      };
      const expected = { nodeId: 'review', pauseId: 'first' };
      const suspended = (id: string): Parameters<IWorkflowStore['pauseWorkflowRun']>[3] => ({
        workflow_run_id: id,
        event_type: 'node_suspended',
        step_name: 'review',
        data: {},
      });

      const gate = await running(store);
      await commits(gate.id, () =>
        store.pauseWorkflowRun(gate.id, approval, undefined, suspended(gate.id))
      );
      await commits(gate.id, () =>
        store.resolveApprovalGate(
          gate.id,
          { approval: { ...approval, resolved: 'approved' } },
          gateEvents(0),
          expected
        )
      );
      await commits(gate.id, () => store.resumeWorkflowRun(gate.id));
      await commits(gate.id, () => store.completeWorkflowRun(gate.id, { duration_ms: 1 }));

      const ask = await running(store);
      const write = { pauseId: 'ask-1', set: { ci: 'pr' }, unset: [], via: 'cli' };
      await commits(ask.id, () =>
        store.pauseWorkflowRunForWait(ask.id, attentionWait, { kind: 'started', stepName: 'ask' })
      );
      await commits(ask.id, () => store.labelAttentionWait(ask.id, write));
      await commits(ask.id, () => store.resumeWorkflowRun(ask.id));
      await commits(ask.id, () =>
        store.pauseWorkflowRunForWait(ask.id, attentionWait, { kind: 'continued' })
      );
      await commits(ask.id, () => store.answerAttentionWait(ask.id, attentionAnswer('use-main')));
      await commits(ask.id, () => store.resumeWorkflowRun(ask.id));
      await commits(ask.id, () => store.failWorkflowRun(ask.id, 'boom'));

      const rejected = await running(store);
      await store.pauseWorkflowRun(rejected.id, approval, undefined, suspended(rejected.id));
      await commits(rejected.id, () =>
        store.resolveAndCancelApprovalGate(
          rejected.id,
          gateEvents(0),
          { reason: 'rejected' },
          expected
        )
      );

      const abandoned = await running(store);
      await store.pauseWorkflowRun(abandoned.id, approval, undefined, suspended(abandoned.id));
      await commits(abandoned.id, () => store.cancelWorkflowRun(abandoned.id));
    });
    test('rejecting a paused run that records no gate cancels it, exactly once', async () => {
      const run = await running(store);
      await store.updateWorkflowRun(run.id, { status: 'paused' });
      expect(await store.getWorkflowRun(run.id)).toMatchObject({ status: 'paused', metadata: {} });
      const outcomes = await Promise.all([
        store.resolveAndCancelApprovalGate(run.id, gateEvents(0), { reason: 'rejected' }),
        store.resolveAndCancelApprovalGate(run.id, gateEvents(1), { reason: 'rejected' }),
      ]);
      expect(outcomes.filter(outcome => outcome.resolved)).toHaveLength(1);
      expect((await store.getWorkflowRun(run.id))?.status).toBe('cancelled');
    });
    test('the attention watch follows a run from the store feed alone', async () => {
      const lines: AttentionStreamLine[] = [];
      const watch = await watchAttentionQueue(
        store,
        { branchOf: async () => null },
        line => void lines.push(line),
        { scope: { kind: 'all' }, pollIntervalMs: 5 }
      );
      const next = async (type: AttentionStreamLine['type']): Promise<AttentionStreamLine> => {
        for (let waited = 0; waited < 5000; waited += 5) {
          const line = lines.find(candidate => candidate.type === type);
          if (line) return line;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`no ${type} line in ${JSON.stringify(lines)}`);
      };
      try {
        const run = await running(store);
        await store.pauseWorkflowRunForWait(run.id, attentionWait, {
          kind: 'started',
          stepName: 'ask',
        });
        expect(await next('attention')).toMatchObject({
          item: { runId: run.id, occurrence: 'ask-1' },
        });
        await store.answerAttentionWait(run.id, attentionAnswer('use-main'));
        expect(await next('resolved')).toMatchObject({
          runId: run.id,
          reason: 'answered',
          answeredVia: 'cli',
        });
        await store.resumeWorkflowRun(run.id);
        await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        expect(await next('terminal')).toMatchObject({ runId: run.id, status: 'completed' });
      } finally {
        await watch.close();
      }
    });
    test('loop question references survive pause, label, answer and resume writes', async () => {
      const run = await running(store);
      const loopQuestionReferences = {
        '$LOOP_PREV.work.output': '$other.output',
        $LOOP_USER_INPUT: 'feedback',
      };
      const pause: WorkflowWaitContext = {
        ...attentionWait,
        owner: 'loop_group',
        nodeId: 'grp',
        bodyWaitId: 'ask',
        iteration: 2,
        sessionId: null,
        sessionProvider: null,
        loopQuestionReferences,
      };
      await store.pauseWorkflowRunForWait(run.id, pause, { kind: 'started', stepName: 'grp.ask' });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toEqual(pause);
      expect(
        await store.labelAttentionWait(run.id, {
          pauseId: 'ask-1',
          set: { state: 'ready' },
          unset: [],
          via: 'cli',
        })
      ).toMatchObject({ labeled: true });
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-main'))).toEqual({
        answered: true,
      });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toMatchObject({
        loopQuestionReferences,
      });
      const resumed = await store.resumeWorkflowRun(run.id, {
        kind: 'answered',
        nodeId: 'grp',
        pauseId: 'ask-1',
      });
      expect(resumed.metadata.wait).toMatchObject({ loopQuestionReferences });
    });
    test('an attention answer has one winner, is audited, and is due once at its exact occurrence', async () => {
      const due = async (): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id);
      const cursor = { kind: 'answered' as const, nodeId: 'ask', pauseId: 'ask-1' };
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, attentionWait, {
        kind: 'started',
        stepName: 'ask',
      });
      expect(await due()).not.toContain(run.id);
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-main', 'stale'))).toEqual(
        { answered: false }
      );

      const results = await eight(index =>
        store.answerAttentionWait(run.id, attentionAnswer(index === 0 ? 'use-main' : 'use-dev'))
      );
      expect(results.filter(result => result.answered)).toHaveLength(1);
      const stored = (await store.getWorkflowRun(run.id))?.metadata.wait;
      expect(stored).toMatchObject({ pauseId: 'ask-1', answeredVia: 'cli' });
      const answered = (await store.listWorkflowEvents(run.id)).filter(
        event => event.event_type === 'wait_answered'
      );
      expect(answered).toHaveLength(1);
      expect(answered[0]?.step_name).toBe('ask');
      expect(answered[0]?.data).toMatchObject({ via: 'cli', occurrence: 'ask-1' });
      expect(await due()).toContain(run.id);

      const retryAt = new Date(Date.now() + 3_600_000).toISOString();
      await store.deferWorkflowContinuation(run.id, retryAt, { ...cursor, pauseId: 'other' });
      expect(await due()).toContain(run.id);
      await store.deferWorkflowContinuation(run.id, retryAt, cursor);
      expect(await due()).not.toContain(run.id);

      expect(
        await rejection(store.resumeWorkflowRun(run.id, { ...cursor, pauseId: 'other' }))
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect((await store.resumeWorkflowRun(run.id, cursor)).status).toBe('running');
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-dev'))).toEqual({
        answered: false,
      });
    });
    test('a label write merges, bumps the revision with its audit row, and refuses another pause', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(
        run.id,
        { ...attentionWait, labels: { ci: 'other', keep: 'x' } },
        { kind: 'started', stepName: 'ask' }
      );
      const write = { pauseId: 'ask-1', set: {}, unset: [], via: 'cli' };
      expect(
        await store.labelAttentionWait(run.id, { ...write, pauseId: 'stale', set: { a: '1' } })
      ).toEqual({ labeled: false });

      const result = await store.labelAttentionWait(run.id, {
        ...write,
        set: { ci: 'pr', urgency: 'high' },
        unset: ['keep'],
      });
      expect(result).toMatchObject({
        labeled: true,
        wait: { labels: { ci: 'pr', urgency: 'high' }, revision: 2 },
      });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toMatchObject({
        pauseId: 'ask-1',
        labels: { ci: 'pr', urgency: 'high' },
        revision: 2,
      });
      const audit = (await store.listWorkflowEvents(run.id)).filter(
        event => event.event_type === 'attention_labeled'
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.step_name).toBe('ask');
      expect(audit[0]?.data).toEqual({
        via: 'cli',
        occurrence: 'ask-1',
        set: { ci: 'pr', urgency: 'high' },
        unset: ['keep'],
        revision: 2,
      });

      // Concurrent writes serialize: none is lost, and each commits its own revision.
      const results = await eight(index =>
        store.labelAttentionWait(run.id, { ...write, set: { [`k${String(index)}`]: 'v' } })
      );
      expect(results.every(written => written.labeled)).toBe(true);
      const stored = (await store.getWorkflowRun(run.id))?.metadata.wait;
      expect(stored).toMatchObject({ revision: 10 });
      expect(Object.keys((stored as { labels: object }).labels)).toHaveLength(10);
      const revisions = (await store.listWorkflowEvents(run.id))
        .filter(event => event.event_type === 'attention_labeled')
        .map(event => event.data.revision);
      expect(new Set(revisions).size).toBe(9);

      // An answer adds to the stored wait, so labels written after the answerer read it stay.
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-main'))).toEqual({
        answered: true,
      });
      const answered = (await store.getWorkflowRun(run.id))?.metadata.wait;
      expect(answered).toMatchObject({ answer: { decision: 'use-main' }, revision: 10 });
      expect(Object.keys((answered as { labels: object }).labels)).toHaveLength(10);
      expect(await store.labelAttentionWait(run.id, { ...write, set: { late: 'yes' } })).toEqual({
        labeled: false,
      });
    });
    test('the attention queue lists, scopes, filters, sorts, counts and reads one item', async () => {
      const codebase = await store.getCodebase(CONFORMANCE_CODEBASE_ID);
      expect(codebase).not.toBeNull();
      const registered: ProjectRef = {
        key: projectKeyForCodebase(codebase, codebase?.default_cwd ?? ''),
        codebaseId: CONFORMANCE_CODEBASE_ID,
        name: 'conformance',
      };
      const scratchRoot = join(getArchonWorkspacesPath(), '_cwd', 'scratch');
      const pauseAttention = async (
        minute: number,
        labels: Record<string, string>,
        input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {
          codebase_id: CONFORMANCE_CODEBASE_ID,
        },
        outputRoot?: string
      ): Promise<WorkflowRun> => {
        const run = await running(store, input);
        if (outputRoot !== undefined)
          await store.updateWorkflowRun(run.id, { output_root: outputRoot });
        await store.pauseWorkflowRunForWait(
          run.id,
          {
            ...attentionWait,
            pauseId: `ask-${run.id}`,
            waitingSince: `2026-01-01T00:0${String(minute)}:00.000Z`,
            labels,
          },
          { kind: 'started', stepName: 'ask' }
        );
        return run;
      };
      const a = await pauseAttention(2, { ci: 'other', team: 'web' });
      // Paused before its codebase was renamed: its frozen root keeps the old key.
      const b = await pauseAttention(
        1,
        { ci: 'pr' },
        { codebase_id: CONFORMANCE_CODEBASE_ID },
        join(getArchonWorkspacesPath(), '_cwd', 'old-name')
      );
      const c = await pauseAttention(3, { ci: 'other' }, {}, scratchRoot);
      const gate = await running(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      await store.pauseWorkflowRun(gate.id, approval);
      const parent = await running(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      const child = await pauseAttention(
        4,
        { ci: 'other', team: 'api' },
        {
          codebase_id: CONFORMANCE_CODEBASE_ID,
          parent_run_id: parent.id,
          metadata: { parent_node_id: 'each', child_index: 2 },
        }
      );
      await store.pauseWorkflowRun(parent.id, {
        nodeId: 'each',
        message: 'Waiting on sub-runs',
        type: 'fan_out',
        childRunIds: [child.id],
        unspawnedItems: 0,
      });
      const live = await running(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      const timed = await running(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      await store.pauseWorkflowRunForWait(timed.id, wait, { kind: 'started', stepName: 'wait' });
      const answered = await pauseAttention(5, {});
      await store.answerAttentionWait(
        answered.id,
        attentionAnswer('use-main', `ask-${answered.id}`)
      );

      const source: AttentionQueueSource = {
        store,
        branchOf: async run => (run.id === a.id ? 'feat/a' : null),
      };
      const items = await listAttentionQueue(source);
      const ids = (selected: readonly AttentionQueueItem[]): string[] =>
        selected.map(item => item.runId);
      const select = (
        query: Partial<Parameters<typeof selectAttentionQueue>[1]>
      ): AttentionQueueItem[] =>
        selectAttentionQueue(items, {
          scope: { kind: 'all' },
          labels: {},
          order: { by: 'age' },
          ...query,
        });

      expect(ids(select({}))).toEqual([b.id, a.id, c.id, child.id, gate.id]);
      expect(ids(select({ scope: { kind: 'project', project: registered } }))).toEqual([
        b.id,
        a.id,
        child.id,
        gate.id,
      ]);
      const scratch: ProjectRef = { key: '_cwd/scratch', codebaseId: null, name: 'scratch' };
      expect(ids(select({ scope: { kind: 'project', project: scratch } }))).toEqual([c.id]);
      expect(ids(select({ labels: { ci: 'other' } }))).toEqual([a.id, c.id, child.id]);
      expect(ids(select({ labels: { ci: 'other', team: 'web' } }))).toEqual([a.id]);
      expect(ids(select({ order: { by: 'label', key: 'team' } }))).toEqual([
        child.id,
        a.id,
        b.id,
        c.id,
        gate.id,
      ]);

      const byId = new Map(items.map(item => [item.runId, item]));
      expect(byId.get(a.id)).toMatchObject({
        kind: 'attention',
        workflow: 'conformance',
        project: registered,
        fanOut: null,
        revision: 1,
        labels: { ci: 'other', team: 'web' },
        pausedAt: '2026-01-01T00:02:00.000Z',
        node: 'ask',
        occurrence: `ask-${a.id}`,
        message: 'Which base?',
        form: 'select',
        options: [{ id: 'use-main' }, { id: 'use-dev' }],
        context: { branch: 'feat/a' },
      });
      expect(byId.get(a.id)?.context.transcript).toEndWith(`${a.id}.jsonl`);
      expect(byId.get(b.id)?.project).toEqual({
        key: '_cwd/old-name',
        codebaseId: CONFORMANCE_CODEBASE_ID,
        name: 'conformance',
      });
      expect(byId.get(c.id)?.project).toEqual(scratch);
      expect(byId.get(child.id)?.fanOut).toEqual({
        parentRunId: parent.id,
        nodeId: 'each',
        index: 2,
      });
      expect(byId.get(gate.id)).toMatchObject({
        kind: 'awaiting_response',
        node: 'review',
        occurrence: 'first',
        pausedAt: null,
        labels: {},
        revision: 1,
      });

      expect(
        countAttentionQueue(items, {
          scope: { kind: 'all' },
          labels: {},
          countBy: { by: 'project' },
        })
      ).toEqual({
        by: 'project',
        counts: [
          { project: expect.objectContaining({ codebaseId: CONFORMANCE_CODEBASE_ID }), count: 4 },
          { project: scratch, count: 1 },
        ],
      });
      expect(
        countAttentionQueue(items, {
          scope: { kind: 'all' },
          labels: {},
          countBy: { by: 'label', key: 'ci' },
        })
      ).toEqual({
        by: 'label',
        key: 'ci',
        counts: [
          { value: 'other', count: 3 },
          { value: null, count: 1 },
          { value: 'pr', count: 1 },
        ],
      });

      expect(await readAttentionQueueItem(source, a.id)).toEqual(byId.get(a.id));
      expect(await readAttentionQueueItem(source, parent.id)).toEqual(byId.get(child.id));
      expect(await readAttentionQueueItem(source, live.id)).toBeNull();
      expect(await readAttentionQueueItem(source, crypto.randomUUID())).toBeUndefined();

      await store.labelAttentionWait(a.id, {
        pauseId: `ask-${a.id}`,
        set: { class: 'ci-other' },
        unset: [],
        via: 'cli',
      });
      expect(await readAttentionQueueItem(source, a.id)).toMatchObject({
        revision: 2,
        labels: { ci: 'other', team: 'web', class: 'ci-other' },
      });
    });
    test('a parent blocked on a sub-run with no row is the same unreadable item listed and read', async () => {
      const parent = await running(store);
      const missing = crypto.randomUUID();
      await store.pauseWorkflowRun(parent.id, {
        nodeId: 'each',
        message: 'Waiting on sub-runs',
        type: 'fan_out',
        childRunIds: [missing],
        unspawnedItems: 0,
      });
      const source: AttentionQueueSource = { store, branchOf: async () => null };
      const listed = (await listAttentionQueue(source)).filter(item => item.runId === parent.id);
      expect(listed).toEqual([
        expect.objectContaining({ kind: 'unreadable', reason: 'child_run_missing' }),
      ]);
      expect(await readAttentionQueueItem(source, parent.id)).toEqual(listed[0]);
    });
    test('runs blocked on each other are each the same unreadable item listed and read', async () => {
      const a = await running(store);
      const b = await running(store);
      const blockOn = (id: string, child: string) =>
        store.pauseWorkflowRun(id, {
          nodeId: 'each',
          message: 'Waiting on sub-runs',
          type: 'fan_out',
          childRunIds: [child],
          unspawnedItems: 0,
        });
      await blockOn(a.id, b.id);
      await blockOn(b.id, a.id);
      const source: AttentionQueueSource = { store, branchOf: async () => null };
      const listed = (await listAttentionQueue(source)).filter(
        item => item.runId === a.id || item.runId === b.id
      );
      expect(listed.map(item => item.runId).sort()).toEqual([a.id, b.id].sort());
      for (const item of listed) {
        expect(item).toEqual(
          expect.objectContaining({ kind: 'unreadable', reason: 'child_chain_too_deep' })
        );
        expect(await readAttentionQueueItem(source, item.runId)).toEqual(item);
      }
    });
  });
}
