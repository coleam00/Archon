// @archon-test-isolated
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import * as paths from '@archon/paths';
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
import {
  executionClaim,
  WorkflowEventCursorError,
  workflowEventCursor,
  type IWorkflowStore,
} from './store';

const roots = trackTempRoots();
const host: AttentionWatchHost = { branchOf: async () => null };

async function makeStore(): Promise<IWorkflowStore> {
  return createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'archon-attention-watch-'))),
  });
}

async function running(
  store: IWorkflowStore,
  project = 'alpha',
  codebaseId?: string
): Promise<string> {
  const run = await store.createWorkflowRun({
    workflow_name: 'wf',
    user_message: '',
    codebase_id: codebaseId,
  });
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
  test('a paused gate streams sibling stalls and their removal without losing the gate', async () => {
    const store = await makeStore();
    const runId = await running(store);
    const approval = gate();
    await store.pauseWorkflowRun(runId, approval);
    const stream = await watch(store);
    try {
      await stream.next(attentionOf(runId));
      const call = {
        streamId: 's',
        nodeId: 'silent-sibling',
        provider: 'codex',
        toolCallId: 'turn',
        name: 'provider turn',
        kind: 'provider_turn' as const,
        startedAt: new Date(Date.now() - 1800000).toISOString(),
        lastProgressAt: new Date(Date.now() - 1800000).toISOString(),
        raisedAt: new Date().toISOString(),
        thresholdMs: 1800000,
      };
      await store.setToolCallAttention(runId, 's', [call]);
      const stalled = await stream.next(
        line =>
          line.type === 'attention' && line.item.runId === runId && !!line.item.stalledCalls?.length
      );
      if (stalled.type !== 'attention') throw new Error('expected attention');
      expect(stalled.item.stalledCalls?.[0].stalledForMs).toBeGreaterThanOrEqual(1800000);
      expect(stalled).toMatchObject({
        type: 'attention',
        snapshot: false,
        item: {
          kind: 'awaiting_response',
          occurrence: approval.pauseId,
          stalledCalls: [{ nodeId: 'silent-sibling' }],
        },
      });
      const beforeClear = stream.lines.length;
      await store.setToolCallAttention(runId, 's', []);
      await stream.next(
        line =>
          stream.lines.indexOf(line) >= beforeClear &&
          line.type === 'attention' &&
          line.item.runId === runId &&
          !line.item.stalledCalls?.length
      );
      expect(stream.lines.at(-1)).toMatchObject({
        type: 'attention',
        item: { kind: 'awaiting_response', occurrence: approval.pauseId },
      });
      expect((await store.getWorkflowRun(runId))?.status).toBe('paused');
      expect(stream.lines.some(line => line.type === 'resolved')).toBe(false);
    } finally {
      await stream.close();
    }
  });

  test.each(['attention', 'resolved', 'unmatched', 'terminal', 'resumed'] as const)(
    'a rejected %s line retries before later cursors are delivered',
    async type => {
      const store = await makeStore();
      const runId = await running(store);
      const wait = ask({ ci: 'pr' });
      if (type === 'resolved' || type === 'unmatched')
        await store.pauseWorkflowRunForWait(runId, wait, { kind: 'started', stepName: 'ask' });
      if (type === 'resumed') await store.failWorkflowRun(runId, 'failed');
      const start = await store.getWorkflowEventHead();
      const accepted: AttentionStreamLine[] = [];
      const rejected: AttentionStreamLine[] = [];
      let accepting = false;
      const stream = await watchAttentionQueue(
        store,
        host,
        async line => {
          if (line.type === type && !(line.type === 'attention' && line.snapshot) && !accepting) {
            rejected.push(line);
            throw new Error('consumer unavailable');
          }
          accepted.push(line);
        },
        { scope: { kind: 'all' }, labels: { ci: 'pr' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
      );
      const until = async (condition: () => boolean): Promise<void> => {
        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline) {
          if (condition()) return;
          await Bun.sleep(5);
        }
        throw new Error(`delivery did not retry: ${JSON.stringify({ rejected, accepted })}`);
      };
      try {
        if (type === 'attention')
          await store.pauseWorkflowRunForWait(runId, wait, { kind: 'started', stepName: 'ask' });
        if (type === 'resolved' || type === 'resumed') await store.resumeWorkflowRun(runId);
        if (type === 'unmatched')
          await store.labelAttentionWait(runId, {
            pauseId: wait.pauseId,
            set: { ci: 'other' },
            unset: [],
            via: 'cli',
          });
        if (type === 'terminal') await store.failWorkflowRun(runId, 'failed');
        const head = await store.getWorkflowEventHead();
        await until(() => rejected.length >= 3);
        expect(rejected.every(line => isDeepStrictEqual(line, rejected[0]))).toBe(true);
        expect(accepted.some(line => 'cursor' in line && line.cursor === head)).toBe(false);
        accepting = true;
        await until(() => accepted.some(line => line.type === 'bookmark' && line.cursor === head));
        expect(accepted).toContainEqual(rejected[0]);
        expect(
          accepted.filter(line => line.type === type && 'cursor' in line && line.cursor !== start)
        ).toHaveLength(1);
      } finally {
        await stream.close();
      }
    },
    40_000
  );

  test('a rejected degradation warning retains the cursor until the consumer accepts it', async () => {
    const store = await makeStore();
    const a = await running(store);
    const b = await running(store);
    const start = await store.getWorkflowEventHead();
    const feed: IWorkflowStore = Object.create(store);
    let broken = false;
    feed.getWorkflowRun = id =>
      broken && id === a ? Promise.reject(new Error('unreadable')) : store.getWorkflowRun(id);
    const reads: string[] = [];
    feed.readWorkflowEventsAfter = (cursor, options) => {
      reads.push(cursor);
      return store.readWorkflowEventsAfter(cursor, options);
    };
    const lines: AttentionStreamLine[] = [];
    let attempts = 0;
    let accepting = false;
    const stream = await watchAttentionQueue(
      feed,
      host,
      async line => {
        if (line.type === 'degraded') {
          attempts++;
          if (!accepting) throw new Error('consumer unavailable');
        }
        lines.push(attentionStreamLineSchema.parse(line));
      },
      { scope: { kind: 'all' }, pollIntervalMs: 5 }
    );
    const until = async (condition: () => boolean): Promise<void> => {
      for (let waited = 0; waited < 1000; waited += 5) {
        if (condition()) return;
        await Bun.sleep(5);
      }
      throw new Error('consumer did not reach the expected delivery');
    };
    try {
      broken = true;
      await store.failWorkflowRun(a, 'failed');
      await store.failWorkflowRun(b, 'failed');
      await store.resumeWorkflowRun(b);
      await until(() => attempts >= 3);
      expect(lines.map(line => line.type)).toEqual(['ready']);
      expect(reads.every(cursor => cursor === start)).toBe(true);
      accepting = true;
      await until(() => lines.some(ofRun(b, 'resumed')));
      expect(lines.map(line => line.type)).toEqual(['ready', 'degraded', 'terminal', 'resumed']);
      expect(lines[1]).toEqual({ type: 'degraded', reason: 'run_unreadable', cursor: start });
    } finally {
      await stream.close();
    }
  });

  test.each(['all', 'project'] as const)(
    'an unreadable run cannot block independent lifecycle lines (%s)',
    async kind => {
      const store = await makeStore();
      const a = await running(store, 'secret');
      const b = await running(store);
      const failing: IWorkflowStore = Object.create(store);
      let broken = false;
      failing.getWorkflowRun = id =>
        broken && id === a
          ? Promise.reject(new Error('private read failure'))
          : store.getWorkflowRun(id);
      const logger = paths.createLogger('test');
      const warnings: unknown[] = [];
      const warn = spyOn(logger, 'warn').mockImplementation(
        (...args: Parameters<typeof logger.warn>) => {
          warnings.push(args);
        }
      );
      const error = spyOn(logger, 'error').mockImplementation(() => {});
      const log = spyOn(paths, 'createLogger').mockReturnValue(logger);
      const stream = await watch(failing, {
        scope:
          kind === 'all'
            ? { kind }
            : {
                kind,
                project: { key: '_cwd/alpha', codebaseId: null, name: 'alpha' },
              },
      });
      const start = await store.getWorkflowEventHead();
      try {
        broken = true;
        await store.failWorkflowRun(a, 'failed');
        await store.failWorkflowRun(b, 'failed');
        await store.resumeWorkflowRun(b);
        const terminal = await stream.next(ofRun(b, 'terminal'));
        const resumed = await stream.next(ofRun(b, 'resumed'));
        const degraded = await stream.next(line => line.type === 'degraded');
        expect(degraded).toEqual({ type: 'degraded', reason: 'run_unreadable', cursor: start });
        expect(JSON.stringify(stream.lines)).not.toContain(a);
        expect(JSON.stringify(stream.lines)).not.toContain('private read failure');
        expect(JSON.stringify(warnings)).toContain(a);
        expect(stream.lines.indexOf(terminal)).toBeLessThan(stream.lines.indexOf(resumed));
        broken = false;
        const replay = await watch(store, { after: start });
        try {
          await replay.next(ofRun(b, 'resumed'));
          expect(replay.lines.filter(ofRun(a, 'terminal'))).toHaveLength(1);
          expect(replay.lines.filter(ofRun(b, 'terminal'))).toEqual([terminal]);
          expect(replay.lines.filter(ofRun(b, 'resumed'))).toEqual([resumed]);
        } finally {
          await replay.close();
        }
        if (terminal.type !== 'terminal') throw new Error('expected terminal');
        const after = await watch(store, { after: terminal.cursor });
        try {
          expect(await after.next(ofRun(b, 'resumed'))).toEqual(resumed);
          expect(after.lines.filter(ofRun(b, 'terminal'))).toEqual([]);
        } finally {
          await after.close();
        }
      } finally {
        await stream.close();
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    }
  );

  test.each(['run', 'codebase', 'branch'] as const)(
    'projection faults retry once and isolate repeated failures at the %s boundary',
    async boundary => {
      for (const persistent of [false, true]) {
        const store = await makeStore();
        const a = await running(store, 'alpha', boundary === 'codebase' ? 'cb-a' : undefined);
        const b = await running(store);
        const failing: IWorkflowStore = Object.create(store);
        let active = false;
        let failures = 0;
        let held = true;
        failing.readWorkflowEventsAfter = (cursor, opts) =>
          held
            ? Promise.resolve({ events: [], next: cursor })
            : store.readWorkflowEventsAfter(cursor, opts);
        const fault = (): void => {
          if (active && (persistent || failures === 0)) {
            failures++;
            throw new Error('projection unavailable');
          }
        };
        failing.getWorkflowRun = async id => {
          if (boundary === 'run' && id === a) fault();
          return store.getWorkflowRun(id);
        };
        failing.getCodebase = async id => {
          if (boundary === 'codebase') fault();
          return { id, name: 'alpha', repository_url: null, default_cwd: '/alpha', kind: 'repo' };
        };
        const stream = await watch(
          failing,
          {},
          {
            branchOf: async run => {
              if (boundary === 'branch' && run.id === a) fault();
              return null;
            },
          }
        );
        try {
          active = true;
          await store.pauseWorkflowRunForWait(a, ask(), { kind: 'started', stepName: 'ask' });
          await store.failWorkflowRun(b, 'failed');
          await store.resumeWorkflowRun(b);
          held = false;
          await stream.next(ofRun(b, 'resumed'));
          if (persistent) {
            expect(stream.lines.some(line => line.type === 'degraded')).toBe(true);
            expect(stream.lines.filter(attentionOf(a))).toEqual([]);
          } else {
            expect(stream.lines.filter(attentionOf(a))).toHaveLength(1);
            expect(stream.lines.some(line => line.type === 'degraded')).toBe(false);
          }
          expect(failures).toBe(persistent ? 3 : 1);
        } finally {
          await stream.close();
        }
      }
    }
  );

  test('lookahead crosses follower pages and isolates repeated deliveries within each page', async () => {
    const store = await makeStore();
    const a = await running(store);
    const b = await running(store);
    const start = await store.getWorkflowEventHead();
    await store.failWorkflowRun(a, 'failed');
    await store.failWorkflowRun(b, 'failed');
    await store.resumeWorkflowRun(b);
    const original = await store.readWorkflowEventsAfter(start, { limit: 100 });
    const events = [
      ...Array.from({ length: 501 }, () => original.events[0]),
      ...original.events.slice(1),
    ].map((delivery, index) => ({
      ...delivery,
      cursor: workflowEventCursor(`fixture:${index + 1}`),
    }));
    const first = workflowEventCursor('fixture:0');
    const feed: IWorkflowStore = Object.create(store);
    feed.getWorkflowEventHead = async () => first;
    feed.readWorkflowEventsAfter = async (cursor, { limit }) => {
      const offset = cursor === first ? 0 : events.findIndex(event => event.cursor === cursor) + 1;
      const page = events.slice(offset, offset + limit);
      return { events: page, next: page.at(-1)?.cursor ?? cursor };
    };
    let failures = 0;
    feed.getWorkflowRun = async id => {
      if (id === a) {
        failures++;
        throw new Error('unreadable');
      }
      return store.getWorkflowRun(id);
    };
    const stream = await watch(feed);
    try {
      expect(await stream.next(ofRun(b, 'terminal'))).toHaveProperty('cursor', events[501].cursor);
      expect(await stream.next(ofRun(b, 'resumed'))).toHaveProperty('cursor', events[502].cursor);
      expect(failures).toBe(6);
      expect(stream.lines.filter(line => line.type === 'degraded')).toHaveLength(2);
    } finally {
      await stream.close();
    }
  });

  test('outage scans probe each run once across pages and retry on recovery', async () => {
    const store = await makeStore();
    const a = await running(store);
    const b = await running(store);
    const c = await running(store);
    const start = await store.getWorkflowEventHead();
    for (const id of [a, b, c]) await store.failWorkflowRun(id, 'failed');
    await store.resumeWorkflowRun(b);
    const original = await store.readWorkflowEventsAfter(start, { limit: 100 });
    const events = [
      original.events[0],
      ...Array.from({ length: 201 }, () => original.events[1]),
      ...original.events.slice(2),
    ].map((delivery, index) => ({
      ...delivery,
      cursor: workflowEventCursor(`fixture:${index + 1}`),
    }));
    const first = workflowEventCursor('fixture:0');
    let down = true;
    let probes = new Map<string, number>();
    const scans: Map<string, number>[] = [];
    const feed: IWorkflowStore = Object.create(store);
    feed.getWorkflowEventHead = async () => first;
    feed.readWorkflowEventsAfter = async (cursor, { limit }) => {
      const offset = cursor === first ? 0 : events.findIndex(event => event.cursor === cursor) + 1;
      const page = events.slice(offset, offset + limit);
      if (down && limit === 100 && page.length === 0) {
        scans.push(probes);
        probes = new Map();
      }
      return { events: page, next: page.at(-1)?.cursor ?? cursor };
    };
    feed.getWorkflowRun = async id => {
      if (down) {
        probes.set(id, (probes.get(id) ?? 0) + 1);
        throw new Error('store outage');
      }
      return store.getWorkflowRun(id);
    };
    const stream = await watch(feed, { bookmarkIntervalMs: 0 });
    try {
      await stream.next(line => line.type === 'degraded' && scans.length >= 2);
      expect(scans.slice(0, 2).map(scan => [scan.get(a), scan.get(b), scan.get(c)])).toEqual([
        [2, 1, 1],
        [1, 1, 1],
      ]);
      expect(stream.lines.some(line => line.type === 'terminal')).toBe(false);
      expect(stream.lines.some(line => line.type === 'bookmark')).toBe(false);
      down = false;
      await stream.next(ofRun(b, 'resumed'));
      expect(
        stream.lines
          .filter(line => line.type === 'terminal' || line.type === 'resumed')
          .map(line => line.cursor)
      ).toEqual(events.map(event => event.cursor));
    } finally {
      await stream.close();
    }
  });

  test.each(['latched', 'during witness'] as const)(
    'an outage retries without skipping, including a cached earlier success (%s)',
    async recovery => {
      const store = await makeStore();
      const a = await running(store);
      const b = await running(store);
      const c = await running(store);
      const start = await store.getWorkflowEventHead();
      let held = true;
      let down = false;
      let attempts = 0;
      const feed: IWorkflowStore = Object.create(store);
      feed.readWorkflowEventsAfter = (cursor, opts) =>
        held
          ? Promise.resolve({ events: [], next: cursor })
          : store.readWorkflowEventsAfter(cursor, opts);
      feed.getWorkflowRun = async id => {
        if (id === b && attempts === 0) down = true;
        if (down) {
          attempts++;
          if (recovery === 'during witness' && id === c) down = false;
          else throw new Error('store outage');
        }
        return store.getWorkflowRun(id);
      };
      const stream = await watch(feed, { bookmarkIntervalMs: 0 });
      try {
        await store.failWorkflowRun(a, 'failed');
        const safe = (await store.readWorkflowEventsAfter(start, { limit: 1 })).events[0].cursor;
        await store.failWorkflowRun(b, 'failed');
        await store.resumeWorkflowRun(a);
        await store.failWorkflowRun(c, 'failed');
        held = false;
        if (recovery === 'latched') {
          const warning = await stream.next(line => line.type === 'degraded' && attempts >= 8);
          expect(warning).toEqual({ type: 'degraded', reason: 'run_unreadable', cursor: safe });
          expect(stream.lines.filter(line => line.type === 'terminal')).toHaveLength(1);
          expect(stream.lines.filter(line => line.type === 'degraded')).toHaveLength(1);
          expect(stream.lines.some(line => line.type === 'bookmark' && line.cursor !== start)).toBe(
            false
          );
          down = false;
        }
        await stream.next(ofRun(c, 'terminal'));
        expect(
          stream.lines.filter(line => line.type === 'terminal' || line.type === 'resumed')
        ).toMatchObject([
          { type: 'terminal', runId: a },
          { type: 'terminal', runId: b },
          { type: 'resumed', runId: a },
          { type: 'terminal', runId: c },
        ]);
        const expected = await store.readWorkflowEventsAfter(start, { limit: 100 });
        expect(
          stream.lines
            .filter(line => line.type === 'terminal' || line.type === 'resumed')
            .map(line => ('cursor' in line ? line.cursor : null))
        ).toEqual(expected.events.map(event => event.cursor));
      } finally {
        await stream.close();
      }
    }
  );

  test.each(['invalid cursor', 'close'] as const)('lookahead respects %s', async mode => {
    const store = await makeStore();
    const a = await running(store);
    const start = await store.getWorkflowEventHead();
    let entered!: () => void;
    const probing = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const feed: IWorkflowStore = Object.create(store);
    let projections = 0;
    feed.getWorkflowRun = async () => {
      projections++;
      throw new Error('unreadable');
    };
    let probes = 0;
    feed.readWorkflowEventsAfter = async (cursor, opts) => {
      if (cursor !== start) {
        probes++;
        entered();
        if (mode === 'invalid cursor') throw new WorkflowEventCursorError();
        await pending;
      }
      return store.readWorkflowEventsAfter(cursor, opts);
    };
    const stream = await watch(feed);
    try {
      await store.failWorkflowRun(a, 'failed');
      await probing;
      if (mode === 'close') {
        await store.createWorkflowEvent({
          workflow_run_id: a,
          event_type: 'workflow_started',
          data: {},
        });
      }
      if (mode === 'invalid cursor') {
        expect(await stream.next(line => line.type === 'error')).toEqual({
          type: 'error',
          error: 'cursor_invalid',
        });
      } else {
        let closed = false;
        const closing = stream.close().then(() => {
          closed = true;
        });
        await Bun.sleep(10);
        expect(closed).toBe(false);
        release();
        await closing;
        expect(stream.lines.map(line => line.type)).toEqual(['ready', 'degraded']);
      }
      expect(probes).toBe(1);
      expect(projections).toBe(2);
    } finally {
      release();
      await stream.close();
    }
  });

  test('isolation leaves a previously emitted open item unresolved', async () => {
    const store = await makeStore();
    const a = await pausedAtAsk(store);
    const b = await running(store);
    let broken = false;
    const stream = await watch(
      store,
      {},
      {
        branchOf: async run => {
          if (broken && run.id === a.runId) throw new Error('branch unavailable');
          return null;
        },
      }
    );
    try {
      broken = true;
      await store.labelAttentionWait(a.runId, {
        pauseId: a.wait.pauseId,
        set: { ci: 'pr' },
        unset: [],
        via: 'cli',
      });
      await store.failWorkflowRun(b, 'failed');
      await stream.next(ofRun(b, 'terminal'));
      expect(stream.lines.filter(attentionOf(a.runId))).toHaveLength(1);
      expect(stream.lines.filter(ofRun(a.runId, 'resolved'))).toEqual([]);
      expect(stream.lines.some(line => line.type === 'degraded')).toBe(true);
    } finally {
      await stream.close();
    }
  });

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
          metadata: { approval: undefined },
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

  test.each(['live', 'resume and complete', 'fail and resume'] as const)(
    'a failed run resumes on the cursor feed (%s)',
    async batch => {
      const store = await makeStore();
      let held = batch === 'fail and resume';
      const holding: IWorkflowStore = Object.create(store);
      holding.readWorkflowEventsAfter = (cursor, options) =>
        held
          ? Promise.resolve({ events: [], next: cursor })
          : store.readWorkflowEventsAfter(cursor, options);
      const stream = await watch(holding, { labels: { ci: 'pr' }, bookmarkIntervalMs: 0 });
      const runId = await running(store);
      try {
        await store.failWorkflowRun(runId, 'node failed');
        if (batch !== 'fail and resume') await stream.next(ofRun(runId, 'terminal'));
        held = batch !== 'live';
        await store.resumeWorkflowRun(runId);
        if (batch === 'resume and complete')
          await store.completeWorkflowRun(runId, { duration_ms: 1 });
        const row = await store.getWorkflowRun(runId);
        const head = await store.getWorkflowEventHead();
        held = false;
        await stream.next(line => line.type === 'bookmark' && line.cursor === head);
        const changes = stream.lines.filter(line => 'runId' in line && line.runId === runId);
        expect(changes).toMatchObject([
          { type: 'terminal', status: 'failed' },
          { type: 'resumed', status: 'running', runId, project: { key: '_cwd/alpha' } },
          ...(batch === 'resume and complete' ? [{ type: 'terminal', status: 'completed' }] : []),
        ]);
        const terminal = changes[0];
        if (terminal.type !== 'terminal') throw new Error('expected terminal');
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

  test.each(['completed', 'failed', 'cancelled', 'paused'] as const)(
    '%s disarms owner liveness before awaiting the consumer',
    async status => {
      const store = await makeStore();
      const runId = await running(store);
      const owner = Promise.withResolvers<{ observedStatus: 'running' } | null>();
      const delivered = Promise.withResolvers<void>();
      const accepted = Promise.withResolvers<void>();
      const lines: AttentionStreamLine[] = [];
      let ownerSignal: AbortSignal | undefined;
      const stream = await watchAttentionQueue(
        store,
        {
          ...host,
          ownerLoss: (_runId, signal) => {
            ownerSignal = signal;
            return owner.promise;
          },
        },
        async line => {
          lines.push(line);
          if (line.type === (status === 'paused' ? 'attention' : 'terminal')) {
            delivered.resolve();
            await accepted.promise;
          }
        },
        { scope: { kind: 'all' }, pollIntervalMs: 5 }
      );
      try {
        if (status === 'completed') await store.completeWorkflowRun(runId, { duration_ms: 1 });
        if (status === 'failed') await store.failWorkflowRun(runId, 'failed');
        if (status === 'cancelled') await store.cancelWorkflowRun(runId);
        if (status === 'paused')
          await store.pauseWorkflowRunForWait(runId, ask(), { kind: 'started', stepName: 'ask' });
        await delivered.promise;
        owner.resolve({ observedStatus: 'running' });
        await owner.promise;
        expect(ownerSignal?.aborted).toBe(true);
      } finally {
        owner.resolve(null);
        accepted.resolve();
        await stream.close();
      }
      expect(lines.some(ofRun(runId, 'owner_lost'))).toBe(false);
    }
  );

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

  test.each(['workflow_started', 'workflow_resumed', 'workflow_unpaused'] as const)(
    'replaying %s after owner loss does not watch the same claim again',
    async eventType => {
      const store = await makeStore();
      const start = await store.getWorkflowEventHead();
      const runId = await running(store);
      if (eventType === 'workflow_started')
        await store.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: eventType,
          data: {},
        });
      else {
        if (eventType === 'workflow_resumed') await store.failWorkflowRun(runId, 'failed');
        else await store.updateWorkflowRun(runId, { status: 'paused' });
        await store.resumeWorkflowRun(runId);
      }
      const head = await store.getWorkflowEventHead();
      let held = true;
      const holding: IWorkflowStore = Object.create(store);
      holding.readWorkflowEventsAfter = (cursor, options) =>
        held
          ? Promise.resolve({ events: [], next: cursor })
          : store.readWorkflowEventsAfter(cursor, options);
      let checks = 0;
      const stream = await watch(
        holding,
        { after: start, bookmarkIntervalMs: 0 },
        {
          ...host,
          ownerLoss: async () => {
            checks++;
            return { observedStatus: 'running' };
          },
        }
      );
      try {
        await stream.next(ofRun(runId, 'owner_lost'));
        held = false;
        await stream.next(line => line.type === 'bookmark' && line.cursor === head);
      } finally {
        await stream.close();
      }
      expect(stream.lines.filter(ofRun(runId, 'owner_lost'))).toHaveLength(1);
      expect(checks).toBe(1);
      expect((await store.getWorkflowRun(runId))?.status).toBe('running');
    }
  );

  test.each(['failed', 'paused'] as const)(
    'a %s run resumed after owner loss reports the new claim loss once',
    async status => {
      const store = await makeStore();
      const runId = await running(store);
      await store.failWorkflowRun(runId, 'first failure');
      const original = await store.resumeWorkflowRun(runId);
      let held = false;
      const holding: IWorkflowStore = Object.create(store);
      holding.readWorkflowEventsAfter = (cursor, options) =>
        held
          ? Promise.resolve({ events: [], next: cursor })
          : store.readWorkflowEventsAfter(cursor, options);
      let checks = 0;
      const stream = await watch(
        holding,
        { bookmarkIntervalMs: 0 },
        {
          ...host,
          ownerLoss: async () => {
            checks++;
            return { observedStatus: 'running' };
          },
        }
      );
      try {
        await stream.next(ofRun(runId, 'owner_lost'));
        held = true;
        if (status === 'failed') await store.failWorkflowRun(runId, 'failed');
        else await store.updateWorkflowRun(runId, { status: 'paused' });
        const resumed = await store.resumeWorkflowRun(runId);
        expect(executionClaim(resumed.metadata)).not.toBe(executionClaim(original.metadata));
        const head = await store.getWorkflowEventHead();
        held = false;
        await stream.next(line => line.type === 'bookmark' && line.cursor === head);
        await stream.next(() => stream.lines.filter(ofRun(runId, 'owner_lost')).length >= 2);
      } finally {
        await stream.close();
      }
      expect(stream.lines.filter(ofRun(runId, 'owner_lost'))).toHaveLength(2);
      expect(checks).toBe(2);
    }
  );

  test('a new claim replaces a pending owner watch and ignores its late loss', async () => {
    const store = await makeStore();
    const runId = await running(store);
    let held = true;
    const holding: IWorkflowStore = Object.create(store);
    holding.readWorkflowEventsAfter = (cursor, options) =>
      held
        ? Promise.resolve({ events: [], next: cursor })
        : store.readWorkflowEventsAfter(cursor, options);
    const oldOwner = Promise.withResolvers<{ observedStatus: 'running' } | null>();
    const signals: AbortSignal[] = [];
    const stream = await watch(
      holding,
      { bookmarkIntervalMs: 0 },
      {
        ...host,
        ownerLoss: (_runId, signal) => {
          signals.push(signal);
          return signals.length === 1
            ? oldOwner.promise
            : Promise.resolve({ observedStatus: 'running' });
        },
      }
    );
    try {
      await store.failWorkflowRun(runId, 'failed');
      await store.resumeWorkflowRun(runId);
      held = false;
      await stream.next(ofRun(runId, 'owner_lost'));
      expect(signals[0].aborted).toBe(true);
      oldOwner.resolve({ observedStatus: 'running' });
      await oldOwner.promise;
    } finally {
      oldOwner.resolve(null);
      await stream.close();
    }
    expect(signals).toHaveLength(2);
    expect(stream.lines.filter(ofRun(runId, 'owner_lost'))).toHaveLength(1);
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
