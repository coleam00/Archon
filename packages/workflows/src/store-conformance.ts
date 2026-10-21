import { describeSourceReleaseConformance } from './store-conformance/source-release';
import { describeRunScratchConformance } from './store-conformance/run-scratch';
import {
  ResourceSlotCapacityConflictError,
  SourceReceiptDigestConflictError,
} from './resource-start-store';
import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
  ResourceStartIntent,
  SourceReceiptAcceptance,
} from './schemas/resource-start';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  FAN_OUT_CANCEL_REASONS,
  executionClaim,
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
  continuablePauseCursor,
  deadlineWaitCursor,
  type PauseCursor,
  WorkflowEventCursorError,
  type WorkflowEventCursor,
  WorkflowRunPauseConflictError,
  type AttentionAnswerWrite,
  type GateResolutionEvent,
  type IWorkflowStore,
} from './store';
import {
  TERMINAL_WORKFLOW_STATUSES,
  approvalContextSchema,
  attentionLabels,
  attentionRevision,
  continuablePause,
  pausedAttentionWait,
  pendingWorkflowWaitDeadline,
  queuedRunAttention,
  readCapacityWait,
  readSourceRelease,
  workflowWaitContextSchema,
  isTerminalRunStatus,
  type ApprovalContext,
  type WorkflowWaitContext,
  type WorkflowRun,
} from './schemas/workflow-run';
import { PAUSE_CAUSE_METADATA_KEY } from './schemas/pause-cause';
import { workflowNodeSessionSchema } from './schemas/workflow-node-session';
import { workflowRunNodeSessionSchema } from './schemas/workflow-run-node-session';
import { terminalRecordSchema } from './schemas/terminal-record';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';
import { runBudgetWorkUnitEvent } from './run-budget';
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
} from './attention-queue';
import { watchAttentionQueue, type AttentionStreamLine } from './attention-watch';

export interface WorkflowStoreHarness {
  store: IWorkflowStore;
  seedPersistedWait(runId: string, wait: Record<string, unknown>): Promise<void>;
  backdate(
    runId: string,
    dates: { started_at?: Date; last_activity_at?: Date | null }
  ): Promise<void>;
  /** A snapshot: tests compare it with a later call to prove no report was emitted. */
  terminalReports(): string[];
  close(): Promise<void>;
}

// Host records referenced by the port's inputs must exist in relational targets.
export const CONFORMANCE_CODEBASE_ID = '00000000-0000-4000-8000-000000003643';
export const CONFORMANCE_CONVERSATION_ID = '00000000-0000-4000-8001-000000003643';
const approval: ApprovalContext = {
  nodeId: 'review',
  message: 'Choose',
  type: 'approval',
  pauseId: 'first',
};
const wait: Extract<WorkflowWaitContext, { kind: 'time' }> = {
  owner: 'node',
  nodeId: 'wait',
  kind: 'time',
  waitingSince: '2026-01-01T00:00:00.000Z',
  resumeAt: '2026-01-02T00:00:00.000Z',
};
const attentionWait: Extract<WorkflowWaitContext, { kind: 'attention' }> = {
  owner: 'node',
  nodeId: 'ask',
  kind: 'attention',
  waitingSince: '2026-01-01T00:00:00.000Z',
  message: 'Which base?',
  pauseId: 'ask-1',
  form: 'select',
  options: [{ id: 'use-main' }, { id: 'use-dev' }],
};
const answeredAttention = (
  answer: string,
  pause: Extract<WorkflowWaitContext, { kind: 'attention' }> = attentionWait
): Extract<WorkflowWaitContext, { kind: 'attention' }> => ({
  ...pause,
  answer: { decision: answer, text: '' },
  answeredVia: 'cli',
  answeredAt: '2026-01-01T00:05:00.000Z',
});
const attentionAnswer = (decision: string, pauseId = 'ask-1'): AttentionAnswerWrite => ({
  pauseId,
  answer: { decision, text: '' },
  answeredVia: 'cli',
  answeredAt: '2026-01-01T00:05:00.000Z',
});
const schedule = {
  reason: 'quota' as const,
  attempt: 1,
  maxAttempts: 3,
  resumeAt: wait.resumeAt,
  deadlineAt: '2026-01-03T00:00:00.000Z',
};
/** Fail a run as an older binary did, with its quota schedule; this binary only reads one. */
async function failWithSchedule(
  store: Pick<IWorkflowStore, 'failWorkflowRun' | 'updateWorkflowRun'>,
  id: string
): Promise<void> {
  await store.failWorkflowRun(id, 'quota');
  await store.updateWorkflowRun(id, { metadata: { scheduled_resume: schedule } });
}
const eight = <T>(call: (index: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: 8 }, (_, index) => call(index)));
const create = (
  store: Pick<IWorkflowStore, 'createWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> =>
  store.createWorkflowRun({ workflow_name: 'conformance', user_message: 'test', ...input });
async function running(
  store: Pick<IWorkflowStore, 'createWorkflowRun' | 'claimPendingWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> {
  const run = await create(store, input);
  const claimed = await store.claimPendingWorkflowRun(run.id);
  expect(claimed?.status).toBe('running');
  return run;
}
const types = async (
  store: Pick<IWorkflowStore, 'listWorkflowEvents'>,
  id: string
): Promise<string[]> => (await store.listWorkflowEvents(id)).map(event => event.event_type);
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the store operation to reject');
}
const gateEvents = (index: number): GateResolutionEvent[] => [
  {
    event_type: 'approval_received',
    step_name: 'review',
    data: { winner: index },
  },
  { event_type: 'node_completed', step_name: 'review', data: { node_output: String(index) } },
];

export async function assertWorkflowClaimRace(
  store: Pick<
    IWorkflowStore,
    'createWorkflowRun' | 'claimPendingWorkflowRun' | 'getWorkflowRun' | 'listWorkflowEvents'
  >
): Promise<void> {
  const run = await create(store);
  const results = await eight(() => store.claimPendingWorkflowRun(run.id, '/checkout'));
  expect(results.filter(result => result !== null)).toHaveLength(1);
  expect(results.filter(result => result === null)).toHaveLength(7);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'running',
    working_path: '/checkout',
  });
  expect(await store.claimPendingWorkflowRun(run.id)).toBeNull();
  expect(await types(store, run.id)).toEqual([]);
}

export async function assertWorkflowGateRace(
  store: Pick<
    IWorkflowStore,
    | 'createWorkflowRun'
    | 'claimPendingWorkflowRun'
    | 'getWorkflowRun'
    | 'listWorkflowEvents'
    | 'pauseWorkflowRun'
    | 'resolveApprovalGate'
  >
): Promise<void> {
  const run = await running(store);
  await store.pauseWorkflowRun(run.id, approval);
  const results = await eight(index =>
    store.resolveApprovalGate(
      run.id,
      {
        approval: { ...approval, resolved: 'approved' },
        winner: index,
      },
      gateEvents(index),
      { nodeId: approval.nodeId, pauseId: 'first' }
    )
  );
  expect(results.filter(result => result.resolved)).toHaveLength(1);
  expect(results.filter(result => !result.resolved)).toHaveLength(7);
  const winner = results.findIndex(result => result.resolved);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'paused',
    metadata: { winner },
  });
  const rows = await store.listWorkflowEvents(run.id);
  expect(rows.map(event => event.event_type)).toEqual(['approval_received', 'node_completed']);
  expect(rows[0]?.data).toEqual({ winner });
  expect(rows[1]?.data).toEqual({ node_output: String(winner) });
}

export async function assertWorkflowEventFeedRace(
  store: Pick<
    IWorkflowStore,
    | 'createWorkflowRun'
    | 'createWorkflowEvent'
    | 'listWorkflowEvents'
    | 'getWorkflowEventHead'
    | 'readWorkflowEventsAfter'
  >
): Promise<void> {
  const run = await create(store);
  let cursor = await store.getWorkflowEventHead();
  const seen: string[] = [];
  let finished = false;
  const writes = eight(index =>
    store.createWorkflowEvent({
      workflow_run_id: run.id,
      event_type: 'workflow_started',
      data: { index },
    })
  ).finally(() => {
    finished = true;
  });
  do {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
    await new Promise(resolve => setTimeout(resolve, 0));
  } while (!finished);
  await writes;
  for (;;) {
    const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
    if (page.next === cursor) break;
    seen.push(...page.events.map(({ event }) => event.id));
    cursor = page.next;
  }
  const committed = await store.listWorkflowEvents(run.id);
  expect(committed).toHaveLength(8);
  expect(seen.sort()).toEqual(committed.map(event => event.id).sort());
}

