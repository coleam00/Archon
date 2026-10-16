import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readAttentionQueueItem } from './attention-queue';
import {
  attentionStreamLineSchema,
  watchAttentionQueue,
  type AttentionStreamLine,
  type AttentionWatchHost,
} from './attention-watch';
import type { AttentionWatchOptions } from './engine-port';
import { createFileWorkflowStore } from './file-store';
import type { ApprovalContext, WorkflowWaitContext } from './schemas/workflow-run';
import { WorkflowEventCursorError, workflowEventCursor, type IWorkflowStore } from './store';

const roots = trackTempRoots();
const host: AttentionWatchHost = { branchOf: async () => null };

async function makeStore(): Promise<IWorkflowStore> {
  return createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'archon-attention-watch-'))),
  });
}

async function running(store: IWorkflowStore, project = 'alpha'): Promise<string> {
  const run = await store.createWorkflowRun({ workflow_name: 'wf', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  await store.updateWorkflowRun(run.id, {
    output_root: join(getArchonWorkspacesPath(), '_cwd', project),
  });
  return run.id;
}

function ask(
  labels: Record<string, string> = {}
): Extract<WorkflowWaitContext, { kind: 'attention' }> & { pauseId: string } {
  return {
    owner: 'node',
    nodeId: 'ask',
    kind: 'attention',
    waitingSince: new Date().toISOString(),
    message: 'Which base?',
    pauseId: randomUUID(),
    form: 'select',
    options: [{ id: 'main' }, { id: 'dev' }],
    labels,
  };
}

async function pausedAtAsk(
  store: IWorkflowStore,
  labels: Record<string, string> = {},
  project?: string
): Promise<{ runId: string; wait: ReturnType<typeof ask> }> {
  const runId = await running(store, project);
  const wait = ask(labels);
  await store.pauseWorkflowRunForWait(runId, wait, { kind: 'started', stepName: 'ask' });
  return { runId, wait };
}

const gate = (): ApprovalContext & { pauseId: string } => ({
  nodeId: 'review',
  message: 'Ship it?',
  type: 'approval',
  pauseId: randomUUID(),
});

const answer = (pauseId: string) => ({
  pauseId,
  answer: { decision: 'main', text: '' },
  answeredVia: 'cli',
  answeredAt: '2026-10-15T00:00:00.000Z',
});

/** Starts a watch whose every line is checked against the published schema. */
async function watch(
  store: IWorkflowStore,
  options: Partial<AttentionWatchOptions> & { bookmarkIntervalMs?: number } = {},
  watchHost: AttentionWatchHost = host
): Promise<{
  lines: AttentionStreamLine[];
  close: () => Promise<void>;
  next: (match: (line: AttentionStreamLine) => boolean) => Promise<AttentionStreamLine>;
}> {
  const lines: AttentionStreamLine[] = [];
  const handle = await watchAttentionQueue(
    store,
    watchHost,
    line => {
      lines.push(attentionStreamLineSchema.parse(line));
    },
    { scope: { kind: 'all' }, pollIntervalMs: 5, ...options }
  );
  const next = async (
    match: (line: AttentionStreamLine) => boolean
  ): Promise<AttentionStreamLine> => {
    for (let waited = 0; waited < 5000; waited += 5) {
      const found = lines.find(match);
      if (found) return found;
      await Bun.sleep(5);
    }
    throw new Error(`no matching line in ${JSON.stringify(lines)}`);
  };
  return { lines, close: () => handle.close(), next };
}

const ofRun =
  (runId: string, type: AttentionStreamLine['type']) =>
  (line: AttentionStreamLine): boolean =>
    line.type === type && 'runId' in line && line.runId === runId;
const attentionOf =
  (runId: string, revision?: number) =>
  (line: AttentionStreamLine): boolean =>
    line.type === 'attention' &&
    line.item.runId === runId &&
    (revision === undefined || line.item.revision === revision);

describe('watchAttentionQueue', () => {
  test('the snapshot is the open set in scope, as the queue builds it, then ready', async () => {
    const store = await makeStore();
    const other = await pausedAtAsk(store, { ci: 'other' });
    await pausedAtAsk(store, { ci: 'pr' });
    const head = await store.getWorkflowEventHead();

    const filtered = await watch(store, { labels: { ci: 'other' } });
    await filtered.close();
    expect(filtered.lines).toEqual([
      {
        type: 'attention',
        cursor: head,
        snapshot: true,
        project: { key: '_cwd/alpha', codebaseId: null, name: 'alpha' },
        item: (await readAttentionQueueItem({ store, branchOf: host.branchOf }, other.runId))!,
      },
      { type: 'ready', cursor: head },
    ]);

    const beta = await pausedAtAsk(store, {}, 'beta');
    const scoped = await watch(store, {
      scope: { kind: 'project', project: { key: '_cwd/beta', codebaseId: null, name: 'beta' } },
    });
    await scoped.close();
    expect(
      scoped.lines.map(line => (line.type === 'attention' ? line.item.runId : line.type))
    ).toEqual([beta.runId, 'ready']);
  });

  test.each([
    ['usage_limit', 'usage_limit'],
    ['usage_limit', 'unreadable'],
    ['unreadable', 'usage_limit'],
  ] as const)('a batched %s to %s transition emits the changed item', async (from, to) => {
    const store = await makeStore();
    const runId = await running(store);
    const pause = async (kind: 'usage_limit' | 'unreadable', hours: number): Promise<void> => {
      if (kind === 'usage_limit') {
        await store.pauseWorkflowRunForWait(
          runId,
          {
            owner: 'node',
            nodeId: 'work',
            kind: 'quota',
            pauseId: randomUUID(),
            waitingSince: new Date().toISOString(),
            resumeAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
          },
          { kind: 'started', stepName: 'work' }
        );
      } else {
        await store.pauseWorkflowRun(runId, gate(), undefined, {
          workflow_run_id: runId,
          event_type: 'node_suspended',
          step_name: 'work',
          data: {},
        });
        await store.updateWorkflowRun(runId, {
          metadata: { wait: undefined, approval: undefined },
        });
      }
    };
    await pause(from, 1);
    let held = true;
    const holding: IWorkflowStore = Object.create(store);
    holding.readWorkflowEventsAfter = (cursor, options) =>
      held
        ? Promise.resolve({ events: [], next: cursor })
        : store.readWorkflowEventsAfter(cursor, options);
    const stream = await watch(holding, { bookmarkIntervalMs: 0 });
    try {
      await store.resumeWorkflowRun(runId);
      await pause(to, 2);
      const expected = await readAttentionQueueItem({ store, branchOf: host.branchOf }, runId);
      const head = await store.getWorkflowEventHead();
      held = false;
      await stream.next(line => line.type === 'bookmark' && line.cursor === head);
      const items = stream.lines.filter(line => line.type === 'attention');
      expect(items).toHaveLength(2);
      expect(items[1]).toMatchObject({ snapshot: false, item: expected });
      expect(items[0]).toMatchObject({ snapshot: true, item: { kind: from } });
      expect(items[1]).toMatchObject({ item: { kind: to } });
      await store.resumeWorkflowRun(runId);
      expect(await stream.next(ofRun(runId, 'resolved'))).toMatchObject({
        occurrence: null,
        reason: 'withdrawn',
      });
    } finally {
      await stream.close();
    }
  });

  test('a pause, an answer and a completion after the start arrive in order, and no row changes', async () => {
    const store = await makeStore();
    const stream = await watch(store);
    const runId = await running(store);
    const wait = ask();
    await store.pauseWorkflowRunForWait(runId, wait, { kind: 'started', stepName: 'ask' });
    const opened = await stream.next(attentionOf(runId));
    expect(opened).toMatchObject({ snapshot: false, item: { occurrence: wait.pauseId } });

    await store.answerAttentionWait(runId, answer(wait.pauseId));
    expect(await stream.next(ofRun(runId, 'resolved'))).toMatchObject({
      occurrence: wait.pauseId,
      reason: 'answered',
      answeredVia: 'cli',
      answeredAt: '2026-10-15T00:00:00.000Z',
    });

    await store.resumeWorkflowRun(runId);
    await store.completeWorkflowRun(runId, { duration_ms: 1 });
    expect(await stream.next(ofRun(runId, 'terminal'))).toMatchObject({
      status: 'completed',
      outcome: null,
      project: { key: '_cwd/alpha' },
    });
    const row = await store.getWorkflowRun(runId);
    await stream.close();
    expect(await store.getWorkflowRun(runId)).toEqual(row);
    expect(stream.lines.filter(line => 'runId' in line || line.type === 'attention')).toHaveLength(
      3
    );
  });

  test('a relabel moves an item between label filters by revision, and unmatched is stateless', async () => {
    const store = await makeStore();
    const other = await watch(store, { labels: { ci: 'other' } });
    const pr = await watch(store, { labels: { ci: 'pr' } });
    const { runId, wait } = await pausedAtAsk(store, { ci: 'other' });
    await other.next(attentionOf(runId, 1));
    const write = { pauseId: wait.pauseId, unset: [], via: 'cli' };

    await store.labelAttentionWait(runId, { ...write, set: { ci: 'other' } });
    await other.next(attentionOf(runId, 2));
    await store.labelAttentionWait(runId, { ...write, set: { ci: 'pr' } });
    expect(await other.next(ofRun(runId, 'unmatched'))).toMatchObject({
      occurrence: wait.pauseId,
      revision: 3,
    });
    await pr.next(attentionOf(runId, 3));

    // Never matched the filter, still told: the stream keeps no memory of what it sent.
    const stranger = await pausedAtAsk(store, { ci: 'x' });
    await store.labelAttentionWait(stranger.runId, {
      pauseId: stranger.wait.pauseId,
      set: { note: 'y' },
      unset: [],
      via: 'cli',
    });
    expect(await other.next(ofRun(stranger.runId, 'unmatched'))).toMatchObject({ revision: 2 });
    await Promise.all([other.close(), pr.close()]);
    expect(other.lines.filter(ofRun(runId, 'resolved'))).toEqual([]);
  });

  test('a project-scoped stream sends nothing for another project', async () => {
    const store = await makeStore();
    const before = await running(store, 'alpha');
    const watched: string[] = [];
    const stream = await watch(
      store,
      {
        scope: { kind: 'project', project: { key: '_cwd/beta', codebaseId: null, name: 'beta' } },
        labels: { ci: 'pr' },
        bookmarkIntervalMs: 0,
      },
      {
        ...host,
        ownerLoss: runId => {
          watched.push(runId);
          return Promise.resolve({ observedStatus: 'running' });
        },
      }
    );
    // With a zero interval every read that reaches the head bookmarks it, so each alpha
    // state below is read by the tail before the next replaces it.
    const caughtUp = async (): Promise<void> => {
      const head = await store.getWorkflowEventHead();
      await stream.next(line => line.type === 'bookmark' && line.cursor === head);
    };
    const runId = await running(store, 'alpha');
    await store.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'workflow_started',
      data: {},
    });
    await caughtUp();
    const wait = ask({ ci: 'pr' });
    await store.pauseWorkflowRunForWait(runId, wait, { kind: 'started', stepName: 'ask' });
    await caughtUp();
    await store.labelAttentionWait(runId, {
      pauseId: wait.pauseId,
      set: { ci: 'other' },
      unset: [],
      via: 'cli',
    });
    await caughtUp();
    await store.resumeWorkflowRun(runId);
    await store.failWorkflowRun(runId, 'out-of-scope failure');
    await caughtUp();
    await store.resumeWorkflowRun(runId);
    await store.completeWorkflowRun(runId, { duration_ms: 1 });
    await store.completeWorkflowRun(before, { duration_ms: 1 });
    await caughtUp();
    await stream.close();
    expect(stream.lines.filter(line => line.type !== 'ready' && line.type !== 'bookmark')).toEqual(
      []
    );
    expect(watched).toEqual([]);
  });

  test('restarting after a cursor misses nothing that happened while stopped', async () => {
    const store = await makeStore();
    const open = await pausedAtAsk(store);
    const answered = await pausedAtAsk(store);
    const finishing = await running(store);
    const first = await watch(store);
    const ready = await first.next(line => line.type === 'ready');
    if (ready.type !== 'ready') throw new Error('expected ready');
    await store.completeWorkflowRun(finishing, { duration_ms: 1 });
    const firstTerminal = await first.next(ofRun(finishing, 'terminal'));
    await first.close();

    const late = await pausedAtAsk(store);
    await store.answerAttentionWait(answered.runId, answer(answered.wait.pauseId));
    await store.resumeWorkflowRun(answered.runId);
    await store.completeWorkflowRun(answered.runId, { duration_ms: 1 });

    const second = await watch(store, { after: ready.cursor });
    await second.next(ofRun(answered.runId, 'terminal'));
    await second.close();
    const snapshot = second.lines.filter(line => line.type === 'attention' && line.snapshot);
    const key = (line: AttentionStreamLine): unknown =>
      line.type === 'attention'
        ? [
            line.item.runId,
            'occurrence' in line.item ? line.item.occurrence : null,
            line.item.revision,
          ]
        : null;
    expect(snapshot.map(key)).toEqual(
      expect.arrayContaining([
        [open.runId, open.wait.pauseId, 1],
        [late.runId, late.wait.pauseId, 1],
      ])
    );
    expect(snapshot).toHaveLength(2);
    expect(second.lines.filter(ofRun(finishing, 'terminal'))).toEqual([firstTerminal]);
    // The late pause is already held from the snapshot, so its replayed event adds nothing.
    expect(second.lines.filter(attentionOf(late.runId))).toHaveLength(1);
  });

  test.each([false, true])(
    'a failed run resumes on the cursor feed (batched: %s)',
    async batched => {
      const store = await makeStore();
      let held = false;
      const holding: IWorkflowStore = Object.create(store);
      holding.readWorkflowEventsAfter = (cursor, options) =>
        held
          ? Promise.resolve({ events: [], next: cursor })
          : store.readWorkflowEventsAfter(cursor, options);
      const stream = await watch(holding, { labels: { ci: 'pr' }, bookmarkIntervalMs: 0 });
      const runId = await running(store);
      try {
        await store.failWorkflowRun(runId, 'node failed');
        const terminal = await stream.next(ofRun(runId, 'terminal'));
        if (terminal.type !== 'terminal') throw new Error('expected terminal');
        held = batched;
        await store.resumeWorkflowRun(runId);
        if (batched) await store.completeWorkflowRun(runId, { duration_ms: 1 });
        const row = await store.getWorkflowRun(runId);
        const head = await store.getWorkflowEventHead();
        held = false;
        await stream.next(line => line.type === 'bookmark' && line.cursor === head);
        const changes = stream.lines.filter(line => 'runId' in line && line.runId === runId);
        expect(changes).toMatchObject([
          { type: 'terminal', status: 'failed' },
          { type: 'resumed', status: 'running', runId, project: { key: '_cwd/alpha' } },
          ...(batched ? [{ type: 'terminal', status: 'completed' }] : []),
        ]);
        const resumed = changes[1];
        expect(resumed).toHaveProperty('cursor');
        expect(resumed).not.toHaveProperty('cursor', terminal.cursor);

        const replay = await watch(store, { after: terminal.cursor, bookmarkIntervalMs: 0 });
        try {
          await replay.next(line => line.type === 'bookmark' && line.cursor === head);
          expect(replay.lines.filter(line => 'runId' in line && line.runId === runId)).toEqual(
            changes.slice(1)
          );
        } finally {
          await replay.close();
        }
        expect(await store.getWorkflowRun(runId)).toEqual(row);
      } finally {
        await stream.close();
      }
    }
  );

  test('a cursor the store did not issue rejects before any line', async () => {
    const store = await makeStore();
    const lines: AttentionStreamLine[] = [];
    const rejected = await watchAttentionQueue(store, host, line => void lines.push(line), {
      scope: { kind: 'all' },
      after: workflowEventCursor('sql:1'),
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(WorkflowEventCursorError);
    expect(lines).toEqual([]);
  });

  test('a resume without an answer withdraws the item; a re-pause opens it again', async () => {
    const store = await makeStore();
    const stream = await watch(store);
    const runId = await running(store);
    const first = gate();
    await store.pauseWorkflowRun(runId, first, undefined, {
      workflow_run_id: runId,
      event_type: 'node_suspended',
      step_name: 'review',
      data: {},
    });
    await stream.next(attentionOf(runId));
    await store.resumeWorkflowRun(runId);
    expect(await stream.next(ofRun(runId, 'resolved'))).toMatchObject({
      occurrence: first.pauseId,
      reason: 'withdrawn',
    });
    const second = gate();
    await store.pauseWorkflowRun(runId, second, undefined, {
      workflow_run_id: runId,
      event_type: 'node_suspended',
      step_name: 'review',
      data: {},
    });
    await stream.next(
      line =>
        line.type === 'attention' &&
        'occurrence' in line.item &&
        line.item.occurrence === second.pauseId
    );

    // An unanswered select wait that a bare resume reaches again reopens the same occurrence.
    const asked = await pausedAtAsk(store);
    await stream.next(attentionOf(asked.runId));
    await store.resumeWorkflowRun(asked.runId);
    await stream.next(ofRun(asked.runId, 'resolved'));
    await store.pauseWorkflowRunForWait(asked.runId, asked.wait, { kind: 'continued' });
    await stream.next(() => stream.lines.filter(attentionOf(asked.runId)).length === 2);
    await stream.close();
  });

  test('an answer the row no longer records is read from its event in the same page', async () => {
    const store = await makeStore();
    let held = false;
    const holding: IWorkflowStore = Object.create(store);
    holding.readWorkflowEventsAfter = (cursor, options) =>
      held
        ? Promise.resolve({ events: [], next: cursor })
        : store.readWorkflowEventsAfter(cursor, options);
    const answeredGate = await running(store);
    const first = gate();
    await store.pauseWorkflowRun(answeredGate, first, undefined, {
      workflow_run_id: answeredGate,
      event_type: 'node_suspended',
      step_name: 'review',
      data: {},
    });
    const asked = await pausedAtAsk(store);
    const stream = await watch(holding);
    await stream.next(line => line.type === 'ready');

    // While the tail is held, each answer is followed by a write that drops it from the row,
    // so only the answer event in the page can tell answered from withdrawn.
    held = true;
    await store.resolveApprovalGate(
      answeredGate,
      { approval: { ...first, resolved: 'approved' } },
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { via: 'web', occurrence: first.pauseId, decision: 'approved' },
        },
      ],
      { nodeId: first.nodeId, pauseId: first.pauseId }
    );
    await store.resumeWorkflowRun(answeredGate);
    const second = gate();
    await store.pauseWorkflowRun(answeredGate, second, undefined, {
      workflow_run_id: answeredGate,
      event_type: 'node_suspended',
      step_name: 'review',
      data: {},
    });
    await store.answerAttentionWait(asked.runId, answer(asked.wait.pauseId));
    await store.resumeWorkflowRun(asked.runId);
    await store.pauseWorkflowRunForWait(asked.runId, ask(), { kind: 'started', stepName: 'ask' });
    held = false;

    for (const [runId, occurrence, via] of [
      [answeredGate, first.pauseId, 'web'],
      [asked.runId, asked.wait.pauseId, 'cli'],
    ] as const) {
      expect(await stream.next(ofRun(runId, 'resolved'))).toMatchObject({
        occurrence,
        reason: 'answered',
        answeredVia: via,
        answeredAt: null,
      });
      await stream.next(() => stream.lines.filter(attentionOf(runId)).length === 2);
    }
    await stream.close();
    expect(
      stream.lines.filter(line => line.type === 'resolved' || line.type === 'attention')
    ).toHaveLength(6);
  });

  test('terminal and owner_lost reach a label-filtered stream for every run in scope', async () => {
    const store = await makeStore();
    const orphan = await running(store);
    const finishing = await running(store);
    const stream = await watch(
      store,
      { labels: { ci: 'pr' } },
      {
        ...host,
        ownerLoss: (runId, signal) =>
          runId === orphan
            ? Promise.resolve({ observedStatus: 'running' })
            : new Promise(resolve => signal.addEventListener('abort', () => resolve(null))),
      }
    );
    await stream.next(ofRun(orphan, 'owner_lost'));
    await store.completeWorkflowRun(finishing, { duration_ms: 1 });
    expect(await stream.next(ofRun(finishing, 'terminal'))).toMatchObject({ status: 'completed' });
    await stream.close();
  });

  test('owner loss arrives once, and only through the liveness port', async () => {
    const store = await makeStore();
    const orphan = await running(store);
    const healthy = await running(store, 'beta');
    const watched: string[] = [];
    const stream = await watch(
      store,
      {},
      {
        ...host,
        ownerLoss: (runId, signal) => {
          watched.push(runId);
          if (runId === orphan) return Promise.resolve({ observedStatus: 'running' });
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(null)));
        },
      }
    );
    expect(await stream.next(ofRun(orphan, 'owner_lost'))).toMatchObject({
      observedStatus: 'running',
      project: { key: '_cwd/alpha' },
    });
    await Bun.sleep(30);
    await stream.close();
    expect(stream.lines.filter(line => line.type === 'owner_lost')).toHaveLength(1);
    expect(watched.sort()).toEqual([orphan, healthy].sort());

    const portless = await watch(store);
    await store.completeWorkflowRun(healthy, { duration_ms: 1 });
    await portless.next(ofRun(healthy, 'terminal'));
    await portless.close();
    expect(portless.lines.filter(line => line.type === 'owner_lost')).toEqual([]);
  });

  test('a failed liveness read is retried rather than dropped', async () => {
    const store = await makeStore();
    const orphan = await running(store);
    let calls = 0;
    const stream = await watch(
      store,
      {},
      {
        ...host,
        ownerLoss: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('database unavailable'))
            : Promise.resolve({ observedStatus: 'running' });
        },
      }
    );
    await stream.next(ofRun(orphan, 'owner_lost'));
    await stream.close();
    expect(calls).toBe(2);
  });

  test('a failed start after ready stops the liveness it armed', async () => {
    const store = await makeStore();
    const armed = await running(store);
    const signals: AbortSignal[] = [];
    const lines: AttentionStreamLine[] = [];
    const failing: IWorkflowStore = Object.create(store);
    failing.listWorkflowRuns = async (
      query?: Parameters<IWorkflowStore['listWorkflowRuns']>[0]
    ) => {
      const page = await store.listWorkflowRuns(query);
      // A second run whose project read fails, after the first was armed.
      const broken = { ...page.runs[0], id: 'broken', codebase_id: 'missing' };
      return { ...page, runs: [...page.runs, broken], total: page.total + 1 };
    };
    failing.getCodebase = () => Promise.reject(new Error('database unavailable'));
    const rejected = await watchAttentionQueue(
      failing,
      {
        ...host,
        ownerLoss: (_runId, signal) => {
          signals.push(signal);
          return new Promise(resolve => signal.addEventListener('abort', () => resolve(null)));
        },
      },
      line => void lines.push(line),
      { scope: { kind: 'all' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    await store.completeWorkflowRun(armed, { duration_ms: 1 });
    await Bun.sleep(30);
    expect(lines.map(line => line.type)).toEqual(['ready']);
  });

  test('a tail that cannot read its cursor stops with an error line', async () => {
    const store = await makeStore();
    let foreign = false;
    const failing: IWorkflowStore = Object.create(store);
    failing.readWorkflowEventsAfter = (cursor, options) =>
      foreign
        ? Promise.reject(new WorkflowEventCursorError())
        : store.readWorkflowEventsAfter(cursor, options);
    const stream = await watch(failing);
    foreign = true;
    expect(await stream.next(line => line.type === 'error')).toEqual({
      type: 'error',
      error: 'cursor_invalid',
    });
    foreign = false;
    await pausedAtAsk(store);
    await Bun.sleep(30);
    await stream.close();
    expect(stream.lines.at(-1)?.type).toBe('error');
  });

  test('a stream that cannot read the store sends no bookmark until a read succeeds', async () => {
    const store = await makeStore();
    let reads = 0;
    let down = true;
    const failing: IWorkflowStore = Object.create(store);
    failing.readWorkflowEventsAfter = (cursor, options) => {
      reads += 1;
      return down
        ? Promise.reject(new Error('database unavailable'))
        : store.readWorkflowEventsAfter(cursor, options);
    };
    const stream = await watch(failing, { bookmarkIntervalMs: 0 });
    while (reads < 5) await Bun.sleep(5);
    expect(stream.lines.map(line => line.type)).toEqual(['ready']);
    down = false;
    expect(await stream.next(line => line.type === 'bookmark')).toEqual({
      type: 'bookmark',
      cursor: await store.getWorkflowEventHead(),
    });
    await stream.close();
  });

  test('an idle stream sends a bookmark at the feed position', async () => {
    const store = await makeStore();
    await running(store);
    const stream = await watch(store, { bookmarkIntervalMs: 20 });
    const bookmark = await stream.next(line => line.type === 'bookmark');
    await stream.close();
    expect(bookmark).toEqual({ type: 'bookmark', cursor: await store.getWorkflowEventHead() });
  });
});