export function describeWorkflowStoreConformance(
  label: string,
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  describe(`workflow store conformance: ${label}`, () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(async () => {
      harness = await makeHarness();
      store = harness.store;
    });
    afterEach(async () => {
      await harness?.close();
    });

    test.each(['paused', 'completed', 'failed', 'cancelled'] as const)(
      'running metadata write refuses a run that became %s after observation',
      async status => {
        const run = await running(store, { metadata: { preserved: true } });
        expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
        if (status === 'paused') await store.updateWorkflowRun(run.id, { status });
        else if (status === 'completed')
          await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        else if (status === 'failed') await store.failWorkflowRun(run.id, 'failure');
        else await store.cancelWorkflowRun(run.id);
        const before = await store.getWorkflowRun(run.id);
        expect(
          await store.updateWorkflowRunMetadataIfRunning(run.id, { end_turn_request: {} })
        ).toBe(false);
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
      }
    );

    test('running metadata write merges only into a running run', async () => {
      const pending = await create(store);
      expect(await store.updateWorkflowRunMetadataIfRunning(pending.id, { request: true })).toBe(
        false
      );
      expect(
        await store.updateWorkflowRunMetadataIfRunning(crypto.randomUUID(), { request: true })
      ).toBe(false);
      const run = await running(store, { metadata: { preserved: true } });
      expect(await store.updateWorkflowRunMetadataIfRunning(run.id, { request: true })).toBe(true);
      expect((await store.getWorkflowRun(run.id))?.metadata).toMatchObject({
        preserved: true,
        request: true,
      });
    });

    type Lane = PreparedWorkflowLaunch['execution']['isolation'];
    /** Each launch runs in a checkout of its own unless `checkout` names a shared one. */
    const launch = (
      id = crypto.randomUUID(),
      checkout: { cwd?: string; isolation?: Lane } = {}
    ): PreparedWorkflowLaunch => ({
      version: 2,
      run: {
        id,
        workflow_name: 'conformance',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        user_message: '',
        metadata: {},
      },
      execution: {
        cwd: checkout.cwd ?? `/conformance/${id}`,
        conversationId: CONFORMANCE_CONVERSATION_ID,
        isolation: checkout.isolation ?? { kind: 'in-place' },
      },
    });
    const start = (
      overlap: 'queue' | 'skip' = 'queue',
      hostId = 'host',
      capacity = 1,
      checkout?: { cwd?: string; isolation?: Lane }
    ): ResourceStartIntent => ({
      resource: 'resource',
      capacity,
      hostId,
      overlap,
      launch: launch(undefined, checkout),
    });
    const binding: ResourceStartBindingIntent = {
      bindingId: 'binding',
      bindingRevision: 'v1',
      hostId: 'host',
      runAsUserId: 'operator',
      resource: 'resource',
      capacity: 1,
      overlap: 'queue',
      launch: {
        cwd: '/conformance',
        workflowName: 'conformance',
        inputs: {},
        isolation: { kind: 'in-place' },
      },
    };
    const acceptance = (): SourceReceiptAcceptance => ({
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: 'source',
        deliveryId: 'delivery',
        contentDigest: 'digest',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched' as const,
      bindings: [binding] as [ResourceStartBindingIntent],
    });
    test('admission races keep capacity and persist only admitted runs', async () => {
      const intents = Array.from({ length: 8 }, () => start());
      const decisions = await Promise.all(
        intents.map(intent => harness.store.admitResourceStart(intent))
      );
      expect(decisions.filter(row => row.status === 'admitted')).toHaveLength(1);
      expect(decisions.filter(row => row.status === 'queued')).toHaveLength(7);
      for (const [index, intent] of intents.entries()) {
        expect((await harness.store.getWorkflowRun(intent.launch.run.id))?.status ?? null).toBe(
          decisions[index]?.status === 'admitted' ? 'pending' : null
        );
        expect(await harness.store.admitResourceStart(intent)).toEqual(decisions[index]);
      }
      expect(
        await rejection(harness.store.admitResourceStart(start('queue', 'host', 2)))
      ).toBeInstanceOf(ResourceSlotCapacityConflictError);
    });
    for (const activity of ['null', 'stale'] as const) {
      test(`admitted running runs cannot resume with ${activity} activity`, async () => {
        const intent = start();
        const id = intent.launch.run.id;
        await store.admitResourceStart(intent);
        await store.updateWorkflowRun(id, { status: 'running' });
        await harness.backdate(id, {
          last_activity_at: activity === 'null' ? null : new Date('2020-01-01T00:00:00Z'),
        });
        const before = await store.getWorkflowRun(id);
        expect(before?.last_activity_at).toEqual(
          activity === 'null' ? null : new Date('2020-01-01T00:00:00Z')
        );
        const events = await store.listWorkflowEvents(id);
        expect(await rejection(store.resumeWorkflowRun(id))).toBeInstanceOf(
          WorkflowNotResumableError
        );
        expect(await store.getWorkflowRun(id)).toEqual(before);
        expect(await store.listWorkflowEvents(id)).toEqual(events);
      });
    }
    test('a failed admitted run cannot resume past a new holder or a queued promise', async () => {
      const first = start(),
        holder = start(),
        queued = start();
      const id = first.launch.run.id;
      await store.admitResourceStart(first);
      await store.updateWorkflowRun(id, { status: 'running' });
      await store.failWorkflowRun(id, 'failed');
      // The failed run released its slot; a queued promise is ahead of its resume.
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
      expect(await rejection(store.resumeWorkflowRun(id))).toMatchObject({
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      await store.updateWorkflowRun(holder.launch.run.id, { status: 'running' });
      await store.failWorkflowRun(holder.launch.run.id, 'failed');
      expect(await rejection(store.resumeWorkflowRun(id))).toMatchObject({
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect((await store.getWorkflowRun(id))?.status).toBe('failed');
    });
    const gateCursor: PauseCursor = { kind: 'pause', nodeId: 'review', pauseId: 'first' };
    const admitPaused = async (intent: ResourceStartIntent): Promise<string> => {
      expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
      const id = intent.launch.run.id;
      await store.claimPendingWorkflowRun(id);
      await store.pauseWorkflowRun(id, approval);
      return id;
    };
    const end = async (id: string): Promise<void> => {
      await store.claimPendingWorkflowRun(id);
      await store.completeWorkflowRun(id, { duration_ms: 1 });
    };
    const drain = (): ReturnType<IWorkflowStore['drainResourceStarts']> =>
      store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
    const answeredCursor = {
      kind: 'answered' as const,
      nodeId: approval.nodeId,
      pauseId: 'first',
    };
    /** Answers the gate and makes the continuation host's claim of the answered pause. */
    const claimAnswered = async (id: string): Promise<WorkflowRun> => {
      await store.resolveApprovalGate(id, { approval: { ...approval, resolved: 'approved' } }, []);
      return store.resumeWorkflowRun(id, answeredCursor);
    };
    test('a released paused run waits for capacity ahead of queued new starts', async () => {
      const a = await admitPaused(start());
      const b = start(),
        c = start();
      expect(await store.admitResourceStart(b)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: a },
      });
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: b.launch.run.id, runId: b.launch.run.id },
      ]);
      const refusal = await rejection(claimAnswered(a));
      expect(refusal).toBeInstanceOf(WorkflowResourceBusyError);
      expect(refusal).toMatchObject({
        blocker: { kind: 'run', id: b.launch.run.id },
        refusal: 'waiting',
      });
      const waiting = await store.getWorkflowRun(a);
      expect(waiting?.status).toBe('paused');
      const since = readCapacityWait(waiting?.metadata);
      expect(since).toBeDefined();
      await rejection(store.resumeWorkflowRun(a, answeredCursor));
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toEqual(since);
      // A release that removes nothing leaves the waiter's place intact.
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toEqual(since);
      // The waiter counts against capacity, so the new start queues behind the holder.
      expect(await store.admitResourceStart(c)).toMatchObject({ status: 'queued' });
      await end(b.launch.run.id);
      expect(await drain()).toEqual([]);
      expect((await store.resumeWorkflowRun(a, answeredCursor)).status).toBe('running');
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toBeUndefined();
      expect(await drain()).toEqual([]);
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: c.launch.run.id },
      ]);
    });
    test('an early resume of a released pause does not hold capacity', async () => {
      const a = await admitPaused(start());
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(store.resumeWorkflowRun(a))).toMatchObject({
        blocker: { kind: 'run', id: holder.launch.run.id },
        refusal: 'paused',
      });
      const refused = await store.getWorkflowRun(a);
      expect(refused?.status).toBe('paused');
      expect(readCapacityWait(refused?.metadata)).toBeUndefined();
      await end(holder.launch.run.id);
      expect(await store.admitResourceStart(start())).toMatchObject({ status: 'admitted' });
      expect(await drain()).toEqual([]);
    });
    test('a refused resume of a ready pause keeps its place without a cursor', async () => {
      const notDue = { ...wait, resumeAt: '2999-01-01T00:00:00.000Z' };
      const event: Extract<WorkflowWaitContext, { kind: 'event' }> = {
        ...notDue,
        kind: 'event',
        event: 'ready',
      };
      const pauseAt = async (
        pause: 'answered' | 'due' | 'signaled' | 'not-due'
      ): Promise<string> => {
        const intent = start();
        expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
        const id = intent.launch.run.id;
        await store.claimPendingWorkflowRun(id);
        if (pause === 'answered') {
          await store.pauseWorkflowRun(id, approval);
          await store.releasePausedRunSlot(id, gateCursor);
          await store.resolveApprovalGate(
            id,
            { approval: { ...approval, resolved: 'approved' } },
            []
          );
          return id;
        }
        const pending = pause === 'due' ? wait : pause === 'signaled' ? event : notDue;
        await store.pauseWorkflowRunForWait(id, pending, { kind: 'started', stepName: 'wait' });
        await store.releasePausedRunSlot(id, {
          kind: 'wait',
          nodeId: pending.nodeId,
          resumeAt: pending.resumeAt,
        });
        // A signal leaves the deadline in the future; the run is ready all the same.
        if (pause === 'signaled')
          expect(await store.signalWorkflowWait(id, event, {})).toEqual({ signaled: true });
        return id;
      };
      for (const pause of ['answered', 'due', 'signaled', 'not-due'] as const) {
        const a = await pauseAt(pause);
        const holder = start();
        expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
        const ready = pause !== 'not-due';
        // Answer surfaces (API, CLI, chat) resume without the host's cursor.
        expect(await rejection(store.resumeWorkflowRun(a))).toMatchObject({
          refusal: ready ? 'waiting' : 'paused',
        });
        expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata) !== undefined).toBe(
          ready
        );
        const later = start();
        expect(await store.admitResourceStart(later)).toMatchObject({ status: 'queued' });
        await end(holder.launch.run.id);
        expect(await drain()).toHaveLength(ready ? 0 : 1);
        if (ready) {
          expect((await store.resumeWorkflowRun(a)).status).toBe('running');
          await store.completeWorkflowRun(a, { duration_ms: 1 });
          expect(await drain()).toHaveLength(1);
        } else await store.cancelWorkflowRun(a);
        await end(later.launch.run.id);
      }
    });
    test('a cancelled capacity waiter stops counting against capacity', async () => {
      const a = await admitPaused(start());
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(a))).toMatchObject({ refusal: 'waiting' });
      await end(holder.launch.run.id);
      expect(await store.cancelWorkflowRun(a)).toEqual({ cancelled: true });
      expect(await store.admitResourceStart(start())).toMatchObject({ status: 'admitted' });
      expect(await drain()).toEqual([]);
    });
    test('a start on a checkout a paused run holds keeps its place while the slot goes on', async () => {
      const shared = { cwd: '/conformance/shared' };
      const paused = await admitPaused(start('queue', 'host', 1, shared));
      const first = start('queue', 'host', 1, shared),
        other = start(),
        later = start('queue', 'host', 1, shared);
      for (const intent of [first, other, later])
        expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'queued' });
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: other.launch.run.id, runId: other.launch.run.id },
      ]);
      expect(await store.getWorkflowRun(first.launch.run.id)).toBeNull();
      await end(other.launch.run.id);
      // A new start that would fail the path lock is skipped behind the paused run.
      expect(await store.admitResourceStart(start('skip', 'host', 1, shared))).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'run', id: paused },
      });
      // The free slot still passes over the held checkout.
      expect(await drain()).toEqual([]);
      expect(await store.cancelWorkflowRun(paused)).toEqual({ cancelled: true });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: first.launch.run.id, runId: first.launch.run.id },
      ]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: later.launch.run.id },
      ]);
    });
    test('a start waits for its checkout until the run holding it ends, at any capacity', async () => {
      const shared = { cwd: '/conformance/shared' };
      const paused = await admitPaused(start('queue', 'host', 2, shared));
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      const first = start('queue', 'host', 2, shared);
      expect(await store.admitResourceStart(first)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: paused },
      });
      expect((await claimAnswered(paused)).status).toBe('running');
      const second = start('queue', 'host', 2, shared);
      expect(await store.admitResourceStart(second)).toMatchObject({ status: 'queued' });
      // A slot is free, but the continued run still holds the checkout.
      expect(await drain()).toEqual([]);
      await end(paused);
      // One drain admits one start per checkout.
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: first.launch.run.id, runId: first.launch.run.id },
      ]);
      await end(first.launch.run.id);
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: second.launch.run.id, runId: second.launch.run.id },
      ]);
    });
    test('an explicit worktree branch is one checkout; a lane without one never shares', async () => {
      const lane = { isolation: { kind: 'worktree' as const, branch: 'lane' } };
      const paused = await admitPaused(start('queue', 'host', 1, lane));
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      expect(await store.admitResourceStart(start('queue', 'host', 1, lane))).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: paused },
      });
      expect(
        await store.admitResourceStart(
          start('queue', 'host', 1, { isolation: { kind: 'worktree' } })
        )
      ).toMatchObject({ status: 'admitted' });
    });
    test('capacity waiters keep their refusal order and block a failed run resume', async () => {
      const first = await admitPaused(start());
      await store.releasePausedRunSlot(first, gateCursor);
      const second = await admitPaused(start());
      await store.releasePausedRunSlot(second, gateCursor);
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      const holderId = holder.launch.run.id;
      for (const id of [first, second]) {
        expect(await rejection(claimAnswered(id))).toMatchObject({
          blocker: { kind: 'run', id: holderId },
        });
        await Bun.sleep(2);
      }
      await store.claimPendingWorkflowRun(holderId);
      await store.failWorkflowRun(holderId, 'failed');
      expect(await rejection(store.resumeWorkflowRun(second, answeredCursor))).toMatchObject({
        blocker: { kind: 'run', id: first },
      });
      expect(await rejection(store.resumeWorkflowRun(holderId))).toMatchObject({
        blocker: { kind: 'run', id: first },
        refusal: 'failed',
      });
      expect((await store.resumeWorkflowRun(first, answeredCursor)).status).toBe('running');
      expect(await rejection(store.resumeWorkflowRun(second, answeredCursor))).toMatchObject({
        blocker: { kind: 'run', id: first },
      });
    });
    test('a failed run resumes beside a capacity waiter while a slot is free', async () => {
      const failed = start('queue', 'host', 3);
      const failedId = failed.launch.run.id;
      await store.admitResourceStart(failed);
      await store.updateWorkflowRun(failedId, { status: 'running' });
      await store.failWorkflowRun(failedId, 'failed');
      const waiter = await admitPaused(start('queue', 'host', 3));
      await store.releasePausedRunSlot(waiter, gateCursor);
      const holders = Array.from({ length: 3 }, () => start('queue', 'host', 3));
      for (const holder of holders)
        expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(waiter))).toMatchObject({ refusal: 'waiting' });
      for (const holder of holders) await end(holder.launch.run.id);
      // No holders and one waiter leave two of three slots free.
      expect((await store.resumeWorkflowRun(failedId)).status).toBe('running');
      expect(await store.admitResourceStart(start('queue', 'host', 3))).toMatchObject({
        status: 'admitted',
      });
    });
    test('a failed run does not resume into the slot a capacity waiter fills', async () => {
      const failed = start();
      const failedId = failed.launch.run.id;
      await store.admitResourceStart(failed);
      await store.updateWorkflowRun(failedId, { status: 'running' });
      await store.failWorkflowRun(failedId, 'failed');
      const waiter = await admitPaused(start());
      await store.releasePausedRunSlot(waiter, gateCursor);
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(waiter))).toMatchObject({ refusal: 'waiting' });
      await end(holder.launch.run.id);
      // No holders and one waiter fill the only slot.
      expect(await rejection(store.resumeWorkflowRun(failedId))).toMatchObject({
        blocker: { kind: 'run', id: waiter },
        refusal: 'failed',
      });
      expect((await claimAnswered(waiter)).status).toBe('running');
    });
    for (const kind of ['time', 'event'] as const) {
      for (const owner of ['node', 'loop_group'] as const) {
        for (const legacy of [false, true]) {
          test(`a delayed deadline release cannot remove a later occurrence with the same deadline (${kind}, ${owner}, legacy=${legacy})`, async () => {
            const intent = start();
            expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
            const id = intent.launch.run.id;
            await store.claimPendingWorkflowRun(id);
            const owned =
              owner === 'loop_group'
                ? {
                    ...wait,
                    owner,
                    bodyWaitId: 'body-wait',
                    iteration: 1,
                    sessionId: null,
                    sessionProvider: null,
                  }
                : wait;
            const context = kind === 'event' ? { ...owned, kind, event: 'ready' } : owned;
            const first = { ...context, ...(legacy ? {} : { pauseId: 'first-wait' }) };
            const second = { ...context, pauseId: 'second-wait' };
            const cursor = {
              kind: 'wait' as const,
              nodeId: first.nodeId,
              resumeAt: first.resumeAt,
              pauseId: first.pauseId,
            };
            await store.pauseWorkflowRunForWait(id, first, { kind: 'started', stepName: 'wait' });
            expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
            await store.resumeWorkflowRun(id, cursor);
            await store.clearWorkflowWaitContext(id, first, {
              stepName: 'wait',
              result: { status: 'satisfied', waited_ms: 0 },
            });
            await store.pauseWorkflowRunForWait(id, second, { kind: 'started', stepName: 'wait' });
            expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
            expect(await rejection(store.resumeWorkflowRun(id, cursor))).toBeInstanceOf(
              WorkflowNotResumableError
            );
            const legacyCursor = {
              kind: 'wait' as const,
              nodeId: wait.nodeId,
              resumeAt: wait.resumeAt,
            };
            expect(await store.releasePausedRunSlot(id, legacyCursor)).toEqual({ released: false });
            expect(await rejection(store.resumeWorkflowRun(id, legacyCursor))).toBeInstanceOf(
              WorkflowNotResumableError
            );
            await store.deferWorkflowContinuation(id, schedule.deadlineAt, cursor);
            expect(
              (await store.getWorkflowRun(id))?.metadata.continuation_retry_at
            ).toBeUndefined();
            expect(await store.admitResourceStart(start())).toMatchObject({
              status: 'queued',
              blocker: { kind: 'run', id },
            });
            const secondCursor = { ...cursor, pauseId: second.pauseId };
            await store.deferWorkflowContinuation(id, schedule.deadlineAt, secondCursor);
            expect((await store.getWorkflowRun(id))?.metadata.continuation_retry_at).toBe(
              schedule.deadlineAt
            );
            await store.resumeWorkflowRun(id, secondCursor);
            const completion = {
              stepName: 'wait',
              result: { status: 'satisfied' as const, waited_ms: 0 },
            };
            expect(await store.clearWorkflowWaitContext(id, first, completion)).toEqual({
              cleared: false,
            });
            expect(await store.clearWorkflowWaitContext(id, wait, completion)).toEqual({
              cleared: false,
            });
            expect(await store.clearWorkflowWaitContext(id, second, completion)).toMatchObject({
              cleared: true,
            });
            await store.pauseWorkflowRunForWait(id, second, { kind: 'continued' });
            expect(await store.releasePausedRunSlot(id, secondCursor)).toEqual({ released: true });
          });
        }
      }
    }
    test('a delayed release cannot remove a later usage-limit wait with the same reset', async () => {
      const intent = start();
      expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
      const id = intent.launch.run.id;
      await store.claimPendingWorkflowRun(id);
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'first-limit',
        waitingSince: wait.waitingSince,
        resumeAt: wait.resumeAt,
      };
      const cursor = deadlineWaitCursor(limit);
      await store.pauseWorkflowRunForWait(id, limit, { kind: 'started', stepName: limit.nodeId });
      expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
      await store.resumeWorkflowRun(id, cursor);
      const again = { ...limit, pauseId: 'second-limit' };
      await store.pauseWorkflowRunForWait(id, again, { kind: 'started', stepName: again.nodeId });
      expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
      expect(await rejection(store.resumeWorkflowRun(id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      expect(await store.releasePausedRunSlot(id, deadlineWaitCursor(again))).toEqual({
        released: true,
      });
    });
    test('release refuses another pause and a run that holds no slot', async () => {
      const id = await admitPaused(start());
      for (const cursor of [
        { ...gateCursor, pauseId: 'other' },
        { ...gateCursor, nodeId: 'other' },
        { kind: 'wait' as const, nodeId: 'review', resumeAt: wait.resumeAt },
      ])
        expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
      expect(await store.admitResourceStart(start())).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id },
      });
      const plain = await running(store);
      await store.pauseWorkflowRun(plain.id, approval);
      expect(await store.releasePausedRunSlot(plain.id, gateCursor)).toEqual({ released: false });
      expect((await store.getWorkflowRun(plain.id))?.status).toBe('paused');
    });
    test('a paused run that kept its slot resumes ahead of queued new starts', async () => {
      const id = await admitPaused(start());
      const queued = start();
      expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
      expect((await store.resumeWorkflowRun(id)).status).toBe('running');
      expect(await drain()).toEqual([]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: queued.launch.run.id },
      ]);
    });
    for (const { name, timestamps } of [
      {
        name: 'mixed fractional precision',
        timestamps: ['2026-01-02T00:00:00.500Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00.5Z'],
      },
      {
        name: 'submillisecond precision',
        timestamps: [
          '2026-01-02T00:00:00.0002Z',
          '2026-01-02T00:00:00.0001Z',
          '2026-01-02T00:00:00.000200Z',
        ],
      },
      {
        name: 'optional seconds',
        timestamps: [
          '2026-01-02T00:00:00.001Z',
          '2026-01-02T00:00Z',
          '2026-01-02T00:00:00.001000Z',
        ],
      },
      {
        name: 'equal zero fractions',
        timestamps: ['2026-01-02T00:00Z', '2026-01-01T23:59:59.9999Z', '2026-01-02T00:00:00.0000Z'],
      },
    ]) {
      test(`receipt listing orders ${name} by newest instant then ID before limiting`, async () => {
        const receipts = timestamps.map((receivedAt, index) => ({
          id: `00000000-0000-4000-8000-00000000000${String([2, 3, 1][index])}`,
          receivedAt,
        }));
        for (const receipt of receipts) {
          const input = acceptance();
          await store.acceptStartReceipt({
            ...input,
            receipt: { ...input.receipt, ...receipt, deliveryId: receipt.id },
          });
        }
        expect((await store.listStartReceipts()).map(row => row.id)).toEqual([
          receipts[0].id,
          receipts[2].id,
          receipts[1].id,
        ]);
        expect((await store.listStartReceipts(2)).map(row => row.id)).toEqual([
          receipts[0].id,
          receipts[2].id,
        ]);
      });
    }
    test('capacity admits multiple holders and drain fills every released slot in FIFO order', async () => {
      const intents = Array.from({ length: 5 }, () => start('queue', 'host', 2));
      const decisions = [];
      for (const intent of intents) decisions.push(await store.admitResourceStart(intent));
      expect(decisions.map(row => row.status)).toEqual([
        'admitted',
        'admitted',
        'queued',
        'queued',
        'queued',
      ]);
      for (const input of intents.slice(0, 2)) await store.cancelWorkflowRun(input.launch.run.id);
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual(
        intents.slice(2, 4).map(input => ({
          status: 'admitted',
          requestId: input.launch.run.id,
          runId: input.launch.run.id,
        }))
      );
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: intents[4].launch.run.id },
      ]);
    });
    test('admission keeps FIFO across hosts, skips overlap and withdraws queued work', async () => {
      const store = harness.store;
      const owner = start(),
        queued = start('queue', 'other'),
        later = start(),
        skipped = start('skip');
      await store.admitResourceStart(owner);
      expect(await store.admitResourceStart(queued)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: owner.launch.run.id },
      });
      expect(await store.admitResourceStart(later)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect(await store.admitResourceStart(skipped)).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect(await store.getWorkflowRun(skipped.launch.run.id)).toBeNull();
      await store.claimPendingWorkflowRun(owner.launch.run.id);
      await store.completeWorkflowRun(owner.launch.run.id, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
      expect(await store.withdrawQueuedResourceStart(queued.launch.run.id)).toEqual(queued.launch);
      expect(await store.withdrawQueuedResourceStart(queued.launch.run.id)).toBeNull();
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([
        { status: 'admitted', requestId: later.launch.run.id, runId: later.launch.run.id },
      ]);
      expect(await store.listQueuedResourceStartsForHost('host')).toEqual([]);
    });
    test('receipt deduplication compares verified content and preparation has one owner', async () => {
      const store = harness.store,
        input = acceptance();
      expect(await store.acceptStartReceipt(input)).toEqual({
        receiptId: input.receipt.id,
        replay: false,
      });
      expect(
        await store.acceptStartReceipt({
          ...input,
          receipt: { ...input.receipt, id: crypto.randomUUID() },
        })
      ).toEqual({ receiptId: input.receipt.id, replay: true });
      expect(
        await rejection(
          store.acceptStartReceipt({
            ...input,
            receipt: { ...input.receipt, id: crypto.randomUUID(), contentDigest: 'different' },
          })
        )
      ).toBeInstanceOf(SourceReceiptDigestConflictError);
      const owners = await eight(index =>
        store.claimStartBindingPreparation({
          receiptId: input.receipt.id,
          bindingId: binding.bindingId,
          ownerId: String(index),
        })
      );
      expect(owners.filter(Boolean)).toHaveLength(1);
      const ownerId = String(owners.indexOf(true));
      const identity = { receiptId: input.receipt.id, bindingId: binding.bindingId, ownerId };
      const prepared = launch();
      expect(
        await store.completeStartBindingPreparation({
          ...identity,
          ownerId: 'stale',
          launch: prepared,
        })
      ).toBeNull();
      const result = await store.completeStartBindingPreparation({ ...identity, launch: prepared });
      expect(result).toEqual({
        status: 'admitted',
        requestId: prepared.run.id,
        runId: prepared.run.id,
      });
      expect(
        await store.completeStartBindingPreparation({ ...identity, launch: launch() })
      ).toBeNull();
      expect(await store.getStartReceipt(input.receipt.id)).toMatchObject({
        bindings: [{ status: 'complete', requestStatus: 'admitted', disposition: result }],
      });
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toEqual([]);
    });
    test('delivery lookup answers only for the recorded source and delivery', async () => {
      const input = acceptance();
      expect(await store.hasStartReceiptForDelivery('source', 'delivery')).toBe(false);
      await store.acceptStartReceipt(input);
      await store.acceptStartReceipt({
        ...input,
        receipt: { ...input.receipt, id: crypto.randomUUID(), deliveryId: null },
      });
      expect(await store.hasStartReceiptForDelivery('source', 'delivery')).toBe(true);
      expect(await store.hasStartReceiptForDelivery('source', 'other-delivery')).toBe(false);
      expect(await store.hasStartReceiptForDelivery('other-source', 'delivery')).toBe(false);
    });
    test('preparation failure and reset require the exact current owner', async () => {
      const store = harness.store,
        input = acceptance();
      await store.acceptStartReceipt(input);
      const identity = {
        receiptId: input.receipt.id,
        bindingId: binding.bindingId,
        ownerId: 'owner',
      };
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      expect(await store.resetStartBindingPreparation({ ...identity, ownerId: 'stale' })).toBe(
        false
      );
      expect(
        await store.failStartBindingPreparation({ ...identity, retryable: true, error: 'retry' })
      ).toBe(true);
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toMatchObject([
        { status: 'failed', error: 'retry' },
      ]);
      expect(await store.claimStartBindingPreparation({ ...identity, ownerId: 'next' })).toBe(true);
      expect(await store.resetStartBindingPreparation(identity)).toBe(false);
      expect(await store.resetStartBindingPreparation({ ...identity, ownerId: 'next' })).toBe(true);
      expect(await store.claimStartBindingPreparation(identity)).toBe(true);
      expect(
        await store.failStartBindingPreparation({
          ...identity,
          retryable: false,
          error: 'rejected',
        })
      ).toBe(true);
      expect(await store.listPendingStartBindings({ hostId: 'host' })).toEqual([]);
    });

    test('feed starts at the head and pages interleaved runs once in commit order', async () => {
      const empty = await store.getWorkflowEventHead();
      expect(await store.readWorkflowEventsAfter(empty, { limit: 1 })).toEqual({
        events: [],
        next: empty,
      });
      const a = await create(store),
        b = await create(store);
      const writes = [a, b, a, b];
      for (const [index, run] of writes.entries())
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
          data: { index },
        });
      const full = await store.readWorkflowEventsAfter(empty, { limit: 10 });
      expect(full.events.map(({ event }) => event.data.index)).toEqual([0, 1, 2, 3]);
      const persisted = [
        ...(await store.listWorkflowEvents(a.id)),
        ...(await store.listWorkflowEvents(b.id)),
      ].sort((a, b) => Number(a.data.index) - Number(b.data.index));
      expect(full.events.map(({ event }) => event)).toEqual(persisted);
      let cursor = empty;
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const page = await store.readWorkflowEventsAfter(cursor, { limit: 1 });
        expect(page.events).toHaveLength(1);
        ids.push(...page.events.map(({ event }) => event.id));
        cursor = page.next;
      }
      expect(ids).toEqual(full.events.map(({ event }) => event.id));
      expect((await store.readWorkflowEventsAfter(cursor, { limit: 1 })).events).toEqual([]);
      expect(
        (await store.readWorkflowEventsAfter(await store.getWorkflowEventHead(), { limit: 1 }))
          .events
      ).toEqual([]);
    });
    test('feed keeps gate events adjacent and advances past filtered rows', async () => {
      const run = await running(store);
      const head = await store.getWorkflowEventHead();
      for (let index = 0; index < 3; index++)
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'workflow_started',
        });
      await store.pauseWorkflowRun(run.id, approval);
      await store.resolveApprovalGate(
        run.id,
        { approval: { ...approval, resolved: 'approved' } },
        gateEvents(0)
      );
      const page = await store.readWorkflowEventsAfter(head, {
        limit: 10,
        eventTypes: ['approval_received', 'node_completed'],
      });
      expect(page.events.map(({ event }) => event.event_type)).toEqual([
        'approval_received',
        'node_completed',
      ]);
      expect((await store.readWorkflowEventsAfter(page.next, { limit: 10 })).events).toEqual([]);
      const skipped = await store.readWorkflowEventsAfter(head, {
        limit: 3,
        eventTypes: ['node_completed'],
      });
      expect(skipped.events).toEqual([]);
      expect(skipped.next).not.toBe(head);
      expect(
        (await store.readWorkflowEventsAfter(skipped.next, { limit: 10 })).events.map(
          ({ event }) => event.event_type
        )
      ).toEqual(['approval_received', 'node_completed']);
    });
    test('feed pages a single commit spanning multiple runs without overlapping positions', async () => {
      const first = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      const second = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.pauseWorkflowRun(first.id, approval);
      await store.pauseWorkflowRun(second.id, approval);
      const head = await store.getWorkflowEventHead();
      await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
      const a = await store.readWorkflowEventsAfter(head, { limit: 1 });
      const b = await store.readWorkflowEventsAfter(a.next, { limit: 1 });
      expect(a.events).toHaveLength(1);
      expect(b.events).toHaveLength(1);
      expect(a.events[0]?.cursor).not.toBe(b.events[0]?.cursor);
      expect(
        [a.events[0]?.event.workflow_run_id, b.events[0]?.event.workflow_run_id].sort()
      ).toEqual([first.id, second.id].sort());
      expect((await store.readWorkflowEventsAfter(b.next, { limit: 1 })).events).toEqual([]);
    });

    test.each([...FAN_OUT_CANCEL_REASONS])(
      'feed retains cancellations after recovery of %s',
      async reason => {
        const run = await running(store);
        const head = await store.getWorkflowEventHead();
        await store.cancelFanOutRun(run.id, reason);
        const committed = await store.listWorkflowEvents(run.id);
        await store.recoverCancelledFanOutRun(run.id);
        expect(await types(store, run.id)).toEqual(['workflow_resumed']);
        expect(
          (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
        ).toEqual(committed);
      }
    );
    test('feed retains terminal events after cleanup from an earlier cursor', async () => {
      const run = await running(store);
      const head = await store.getWorkflowEventHead();
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      const committed = await store.listWorkflowEvents(run.id);
      await harness.backdate(run.id, {
        started_at: new Date('2000-01-01'),
        last_activity_at: new Date('2000-01-01'),
      });
      await store.deleteOldWorkflowRuns(1);
      expect(await store.getWorkflowRun(run.id)).toBeNull();
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 1 })).events.map(row => row.event)
      ).toEqual(committed);
    });
    test('feed never reuses a position after fan-out recovery deletes the newest event', async () => {
      const run = await running(store);
      await store.cancelFanOutRun(run.id, 'fan_out_orphan');
      const head = await store.getWorkflowEventHead();
      await store.recoverCancelledFanOutRun(run.id);
      await store.persistWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(
          ({ event }) => event.event_type
        )
      ).toEqual(['workflow_resumed', 'workflow_started']);
    });
    test('feed never reuses a position after run cleanup deletes the newest event', async () => {
      const run = await running(store);
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      const head = await store.getWorkflowEventHead();
      await harness.backdate(run.id, {
        started_at: new Date('2000-01-01'),
        last_activity_at: new Date('2000-01-01'),
      });
      await store.deleteOldWorkflowRuns(1);
      expect(await store.getWorkflowRun(run.id)).toBeNull();
      const next = await create(store);
      await store.persistWorkflowEvent({
        workflow_run_id: next.id,
        event_type: 'workflow_started',
      });
      expect(
        (await store.readWorkflowEventsAfter(head, { limit: 10 })).events.map(
          ({ event }) => event.workflow_run_id
        )
      ).toEqual([next.id]);
    });
    test('feed rejects malformed cursors, cursors beyond its head and invalid page limits', async () => {
      for (const cursor of ['foreign:1', 'sql:-1', 'file:NaN.0', 'memory:1.5']) {
        expect(
          await rejection(
            store.readWorkflowEventsAfter(cursor as WorkflowEventCursor, { limit: 1 })
          )
        ).toBeInstanceOf(WorkflowEventCursorError);
      }
      const head = await store.getWorkflowEventHead();
      const beyondHead = head.replace(/[0-9]+/, order => String(BigInt(order) + 1000n));
      expect(
        await rejection(
          store.readWorkflowEventsAfter(beyondHead as WorkflowEventCursor, { limit: 1 })
        )
      ).toBeInstanceOf(WorkflowEventCursorError);
      for (const limit of [0, -1, 1.5, Infinity])
        expect(
          await rejection(
            store.readWorkflowEventsAfter(await store.getWorkflowEventHead(), { limit })
          )
        ).toBeInstanceOf(RangeError);
    });
    test('feed has no gaps while eight writers commit', async () => {
      await assertWorkflowEventFeedRace(store);
    });

    test('preserves private loop owner cursors through durable pause storage', async () => {
      const bodySessionCursors = { owner: { sessionId: 'O', provider: 'codex' } };
      const bodySessionCursorAncestry = {
        '["outer",[]]': { owner: { sessionId: 'A', provider: 'codex' } },
        '["outer.inner",[{"groupId":"outer","iteration":2}]]': bodySessionCursors,
      };
      const gateRun = await running(store);
      await store.pauseWorkflowRun(gateRun.id, {
        ...approval,
        bodySessionCursors,
        bodySessionCursorAncestry,
      });
      const storedGate = await store.getWorkflowRun(gateRun.id);
      expect(
        approvalContextSchema.parse(storedGate?.metadata?.approval).bodySessionCursors
      ).toEqual(bodySessionCursors);
      expect(
        approvalContextSchema.parse(storedGate?.metadata?.approval).bodySessionCursorAncestry
      ).toEqual(bodySessionCursorAncestry);
      const waitRun = await running(store);
      await store.pauseWorkflowRunForWait(
        waitRun.id,
        {
          ...wait,
          owner: 'loop_group',
          nodeId: 'group',
          bodyWaitId: 'wait',
          iteration: 2,
          sessionId: 'review-session',
          sessionProvider: 'codex',
          bodySessionCursors,
          bodySessionCursorAncestry,
        },
        { kind: 'started', stepName: 'group.wait' }
      );
      const storedWait = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(waitRun.id))?.metadata?.wait
      );
      expect(storedWait.owner).toBe('loop_group');
      if (storedWait.owner !== 'loop_group') throw new Error('wrong wait owner');
      expect(storedWait.bodySessionCursors).toEqual(bodySessionCursors);
      expect(storedWait.bodySessionCursorAncestry).toEqual(bodySessionCursorAncestry);
    });

    test('pending claim has exactly one winner and stamps the checkout', async () => {
      await assertWorkflowClaimRace(store);
    });
    test.each([
      { status: 'failed', error: 'original error' },
      { status: 'failed', error: '' },
      { status: 'failed', error: null },
      { status: 'failed', error: undefined },
      { status: 'failed', error: 42 },
      { status: 'paused', error: undefined },
    ] as const)(
      'resume from %j has one winner and preserves cleared failure evidence',
      async ({ status, error }) => {
        const run = await running(store, { metadata: { keep: true } });
        if (status === 'failed')
          await store.failWorkflowRun(run.id, typeof error === 'string' ? error : '', {
            exitReason: 'node_error',
          });
        else await store.pauseWorkflowRun(run.id, approval);
        await store.updateWorkflowRun(run.id, { metadata: { error } });
        const before = await types(store, run.id);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => store.resumeWorkflowRun(run.id))
        );
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        for (const result of results)
          if (result.status === 'rejected')
            expect(result.reason).toBeInstanceOf(WorkflowNotResumableError);
        expect(await store.getWorkflowRun(run.id)).toMatchObject({
          status: 'running',
          completed_at: null,
          metadata: { keep: true },
        });
        const metadata = (await store.getWorkflowRun(run.id))?.metadata;
        expect(metadata).not.toHaveProperty('error');
        expect(metadata).not.toHaveProperty('stop_reason');
        // Only the winning resume writes, and a resumed pause is in the feed.
        expect(await types(store, run.id)).toEqual([
          ...before,
          ...(status === 'failed' ? ['workflow_resumed'] : ['workflow_unpaused']),
        ]);
        if (status === 'failed') {
          const resumed = (await store.listWorkflowEvents(run.id)).find(
            event => event.event_type === 'workflow_resumed'
          );
          expect(resumed?.data).toEqual(typeof error === 'string' && error !== '' ? { error } : {});
        }
      }
    );
    test('resume audits a legacy metadata-only error and ignores empty errors', async () => {
      for (const error of ['legacy failure', '', null]) {
        const run = await running(store, { metadata: { error } });
        await store.pauseWorkflowRun(run.id, approval);
        await store.resumeWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        expect(events.map(event => event.event_type)).toEqual([
          ...(error ? ['workflow_resumed'] : []),
          'workflow_unpaused',
        ]);
        if (error) expect(events[0]?.data).toEqual({ error });
        expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('error');
      }
    });
    test('resume refuses stale cursors and consumes a quota schedule once', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: 'other',
            resumeAt: wait.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: wait.nodeId,
            resumeAt: schedule.deadlineAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      await store.resumeWorkflowRun(run.id, {
        kind: 'wait',
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      });
      await failWithSchedule(store, run.id);
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'quota',
            attempt: 2,
            resumeAt: schedule.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      const result = await store.resumeWorkflowRun(run.id, {
        kind: 'quota',
        attempt: 1,
        resumeAt: schedule.resumeAt,
      });
      expect(result.metadata.scheduled_resume).toMatchObject({
        ...schedule,
        triggeredAt: expect.any(String),
      });
      expect(await types(store, run.id)).toEqual([
        'wait_started',
        'workflow_unpaused',
        'workflow_failed',
        'workflow_resumed',
        'quota_resume_triggered',
      ]);
    });
    test('a quota continuation released for an unreadable source stays due as a source continuation', async () => {
      const due = async (now: Date): Promise<boolean> =>
        (await store.listDueWorkflowContinuations(now, 50)).some(due => due.id === run.id);
      const run = await running(store);
      await failWithSchedule(store, run.id);
      const now = new Date();
      expect(await due(now)).toBe(true);
      await store.resumeWorkflowRun(run.id, {
        kind: 'quota',
        attempt: schedule.attempt,
        resumeAt: schedule.resumeAt,
      });
      expect(await due(now)).toBe(false);

      const retryAt = new Date(now.getTime() + 60_000).toISOString();
      const afterRetry = new Date(Date.parse(retryAt) + 1000);
      expect(
        await store.releaseRunForUnreadableSource(run.id, {
          claimId: executionClaim((await store.getWorkflowRun(run.id))?.metadata ?? {}),
          nodeId: 'check',
          path: '/capture/project/.archon/scripts',
          error: 'EACCES',
          retryAt,
        })
      ).toEqual({ released: true });
      const released = await store.getWorkflowRun(run.id);
      expect(released?.status).toBe('paused');
      const release = readSourceRelease(released?.metadata);
      expect(release).toMatchObject({ nodeId: 'check', path: '/capture/project/.archon/scripts' });
      if (release === undefined) throw new Error('source release not recorded');
      expect(await due(now)).toBe(false);
      expect(await due(afterRetry)).toBe(true);

      const cursor = { kind: 'source' as const, ...release };
      const laterRetry = new Date(afterRetry.getTime() + 3_600_000).toISOString();
      await store.deferWorkflowContinuation(run.id, laterRetry, {
        ...cursor,
        releasedAt: '2000-01-01T00:00:00.000Z',
      });
      expect(await due(afterRetry)).toBe(true);
      await store.deferWorkflowContinuation(run.id, laterRetry, cursor);
      expect(await due(afterRetry)).toBe(false);

      const resumed = await store.resumeWorkflowRun(run.id, cursor);
      expect(resumed.status).toBe('running');
      expect(readSourceRelease(resumed.metadata)).toBeUndefined();
      expect(await rejection(store.resumeWorkflowRun(run.id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      expect(await types(store, run.id)).toContain('source_released');
    });
    describeSourceReleaseConformance(() => store);
    describeRunScratchConformance(() => store);
    test('only stale running runs can resume; completed and cancelled runs refuse', async () => {
      const run = await running(store);
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      await harness.backdate(run.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.resumeWorkflowRun(run.id)).status).toBe('running');
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      const cancelled = await create(store);
      await store.cancelWorkflowRun(cancelled.id);
      expect(await rejection(store.resumeWorkflowRun(cancelled.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
    });
    test('pause requires running, replaces the whole approval and commits suspension once', async () => {
      const run = await running(store, { metadata: { keep: true } });
      await store.pauseWorkflowRun(run.id, { ...approval, resolved: 'rejected' });
      expect(await rejection(store.pauseWorkflowRun(run.id, approval))).toBeInstanceOf(
        WorkflowRunPauseConflictError
      );
      const resumed = await store.resumeWorkflowRun(run.id);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          store.pauseWorkflowRun(
            run.id,
            approval,
            { extra: true },
            {
              workflow_run_id: run.id,
              event_type: 'node_suspended',
              step_name: 'review',
              data: {},
            }
          )
        )
      );
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toBeInstanceOf(WorkflowRunPauseConflictError);
      expect((await store.getWorkflowRun(run.id))?.metadata).toEqual({
        execution_claim: executionClaim(resumed.metadata),
        keep: true,
        extra: true,
        approval,
        [PAUSE_CAUSE_METADATA_KEY]: 'gate',
      });
      expect(await types(store, run.id)).toEqual(['workflow_unpaused', 'node_suspended']);
    });
    test('refuses unknown wait fields without changing the run or events', async () => {
      const run = await running(store);
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const future = { ...wait, futureField: true };
      await expect(
        store.pauseWorkflowRunForWait(run.id, future, {
          kind: 'started',
          stepName: 'wait',
        })
      ).rejects.toThrow();
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    });

    test.each(['create', 'update', 'complete', 'resolve'] as const)(
      '%s validates waits in generic metadata before changing rows or events',
      async operation => {
        const run = await running(store);
        if (operation === 'update')
          await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
        if (operation === 'resolve') await store.pauseWorkflowRun(run.id, approval);
        const id = operation === 'create' ? crypto.randomUUID() : run.id;
        const write = (value: unknown): Promise<unknown> => {
          const metadata = { wait: value, extra: true };
          switch (operation) {
            case 'create':
              return create(store, { id, metadata });
            case 'update':
              return store.updateWorkflowRun(id, { metadata });
            case 'complete':
              return store.completeWorkflowRun(id, { duration_ms: 1 }, metadata);
            case 'resolve':
              return store.resolveApprovalGate(id, metadata, gateEvents(0));
          }
        };
        const before = await store.getWorkflowRun(id);
        const events = await store.listWorkflowEvents(id);
        for (const invalid of [
          { ...wait, futureField: true },
          { ...wait, resumeAt: 42 },
        ]) {
          await expect(write(invalid)).rejects.toThrow();
          expect(await store.getWorkflowRun(id)).toEqual(before);
          expect(await store.listWorkflowEvents(id)).toEqual(events);
        }
        await write(wait);
        expect((await store.getWorkflowRun(id))?.metadata).toMatchObject({ wait, extra: true });
      }
    );

    test('approval pauses discard caller-supplied wait metadata', async () => {
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval, { wait: { ...wait, futureField: true } });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toBeUndefined();
    });

    test('future wait fields preserve attention actions, continuations and event signals', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, attentionWait, {
        kind: 'started',
        stepName: 'ask',
      });
      const currentRun = async (): Promise<WorkflowRun> => {
        const current = await store.getWorkflowRun(run.id);
        if (!current) throw new Error('Expected paused run');
        return current;
      };
      const seedFuture = (context: WorkflowWaitContext): Promise<void> =>
        harness.seedPersistedWait(run.id, { ...context, futureField: true });
      await seedFuture(attentionWait);
      expect(pausedAttentionWait(await currentRun())).toEqual(attentionWait);
      expect(
        (await listAttentionQueue({ store, branchOf: async () => null })).map(item => item.runId)
      ).toContain(run.id);
      const labeled = await store.labelAttentionWait(run.id, {
        pauseId: 'ask-1',
        set: { ci: 'pr' },
        unset: [],
        via: 'cli',
      });
      expect(labeled).toMatchObject({ labeled: true, wait: { revision: 2, labels: { ci: 'pr' } } });
      const stored = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(run.id))?.metadata.wait
      );
      expect(stored).not.toHaveProperty('futureField');
      await seedFuture(stored);
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-main'))).toEqual({
        answered: true,
      });
      const answered = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(run.id))?.metadata.wait
      );
      expect(answered).toMatchObject({
        answer: { decision: 'use-main' },
        revision: 2,
        labels: { ci: 'pr' },
      });
      expect((await store.listDueWorkflowContinuations(new Date())).map(row => row.id)).toContain(
        run.id
      );
      await store.resumeWorkflowRun(run.id);
      const event = {
        ...wait,
        kind: 'event' as const,
        event: 'ready',
        pauseId: 'event-1',
        resumeAt: '2099-01-01T00:00:00.000Z',
      };
      await store.pauseWorkflowRunForWait(run.id, event, { kind: 'started', stepName: 'wait' });
      await seedFuture(event);
      const deadline = pendingWorkflowWaitDeadline(await currentRun());
      expect(deadline).toEqual(event);
      if (!deadline || deadline.kind !== 'event') throw new Error('Expected event wait');
      await store.resumeWorkflowRun(run.id);
      await store.pauseWorkflowRunForWait(run.id, deadline, { kind: 'continued' });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toEqual(event);
      await seedFuture(event);
      expect(await store.signalWorkflowWait(run.id, deadline, { ready: true })).toEqual({
        signaled: true,
      });
      const signaled = pendingWorkflowWaitDeadline(await currentRun());
      expect(workflowWaitContextSchema.safeParse(signaled).success).toBe(true);
      expect(signaled).toMatchObject({
        ...event,
        signaledAt: expect.any(String),
        payload: { ready: true },
      });
    });

    test('continued waits do not duplicate the start; consumption matches the exact running cursor', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      const completion = {
        stepName: 'wait',
        result: { status: 'satisfied' as const, waited_ms: 12 },
      };
      expect(await store.clearWorkflowWaitContext(run.id, wait, completion)).toEqual({
        cleared: false,
      });
      await store.resumeWorkflowRun(run.id);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'continued' });
      expect(await types(store, run.id)).toEqual([
        'wait_started',
        'workflow_unpaused',
        'wait_continued',
      ]);
      await store.resumeWorkflowRun(run.id);
      expect(
        await store.clearWorkflowWaitContext(
          run.id,
          { ...wait, resumeAt: schedule.deadlineAt },
          completion
        )
      ).toEqual({ cleared: false });
      const results = await eight(() => store.clearWorkflowWaitContext(run.id, wait, completion));
      expect(results.filter(result => result.cleared)).toHaveLength(1);
      const winner = results.find(result => result.cleared);
      const rows = await store.listWorkflowEvents(run.id);
      expect(rows.map(row => row.event_type)).toEqual([
        'wait_started',
        'workflow_unpaused',
        'wait_continued',
        'workflow_unpaused',
        'wait_completed',
        'node_completed',
      ]);
      if (!winner?.cleared) throw new Error('No wait winner');
      expect(rows[5]).toMatchObject(winner.nodeEvent);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('wait');
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
    test.each([undefined, { value: 'signal' }])(
      'a stale signal cannot satisfy a later event occurrence with the same deadline (payload %j)',
      async payload => {
        const first: Extract<WorkflowWaitContext, { kind: 'event' }> = {
          owner: 'node',
          nodeId: 'gate',
          kind: 'event',
          event: 'ready',
          waitingSince: new Date().toISOString(),
          resumeAt: new Date(Date.now() + 86_400_000).toISOString(),
          pauseId: 'first',
        };
        const run = await running(store);
        await store.pauseWorkflowRunForWait(run.id, first, { kind: 'started', stepName: 'gate' });
        expect(await store.signalWorkflowWait(run.id, first, payload)).toEqual({ signaled: true });
        await store.resumeWorkflowRun(run.id);
        await store.clearWorkflowWaitContext(run.id, first, {
          stepName: 'gate',
          result: { status: 'satisfied', waited_ms: 0 },
        });
        const second = { ...first, pauseId: 'second' };
        await store.pauseWorkflowRunForWait(run.id, second, { kind: 'started', stepName: 'gate' });
        const before = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        expect(
          await store.signalWorkflowWait(run.id, { ...first, pauseId: undefined }, payload)
        ).toEqual({ signaled: false });
        expect(await store.signalWorkflowWait(run.id, first, payload)).toEqual({ signaled: false });
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(
          (await store.listDueWorkflowContinuations(new Date(), 10)).map(row => row.id)
        ).not.toContain(run.id);
        expect(await store.signalWorkflowWait(run.id, second, payload)).toEqual({ signaled: true });
        expect((await store.getWorkflowRun(run.id))?.metadata.wait).toMatchObject({
          pauseId: 'second',
          ...(payload === undefined ? {} : { payload }),
        });
      }
    );
    test('continuation scans honor exact-cursor deferral and an event signal has one winner', async () => {
      const due = async (now: Date): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(now, 10)).map(run => run.id);
      const afterWait = new Date(Date.parse(wait.resumeAt) + 1000);
      const timed = await running(store);
      await store.pauseWorkflowRunForWait(timed.id, wait, { kind: 'started', stepName: 'wait' });
      expect(await due(new Date(Date.parse(wait.resumeAt) - 1000))).not.toContain(timed.id);
      expect(await due(afterWait)).toContain(timed.id);
      const retryAt = schedule.deadlineAt;
      await store.deferWorkflowContinuation(timed.id, retryAt, {
        kind: 'wait',
        nodeId: 'other',
        resumeAt: wait.resumeAt,
      });
      expect(await due(afterWait)).toContain(timed.id);
      await store.deferWorkflowContinuation(timed.id, retryAt, {
        kind: 'wait',
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      });
      expect(await due(afterWait)).not.toContain(timed.id);
      expect(await due(new Date(Date.parse(retryAt) + 1000))).toContain(timed.id);

      const event: Extract<WorkflowWaitContext, { kind: 'event' }> = {
        owner: 'node',
        nodeId: 'gate',
        kind: 'event',
        event: 'ready',
        waitingSince: new Date().toISOString(),
        resumeAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      const signaled = await running(store);
      await store.pauseWorkflowRunForWait(signaled.id, event, {
        kind: 'started',
        stepName: 'gate',
      });
      expect(await due(new Date())).not.toContain(signaled.id);
      expect(
        await store.signalWorkflowWait(signaled.id, { ...event, event: 'other' }, { n: -1 })
      ).toEqual({ signaled: false });
      expect(
        await store.signalWorkflowWait(signaled.id, { ...event, pauseId: 'not-legacy' })
      ).toEqual({ signaled: false });
      const results = await eight(index =>
        store.signalWorkflowWait(signaled.id, event, { n: index })
      );
      expect(results.filter(result => result.signaled)).toHaveLength(1);
      const winner = results.findIndex(result => result.signaled);
      expect((await store.getWorkflowRun(signaled.id))?.metadata.wait).toMatchObject({
        signaledAt: expect.any(String),
        payload: { n: winner },
      });
      expect(await types(store, signaled.id)).toEqual(['wait_started', 'wait_signaled']);
      expect(await due(new Date())).toContain(signaled.id);
    });
    test('a usage-limit wait is due at its reset, and its claim clears it', async () => {
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: wait.waitingSince,
        resumeAt: wait.resumeAt,
      };
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, limit, {
        kind: 'started',
        stepName: limit.nodeId,
      });
      await harness.seedPersistedWait(run.id, { ...limit, futureField: true });
      const paused = await store.getWorkflowRun(run.id);
      expect(paused?.status).toBe('paused');
      expect(paused && continuablePauseCursor(paused)).toEqual(deadlineWaitCursor(limit));
      const due = async (now: Date): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(now, 10)).map(row => row.id);
      expect(await due(new Date(Date.parse(limit.resumeAt) - 1000))).not.toContain(run.id);
      expect(await due(new Date(Date.parse(limit.resumeAt) + 1000))).toContain(run.id);
      const resumed = await store.resumeWorkflowRun(run.id, deadlineWaitCursor(limit));
      expect(resumed.status).toBe('running');
      expect(resumed.metadata.wait).toBeUndefined();
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toBeUndefined();
      expect(await types(store, run.id)).toEqual(['wait_started', 'workflow_unpaused']);

      const cancelled = await running(store);
      await store.pauseWorkflowRunForWait(cancelled.id, limit, {
        kind: 'started',
        stepName: limit.nodeId,
      });
      expect(await store.cancelWorkflowRun(cancelled.id)).toEqual({ cancelled: true });
      expect(await due(new Date(Date.parse(limit.resumeAt) + 1000))).not.toContain(cancelled.id);
    });
    test('due continuations come earliest first, so a limit keeps the most overdue', async () => {
      const later = await running(store);
      await store.pauseWorkflowRunForWait(
        later.id,
        { ...wait, resumeAt: new Date(Date.parse(wait.resumeAt) + 60_000).toISOString() },
        { kind: 'started', stepName: 'wait' }
      );
      const earlier = await running(store);
      await store.pauseWorkflowRunForWait(earlier.id, wait, { kind: 'started', stepName: 'wait' });
      const now = new Date(Date.parse(wait.resumeAt) + 120_000);
      expect((await store.listDueWorkflowContinuations(now, 1)).map(run => run.id)).toEqual([
        earlier.id,
      ]);
      expect((await store.listDueWorkflowContinuations(now, 10)).map(run => run.id)).toEqual([
        earlier.id,
        later.id,
      ]);
    });
    test('an answered gate is due once, at its exact occurrence, and an open one never is', async () => {
      const due = async (): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id);
      const answer = (id: string, gate: ApprovalContext): Promise<{ resolved: boolean }> =>
        store.resolveApprovalGate(id, { approval: { ...gate, resolved: 'approved' } }, []);
      const cursor = { kind: 'answered' as const, nodeId: approval.nodeId, pauseId: 'first' };
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval);
      expect(await due()).not.toContain(run.id);
      expect(await answer(run.id, approval)).toEqual({ resolved: true });
      expect(await due()).toContain(run.id);

      const retryAt = new Date(Date.now() + 3_600_000).toISOString();
      await store.deferWorkflowContinuation(run.id, retryAt, { ...cursor, pauseId: 'other' });
      expect(await due()).toContain(run.id);
      await store.deferWorkflowContinuation(run.id, retryAt, cursor);
      expect(await due()).not.toContain(run.id);
      const afterRetry = new Date(Date.parse(retryAt) + 1000);
      expect(
        (await store.listDueWorkflowContinuations(afterRetry, 10)).map(due => due.id)
      ).toContain(run.id);

      expect(
        await rejection(store.resumeWorkflowRun(run.id, { ...cursor, pauseId: 'other' }))
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect((await store.resumeWorkflowRun(run.id, cursor)).status).toBe('running');
      expect(await rejection(store.resumeWorkflowRun(run.id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );

      // A wait replaces the answered gate, so the run is due only when its wait is.
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('approval');
      expect(
        (
          await store.listDueWorkflowContinuations(new Date(Date.parse(wait.resumeAt) - 1000), 10)
        ).map(due => due.id)
      ).not.toContain(run.id);
    });
    test('answered gates the host cannot continue are never due', async () => {
      const cases: [ApprovalContext, Record<string, unknown>][] = [
        [{ ...approval, type: 'child_workflow', childRunId: 'child' }, {}],
        [{ ...approval, type: 'fan_out', childRunIds: ['child'], unspawnedItems: 0 }, {}],
        [{ ...approval, type: 'writeback', nodeId: '__writeback__' }, {}],
        [{ nodeId: approval.nodeId, message: approval.message, type: 'approval' }, {}],
        [approval, { isolation: 'container' }],
      ];
      const ids: string[] = [];
      for (const [gate, metadata] of cases) {
        const run = await running(store, { metadata });
        await store.pauseWorkflowRun(run.id, gate);
        expect(
          await store.resolveApprovalGate(
            run.id,
            { approval: { ...gate, resolved: 'approved' } },
            []
          )
        ).toEqual({
          resolved: true,
        });
        ids.push(run.id);
      }
      const due = (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id);
      for (const id of ids) expect(due).not.toContain(id);
    });
    test('answered gates are listed after every timed continuation', async () => {
      // This gate's run was resumed from a quota schedule first; the triggered schedule it
      // keeps must not sort it among the timed rows.
      const gate = await running(store);
      await failWithSchedule(store, gate.id);
      await store.resumeWorkflowRun(gate.id, {
        kind: 'quota',
        attempt: schedule.attempt,
        resumeAt: schedule.resumeAt,
      });
      await store.pauseWorkflowRun(gate.id, approval);
      await store.resolveApprovalGate(
        gate.id,
        { approval: { ...approval, resolved: 'rejected' } },
        []
      );
      // Due later than that stale schedule, so only the gate rule puts it first.
      const timedAt = new Date(Date.parse(schedule.resumeAt) + 60_000).toISOString();
      const timed = await running(store);
      await store.pauseWorkflowRunForWait(
        timed.id,
        { ...wait, resumeAt: timedAt },
        { kind: 'started', stepName: 'wait' }
      );
      const now = new Date(Date.parse(timedAt) + 1000);
      expect((await store.listDueWorkflowContinuations(now, 10)).map(run => run.id)).toEqual([
        timed.id,
        gate.id,
      ]);
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
    test('a pause is due and gives back its slot exactly when the host continues it', async () => {
      const gate = (
        extra: Partial<Pick<ApprovalContext, 'type' | 'childRunId' | 'nodeId' | 'resolved'>>
      ): ApprovalContext => ({ ...approval, ...extra });
      const shapes: {
        name: string;
        metadata?: Record<string, unknown>;
        pause: (id: string) => Promise<unknown>;
      }[] = [
        {
          name: 'time wait',
          pause: id =>
            store.pauseWorkflowRunForWait(id, wait, { kind: 'started', stepName: 'wait' }),
        },
        {
          name: 'gate with a pauseId',
          pause: id => store.pauseWorkflowRun(id, gate({ resolved: 'approved' })),
        },
        {
          name: 'child_workflow gate',
          pause: id =>
            store.pauseWorkflowRun(
              id,
              gate({ type: 'child_workflow', childRunId: 'child', resolved: 'approved' })
            ),
        },
        {
          name: 'fan_out gate',
          pause: id =>
            store.pauseWorkflowRun(id, {
              ...approval,
              type: 'fan_out',
              childRunIds: ['child'],
              unspawnedItems: 0,
              resolved: 'approved',
            }),
        },
        {
          name: 'writeback gate',
          pause: id =>
            store.pauseWorkflowRun(
              id,
              gate({ type: 'writeback', nodeId: '__writeback__', resolved: 'approved' })
            ),
        },
        {
          name: 'container gate',
          metadata: { isolation: 'container' },
          pause: id => store.pauseWorkflowRun(id, gate({ resolved: 'approved' })),
        },
        {
          name: 'attention wait',
          pause: id =>
            store.pauseWorkflowRunForWait(id, answeredAttention('use-main'), {
              kind: 'started',
              stepName: 'ask',
            }),
        },
        {
          name: 'attention wait from before pause identities',
          pause: id =>
            store.pauseWorkflowRunForWait(
              id,
              { ...answeredAttention('use-main'), pauseId: undefined },
              { kind: 'started', stepName: 'ask' }
            ),
        },
        {
          name: 'container attention wait',
          metadata: { isolation: 'container' },
          pause: id =>
            store.pauseWorkflowRunForWait(id, answeredAttention('use-main'), {
              kind: 'started',
              stepName: 'ask',
            }),
        },
      ];
      for (const shape of shapes) {
        const run = await running(store, { metadata: shape.metadata ?? {} });
        await shape.pause(run.id);
        const stored = await store.getWorkflowRun(run.id);
        if (!stored) throw new Error(`missing run for ${shape.name}`);
        const listed = (await store.listDueWorkflowContinuations(new Date(), 50)).some(
          due => due.id === run.id
        );
        // A pause gives back its slot exactly when the host continues it by itself; a
        // released pause the host never continues would strand its run.
        expect({
          shape: shape.name,
          listed,
          releases: continuablePauseCursor(stored) !== undefined,
        }).toEqual({
          shape: shape.name,
          listed:
            continuablePause(stored) !== undefined ||
            pendingWorkflowWaitDeadline(stored) !== undefined,
          releases: listed,
        });
      }
    });
    test('gate resolution has one winner and no loser events', async () => {
      await assertWorkflowGateRace(store);
    });
    test.each(['resolve', 'cancel'] as const)('%s refuses another gate occurrence', async mode => {
      const run = await running(store, { metadata: { approval } });
      const resolve = (
        expected: string | { nodeId: string; pauseId: string }
      ): Promise<{ resolved: boolean }> =>
        mode === 'resolve'
          ? store.resolveApprovalGate(
              run.id,
              { approval: { ...approval, resolved: 'approved' } },
              gateEvents(0),
              expected
            )
          : store.resolveAndCancelApprovalGate(
              run.id,
              gateEvents(0),
              { reason: 'rejected' },
              expected
            );
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: false });
      await store.pauseWorkflowRun(run.id, approval);
      for (const expected of [
        'review',
        { nodeId: 'other', pauseId: 'first' },
        { nodeId: 'review', pauseId: 'stale' },
      ])
        expect(await resolve(expected)).toEqual({ resolved: false });
      expect(await types(store, run.id)).toEqual([]);
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: true });
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: false });
      expect(await types(store, run.id)).toEqual([
        'approval_received',
        'node_completed',
        ...(mode === 'cancel' ? ['workflow_cancelled'] : []),
      ]);
      expect(harness.terminalReports()).toEqual(mode === 'cancel' ? [run.id] : []);
    });
    test('reject and cancel has one winner and writes decision before terminal', async () => {
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval);
      const results = await eight(index =>
        store.resolveAndCancelApprovalGate(run.id, gateEvents(index), { step_name: 'review' })
      );
      expect(results.filter(result => result.resolved)).toHaveLength(1);
      expect(await types(store, run.id)).toEqual([
        'approval_received',
        'node_completed',
        'workflow_cancelled',
      ]);
      expect(harness.terminalReports()).toEqual([run.id]);
    });
    test.each(['complete', 'fail', 'cancel', 'fan-out'] as const)(
      '%s writes one terminal record and reports only a winning commit',
      async mode => {
        const run = await running(store);
        const write = (): ReturnType<
          IWorkflowStore['completeWorkflowRun' | 'failWorkflowRun' | 'cancelWorkflowRun']
        > =>
          mode === 'complete'
            ? store.completeWorkflowRun(run.id, { duration_ms: 5 })
            : mode === 'fail'
              ? store.failWorkflowRun(run.id, 'failed')
              : mode === 'cancel'
                ? store.cancelWorkflowRun(run.id)
                : store.cancelFanOutRun(run.id, 'fan_out_sibling');
        const results = await Promise.allSettled(Array.from({ length: 8 }, write));
        if (mode === 'complete') {
          expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
        } else {
          for (const result of results) expect(result.status).toBe('fulfilled');
          const won = results.filter(
            result =>
              result.status === 'fulfilled' &&
              result.value !== undefined &&
              ('failed' in result.value ? result.value.failed : result.value.cancelled)
          );
          expect(won).toHaveLength(1);
        }
        const events = await store.listWorkflowEvents(run.id);
        expect(events).toHaveLength(1);
        const status = mode === 'complete' ? 'completed' : mode === 'fail' ? 'failed' : 'cancelled';
        expect(events[0]?.event_type).toBe(`workflow_${status}`);
        expect(terminalRecordSchema.parse(events[0]?.data.terminal_record)).toMatchObject({
          run_id: run.id,
          status,
        });
        expect(harness.terminalReports()).toEqual([run.id]);
      }
    );
    test.each(['complete', 'fail', 'cancel', 'fan-out', 'reject', 'reset'] as const)(
      '%s publishes terminal status together with its event',
      async mode => {
        const run = await running(store, {
          origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
        });
        if (mode === 'reject' || mode === 'reset') await store.pauseWorkflowRun(run.id, approval);
        const writers: Record<typeof mode, () => Promise<unknown>> = {
          complete: () => store.completeWorkflowRun(run.id, { duration_ms: 1 }),
          fail: () => store.failWorkflowRun(run.id, 'failed'),
          cancel: () => store.cancelWorkflowRun(run.id),
          'fan-out': () => store.cancelFanOutRun(run.id, 'fan_out_sibling'),
          reject: () =>
            store.resolveAndCancelApprovalGate(run.id, gateEvents(0), {
              step_name: 'review',
            }),
          reset: () => store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID),
        };
        let settled = false;
        const pending = writers[mode]().finally(() => {
          settled = true;
        });
        try {
          do {
            // Bracket the row read so a commit between port reads cannot look non-atomic.
            const priorEvents = await store.listWorkflowEvents(run.id);
            const observed = await store.getWorkflowRun(run.id);
            const events = await store.listWorkflowEvents(run.id);
            for (const status of TERMINAL_WORKFLOW_STATUSES) {
              if (priorEvents.some(event => event.event_type === `workflow_${status}`))
                expect(observed?.status).toBe(status);
            }
            if (observed && isTerminalRunStatus(observed.status)) {
              const terminal = events.find(
                event => event.event_type === `workflow_${observed.status}`
              );
              expect(terminal).toBeDefined();
              expect(terminalRecordSchema.parse(terminal?.data.terminal_record).status).toBe(
                observed.status
              );
            }
            if (!settled) await new Promise<void>(resolve => setImmediate(resolve));
          } while (!settled);
        } finally {
          await pending;
        }
        expect(
          (await types(store, run.id)).filter(type =>
            TERMINAL_WORKFLOW_STATUSES.some(status => type === `workflow_${status}`)
          )
        ).toHaveLength(1);
      }
    );
    test('a racing resume follows the failure event when it succeeds', async () => {
      const run = await running(store);
      const pending = store.failWorkflowRun(run.id, 'failed');
      try {
        await store.getWorkflowRun(run.id);
        await store.listWorkflowEvents(run.id);
        const resumed = await Promise.allSettled([store.resumeWorkflowRun(run.id)]);
        if (resumed[0]?.status === 'fulfilled') {
          const ordered = await types(store, run.id);
          expect(ordered.indexOf('workflow_failed')).toBeGreaterThanOrEqual(0);
          expect(ordered.indexOf('workflow_resumed')).toBeGreaterThan(
            ordered.indexOf('workflow_failed')
          );
        }
      } finally {
        await pending;
      }
    });
    test.each([...TERMINAL_WORKFLOW_STATUSES])(
      'failure acknowledges an already %s run without another terminal write',
      async status => {
        const run = await running(store);
        if (status === 'completed') await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        else if (status === 'failed') await store.failWorkflowRun(run.id, 'first failure');
        else await store.cancelWorkflowRun(run.id);
        const before = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        const reports = harness.terminalReports();

        expect(
          await store.failWorkflowRun(run.id, 'late failure', { exitReason: 'node_error' })
        ).toEqual({ failed: false });

        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(harness.terminalReports()).toEqual(reports);
      }
    );
    test('failure rejects a missing run', async () => {
      expect(await rejection(store.failWorkflowRun('missing-run', 'failure'))).toBeInstanceOf(
        Error
      );
    });
    test('terminal writer start-state predicates preserve losers', async () => {
      const pending = await create(store);
      expect(
        await rejection(store.completeWorkflowRun(pending.id, { duration_ms: 0 }))
      ).toBeInstanceOf(Error);
      expect(await types(store, pending.id)).toEqual([]);
      expect(await store.failWorkflowRun(pending.id, 'setup failed')).toEqual({ failed: true });
      expect(await store.cancelWorkflowRun(pending.id)).toEqual({ cancelled: true });
      const paused = await running(store);
      await store.pauseWorkflowRun(paused.id, approval);
      expect(await rejection(store.failWorkflowRun(paused.id, 'bad'))).toBeInstanceOf(Error);
      expect(await types(store, paused.id)).toEqual([]);
      expect(await store.cancelWorkflowRun(paused.id)).toEqual({ cancelled: true });
      const completed = await running(store);
      await store.completeWorkflowRun(completed.id, { duration_ms: 1 });
      expect(await store.cancelWorkflowRun(completed.id)).toEqual({ cancelled: false });
      expect(await store.cancelFanOutRun(completed.id, 'fan_out_orphan')).toEqual({
        cancelled: false,
      });
      expect(harness.terminalReports()).toEqual([pending.id, pending.id, paused.id, completed.id]);
    });
    test.each(['operator', 'fan_out'] as const)(
      '%s cancellation preserves settled runs and cancels eligible runs',
      async mode => {
        const cancel = (id: string) =>
          mode === 'operator'
            ? store.cancelWorkflowRun(id)
            : store.cancelFanOutRun(id, 'fan_out_orphan');
        for (const status of [
          'pending',
          'running',
          'paused',
          'failed',
          'completed',
          'cancelled',
        ] as const) {
          const run = await create(store);
          if (status === 'completed') {
            await store.updateWorkflowRun(run.id, { status: 'running' });
            await store.completeWorkflowRun(run.id, { duration_ms: 1 });
          } else if (status === 'failed') await store.failWorkflowRun(run.id, 'failure');
          else if (status === 'cancelled') await store.cancelWorkflowRun(run.id);
          else if (status !== 'pending') await store.updateWorkflowRun(run.id, { status });
          const before = await store.getWorkflowRun(run.id);
          const events = await store.listWorkflowEvents(run.id);
          const reports = harness.terminalReports();
          const settled = status === 'completed' || status === 'cancelled';
          expect(await cancel(run.id)).toEqual({ cancelled: !settled });
          if (settled) {
            expect(await store.getWorkflowRun(run.id)).toEqual(before);
            expect(await store.listWorkflowEvents(run.id)).toEqual(events);
            expect(harness.terminalReports()).toEqual(reports);
          } else {
            expect((await store.getWorkflowRun(run.id))?.status).toBe('cancelled');
            expect((await store.listWorkflowEvents(run.id)).at(-1)?.event_type).toBe(
              'workflow_cancelled'
            );
          }
        }
        expect(await cancel(crypto.randomUUID())).toEqual({ cancelled: false });
      }
    );
    test('fan-out recovery retracts only engine cancellations', async () => {
      for (const reason of FAN_OUT_CANCEL_REASONS) {
        const recovered = await running(store);
        const release = {
          claimId: executionClaim((await store.getWorkflowRun(recovered.id))?.metadata ?? {}),
          nodeId: 'check',
          error: 'EACCES',
          retryAt: new Date().toISOString(),
        };
        await store.cancelFanOutRun(recovered.id, reason);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => store.recoverCancelledFanOutRun(recovered.id))
        );
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(await store.releaseRunForUnreadableSource(recovered.id, release)).toEqual({
          released: false,
        });
        const resumed = await store.getWorkflowRun(recovered.id);
        expect(resumed?.status).toBe('running');
        expect(await types(store, recovered.id)).toEqual(['workflow_resumed']);
        expect(
          await store.releaseRunForUnreadableSource(recovered.id, {
            ...release,
            claimId: executionClaim(resumed?.metadata ?? {}),
          })
        ).toEqual({ released: true });
        expect(await types(store, recovered.id)).toEqual(['workflow_resumed', 'source_released']);
      }
      const run = await running(store);
      await store.cancelFanOutRun(run.id, 'fan_out_orphan');
      expect((await store.recoverCancelledFanOutRun(run.id)).status).toBe('running');
      await store.cancelWorkflowRun(run.id);
      expect(await rejection(store.recoverCancelledFanOutRun(run.id))).toBeInstanceOf(Error);
      expect(await types(store, run.id)).toEqual(['workflow_resumed', 'workflow_cancelled']);
    });
    test('running-only event writes explicitly allow paused runs and refuse terminal runs', async () => {
      const run = await create(store);
      const event = {
        workflow_run_id: run.id,
        event_type: 'node_completed' as const,
        step_name: 'build',
        data: { node_output: 'ok' },
      };
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      await store.claimPendingWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: true });
      await store.pauseWorkflowRun(run.id, approval);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: true,
      });
      await store.cancelWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: false,
      });
      expect((await types(store, run.id)).filter(type => type === 'node_completed')).toHaveLength(
        2
      );
    });
    test('write-once checkout fields keep their first value and generic updates refuse terminal status', async () => {
      const run = await create(store);
      const baseline = { kind: 'not_git' as const, sampledAt: wait.waitingSince };
      expect(await store.recordWorkflowRunCheckoutBaseline(run.id, baseline)).toEqual(baseline);
      expect(
        await store.recordWorkflowRunCheckoutBaseline(run.id, {
          ...baseline,
          sampledAt: wait.resumeAt,
        })
      ).toEqual(baseline);
      await store.updateWorkflowRun(run.id, {
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true },
      });
      await store.updateWorkflowRun(run.id, {
        output_root: '/second',
        working_path: '/second',
        metadata: { extra: true },
      });
      expect(await store.getWorkflowRun(run.id)).toMatchObject({
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true, extra: true },
      });
      // Exercise the runtime boundary used by untyped SDK consumers.
      for (const status of TERMINAL_WORKFLOW_STATUSES) {
        const terminalUpdate = JSON.parse(JSON.stringify({ status })) as Parameters<
          IWorkflowStore['updateWorkflowRun']
        >[1];
        expect(await rejection(store.updateWorkflowRun(run.id, terminalUpdate))).toMatchObject({
          message: expect.stringContaining('lifecycle writer'),
        });
      }
      expect(await store.getWorkflowRunStatus(run.id)).toBe('pending');
    });
    test('write-back has one winner and release permits another claim', async () => {
      const run = await running(store);
      const results = await eight(() => store.claimWriteback(run.id));
      expect(results.filter(result => result.claimed)).toHaveLength(1);
      await store.releaseWritebackClaim(run.id);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty(
        'writeback_apply_claimed'
      );
      expect(await store.claimWriteback(run.id)).toEqual({ claimed: true });
    });
    test('path holders exclude stale pending, self and ancestors and agree on the id tiebreak', async () => {
      const path = '/locked';
      const first = await create(store, {
        id: '00000000-0000-4000-8000-000000000001',
        working_path: path,
      });
      const second = await create(store, {
        id: '00000000-0000-4000-8000-000000000002',
        working_path: path,
      });
      const tie = new Date(Date.now() - 60_000);
      for (const run of [first, second]) await harness.backdate(run.id, { started_at: tie });
      expect(
        await store.getActiveWorkflowRunByPath(path, { id: first.id, startedAt: tie })
      ).toBeNull();
      expect(
        (await store.getActiveWorkflowRunByPath(path, { id: second.id, startedAt: tie }))?.id
      ).toBe(first.id);
      expect(
        await store.getActiveWorkflowRunByPath(path, {
          id: second.id,
          startedAt: tie,
          excludeRunIds: [first.id],
        })
      ).toBeNull();
      for (const run of [first, second])
        await harness.backdate(run.id, { started_at: new Date(Date.now() - 600_000) });
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
      await store.claimPendingWorkflowRun(first.id);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.pauseWorkflowRun(first.id, approval);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.cancelWorkflowRun(first.id);
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
    });
    test('resumable lookup chooses newest matching run and includes stale running', async () => {
      const first = await running(store, { working_path: '/resume' });
      await store.failWorkflowRun(first.id, 'old');
      await harness.backdate(first.id, { started_at: new Date(Date.now() - 600_000) });
      const second = await running(store, { working_path: '/resume' });
      await store.pauseWorkflowRun(second.id, approval);
      await running(store, { workflow_name: 'other', working_path: '/resume' });
      await running(store, { working_path: '/other' });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(second.id);
      await store.cancelWorkflowRun(second.id);
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
      await store.resumeWorkflowRun(first.id);
      expect(await store.findResumableRun('conformance', '/resume')).toBeNull();
      await harness.backdate(first.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
    });
    test('events retain commit order, support exclusion and group requested runs', async () => {
      const first = await create(store);
      const second = await create(store);
      for (let index = 0; index < 20; index++)
        await store.persistWorkflowEvent({
          workflow_run_id: index % 2 === 0 ? first.id : second.id,
          event_type: 'workflow_artifact',
          data: { index },
        });
      const rows = await store.listWorkflowEvents(first.id);
      expect(rows.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2)
      );
      expect(new Set(rows.map(row => row.id)).size).toBe(10);
      for (const row of rows) expect(row.created_at).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
      expect(
        await store.listWorkflowEvents(first.id, { excludeEventTypes: ['workflow_artifact'] })
      ).toEqual([]);
      const grouped = await store.listEventsForRuns([second.id, first.id], ['workflow_artifact']);
      expect(grouped.get(first.id)).toEqual(rows);
      expect(grouped.get(second.id)?.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2 + 1)
      );
      expect(await store.listEventsForRuns([], ['workflow_artifact'])).toEqual(new Map());
      expect(await store.listEventsForRuns([first.id], [])).toEqual(new Map([[first.id, []]]));
    });
    test('unawaited event writes for a run read back in issue order', async () => {
      // The executor fires workflow_started without awaiting it and then writes node
      // events. Each burst starts on an idle store, where concurrent writes race.
      for (let attempt = 0; attempt < 20; attempt++) {
        const run = await running(store);
        const writes: Promise<unknown>[] = [
          store.createWorkflowEvent({ workflow_run_id: run.id, event_type: 'workflow_started' }),
        ];
        const expected = ['workflow_started'];
        for (const node of ['plan', 'build', 'test']) {
          const event = { workflow_run_id: run.id, step_name: node };
          writes.push(
            store.persistWorkflowEventIfRunning({ ...event, event_type: 'node_started' }),
            store.createWorkflowEvent({ ...event, event_type: 'workflow_artifact' }),
            store.persistWorkflowEvent({
              ...event,
              event_type: 'node_completed',
              data: { node_output: node },
            })
          );
          expected.push(
            `node_started:${node}`,
            `workflow_artifact:${node}`,
            `node_completed:${node}`
          );
        }
        await Promise.all(writes);
        const events = await store.listWorkflowEvents(run.id);
        expect(
          events.map(event =>
            event.step_name ? `${event.event_type}:${event.step_name}` : event.event_type
          )
        ).toEqual(expected);
      }
    });
    test('resume reduction preserves durable fan-out, starts and usage from failed and deferred attempts', async () => {
      const run = await create(store);
      const snapshots = [{ ordinal: 0, identity: 'one', item: 1, inputs: { value: 1 } }];
      const rows = [
        {
          event_type: 'node_completed' as const,
          step_name: 'success',
          data: {
            node_output: 'ok',
            structured_output: { ok: true },
            tokens: { input: 2, output: 3 },
            cost_usd: 0.25,
          },
        },
        {
          event_type: 'node_skipped_prior_success' as const,
          step_name: 'success',
          data: {
            node_output: 'ok',
            structured_output: { ok: true },
            tokens: { input: 2, output: 3 },
            cost_usd: 0.25,
          },
        },
        {
          event_type: 'node_completed' as const,
          step_name: 'invalidated',
          data: { node_output: 'stale' },
        },
        { event_type: 'node_prior_cache_invalidated' as const, step_name: 'invalidated', data: {} },
        { event_type: 'node_started' as const, step_name: 'unfinished', data: {} },
        {
          event_type: 'node_failed' as const,
          step_name: 'failed',
          data: { error: 'boom', tokens: { input: 5, output: 7 }, cost_usd: 0.5 },
        },
        {
          event_type: 'fan_out_instances' as const,
          step_name: 'fan',
          data: { instances: snapshots },
        },
        { event_type: 'fan_out_instances' as const, step_name: 'fan', data: { instances: [] } },
        // Deferred spend is accounting only: it must neither clear reusable output nor
        // resolve an unfinished start.
        {
          event_type: 'node_deferred_usage' as const,
          step_name: 'success',
          data: { accounting: 'node', tokens: { input: 1, output: 1 }, cost_usd: 0.125 },
        },
        {
          event_type: 'node_deferred_usage' as const,
          step_name: 'unfinished',
          data: { accounting: 'node', tokens: { input: 1, output: 1 }, cost_usd: 0.125 },
        },
      ];
      for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.completedNodeOutputs).toEqual(
        new Map([['success', { output: 'ok', structuredOutput: { ok: true } }]])
      );
      expect(snapshot.fanOutSnapshots).toEqual(new Map([['fan', snapshots]]));
      expect(snapshot.unresolvedNodeStarts).toEqual(new Set(['unfinished']));
      expect(snapshot.tokens).toMatchObject({ input: 9, output: 12 });
      expect(snapshot.costUsd).toBe(1);
    });
    test('resume reduction keeps the failure of a node whose latest record is node_failed', async () => {
      const run = await create(store);
      const rows = [
        {
          event_type: 'node_failed' as const,
          step_name: 'still-failed',
          data: { error: 'first', failure_kind: 'config' },
        },
        { event_type: 'node_failed' as const, step_name: 'recovered', data: { error: 'old' } },
        { event_type: 'node_started' as const, step_name: 'recovered', data: {} },
        {
          event_type: 'node_completed' as const,
          step_name: 'recovered',
          data: { node_output: 'ok' },
        },
      ];
      for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.failedNodes).toEqual(
        new Map([['still-failed', { error: 'first', failureKind: 'config' }]])
      );
    });
    test('every pause records its cause, and failing the run removes it', async () => {
      const since = new Date().toISOString();
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const cause = async (id: string): Promise<unknown> =>
        (await store.getWorkflowRun(id))?.metadata[PAUSE_CAUSE_METADATA_KEY];
      const gated = await running(store);
      await store.pauseWorkflowRun(gated.id, approval);
      expect(await cause(gated.id)).toBe('gate');
      const parent = await running(store);
      await store.pauseWorkflowRun(parent.id, {
        type: 'child_workflow',
        nodeId: 'sub',
        message: 'child',
        childRunId: 'child-1',
      });
      expect(await cause(parent.id)).toBe('child');
      const waiting = await running(store);
      await store.pauseWorkflowRunForWait(
        waiting.id,
        { owner: 'node', nodeId: 'ask', kind: 'attention', waitingSince: since, message: 'Ok?' },
        { kind: 'started', stepName: 'ask' }
      );
      expect(await cause(waiting.id)).toBe('wait');
      const released = await running(store);
      await store.releaseRunForUnreadableSource(released.id, {
        claimId: executionClaim((await store.getWorkflowRun(released.id))?.metadata ?? {}),
        nodeId: 'check',
        error: 'EACCES',
        retryAt: later,
      });
      expect(await cause(released.id)).toBe('source_release');
      const limited = await running(store);
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: since,
        resumeAt: later,
      };
      await store.pauseWorkflowRunForWait(limited.id, limit, {
        kind: 'started',
        stepName: 'implement',
      });
      expect(await cause(limited.id)).toBe('quota');
      // The cause survives the resume that consumes it, and a failure clears it.
      const resumed = await store.resumeWorkflowRun(limited.id, deadlineWaitCursor(limit));
      expect(resumed.metadata[PAUSE_CAUSE_METADATA_KEY]).toBe('quota');
      await store.failWorkflowRun(limited.id, 'boom');
      expect(await cause(limited.id)).toBeUndefined();
    });
    test('resume reduction rebuilds run-budget work units and spend, failing closed on unknown cost', async () => {
      const run = await create(store);
      const agentStart = (path: string) =>
        startNodeExecution({
          runId: run.id,
          path,
          node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
          invocation: newNodeInvocation(),
          provider: 'claude',
        });
      const priced = agentStart('priced');
      const unpriced = agentStart('unpriced');
      const open = agentStart('open');
      const rows = [
        runBudgetWorkUnitEvent(run.id, 'priced'),
        serializeNodeStateRecord(priced),
        serializeNodeStateRecord(
          finishNodeExecution(priced, { status: 'completed' }, { costUsd: 0.25 })
        ),
        runBudgetWorkUnitEvent(run.id, 'unpriced'),
        serializeNodeStateRecord(unpriced),
        serializeNodeStateRecord(finishNodeExecution(unpriced, { status: 'failed', error: 'x' })),
        serializeNodeStateRecord(open),
      ];
      for (const row of rows) await store.persistWorkflowEvent(row);
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.budget).toEqual({
        workUnits: 2,
        spendUsd: 0.25,
        costUnavailable: { path: 'unpriced', reason: 'unknown' },
      });

      // An attempt that started and never finished never reported its cost.
      const interrupted = await create(store);
      const lone = startNodeExecution({
        runId: interrupted.id,
        path: 'lone',
        node: { id: 'lone', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
        invocation: newNodeInvocation(),
        provider: 'claude',
      });
      await store.persistWorkflowEvent(runBudgetWorkUnitEvent(interrupted.id, 'lone'));
      await store.persistWorkflowEvent(serializeNodeStateRecord(lone));
      expect((await store.getDagResumeSnapshot(interrupted.id)).budget).toEqual({
        workUnits: 1,
        spendUsd: 0,
        costUnavailable: { path: 'lone', reason: 'interrupted' },
      });
    });
    test('provider events follow emission order within attempts and honor the node cursor', async () => {
      const run = await create(store);
      for (const [stepName, attemptId, seq] of [
        ['build', 'first', 1],
        ['build', 'first', 0],
        ['other', 'other', 0],
        ['build', 'second', 0],
      ] as const) {
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'provider_event',
          step_name: stepName,
          data: {
            attemptId,
            seq,
            observedAt: wait.waitingSince,
            event: { type: 'agent_message_chunk', text: 'hello' },
          },
        });
      }
      const records = await store.listProviderEvents(run.id, { stepName: 'build' });
      expect(records.map(row => [row.attemptId, row.seq])).toEqual([
        ['first', 0],
        ['first', 1],
        ['second', 0],
      ]);
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'first', seq: 0 },
        })
      ).toEqual(records.slice(1));
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'absent', seq: 0 },
        })
      ).toEqual([]);
      expect(await store.listProviderEvents(run.id)).toHaveLength(4);
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
    test('conversation cancellation includes parent-conversation matches, leaves live and unrelated descendants alone', async () => {
      const origin = { conversationId: CONFORMANCE_CONVERSATION_ID };
      const paused = await running(store, { origin });
      await store.pauseWorkflowRun(paused.id, approval);
      const failed = await create(store, {
        origin: { parentConversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.failWorkflowRun(failed.id, 'failed');
      const live = await running(store, { origin });
      const child = await running(store, { parent_run_id: paused.id });
      await store.pauseWorkflowRun(child.id, approval);
      const results = await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
      expect(results.map(run => run.id).sort()).toEqual([paused.id, failed.id].sort());
      for (const id of [paused.id, failed.id]) {
        expect(await store.getWorkflowRunStatus(id)).toBe('cancelled');
        expect((await types(store, id)).filter(type => type === 'workflow_cancelled')).toHaveLength(
          1
        );
      }
      expect(await store.getWorkflowRunStatus(live.id)).toBe('running');
      expect(await store.getWorkflowRunStatus(child.id)).toBe('paused');
      expect(await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID)).toEqual(
        []
      );
    });
    test('a conversation-cancellation refusal sees the resumable snapshot and writes nothing', async () => {
      const paused = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.pauseWorkflowRun(paused.id, approval);
      const refusal = new Error('not permitted');
      let seen: string[] = [];
      const outcome = await store
        .cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID, runs => {
          seen = runs.map(run => run.id);
          throw refusal;
        })
        .catch((error: unknown) => error);
      expect(outcome).toBe(refusal);
      expect(seen).toEqual([paused.id]);
      expect(await store.getWorkflowRunStatus(paused.id)).toBe('paused');
      expect(await types(store, paused.id)).not.toContain('workflow_cancelled');
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
