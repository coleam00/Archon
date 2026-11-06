import { describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  attentionStreamLineSchema,
  watchAttentionQueue,
  type AttentionStreamLine,
} from '@archon/workflows/attention-watch';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { workflowEventCursor, type IWorkflowStore } from '@archon/workflows/store';
import type { AttentionWatchOptions } from '@archon/workflows/engine-port';
import { attentionSseIds, registerAttentionStreamRoute } from './api.run-attention';

// No registered codebases: `?project=` resolves only a project key.
const realCodebaseDb = { ...(await import('@archon/core/db/codebases')) };
mock.module('@archon/core/db/codebases', () => ({
  ...realCodebaseDb,
  listCodebases: async () => [],
}));

const roots = trackTempRoots();

async function makeStore(): Promise<IWorkflowStore> {
  return createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'archon-attention-stream-'))),
  });
}

function streamApp(store: IWorkflowStore): OpenAPIHono {
  const app = new OpenAPIHono();
  registerAttentionStreamRoute(app, (listener, options) =>
    watchAttentionQueue(store, { branchOf: async () => null }, listener, {
      ...options,
      pollIntervalMs: 5,
    })
  );
  return app;
}

async function running(store: IWorkflowStore): Promise<string> {
  const run = await store.createWorkflowRun({ workflow_name: 'wf', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  return run.id;
}

async function paused(store: IWorkflowStore): Promise<{ runId: string; pauseId: string }> {
  const runId = await running(store);
  const pauseId = randomUUID();
  await store.pauseWorkflowRunForWait(
    runId,
    {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: new Date().toISOString(),
      message: 'Which base?',
      pauseId,
      form: 'select',
      options: [{ id: 'main' }, { id: 'dev' }],
      labels: {},
    },
    { kind: 'started', stepName: 'ask' }
  );
  return { runId, pauseId };
}

interface SseEvent {
  id: string | undefined;
  line: AttentionStreamLine;
}

function parseSseEvent(block: string): SseEvent {
  const fields = block.split('\n');
  const id = fields.find(field => field.startsWith('id: '))?.slice(4);
  const data = fields
    .filter(field => field.startsWith('data: '))
    .map(field => field.slice(6))
    .join('\n');
  return { id, line: attentionStreamLineSchema.parse(JSON.parse(data)) };
}

/** Reads SSE events as a browser does, keeping the last id it was sent. */
function sseClient(response: Response): {
  events: SseEvent[];
  lastEventId: () => string | undefined;
  until: (match: (line: AttentionStreamLine) => boolean) => Promise<AttentionStreamLine>;
  done: Promise<void>;
  disconnect: () => Promise<void>;
} {
  if (!response.body) throw new Error('no body');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: SseEvent[] = [];
  let lastEventId: string | undefined;
  const done = (async (): Promise<void> => {
    let buffer = '';
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      const blocks = (buffer + chunk.value).split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const event of blocks.map(parseSseEvent)) {
        if (event.id !== undefined) lastEventId = event.id;
        events.push(event);
      }
    }
  })();
  const until = async (
    match: (line: AttentionStreamLine) => boolean
  ): Promise<AttentionStreamLine> => {
    for (let waited = 0; waited < 5000; waited += 5) {
      const found = events.find(event => match(event.line));
      if (found) return found.line;
      await Bun.sleep(5);
    }
    throw new Error(`no matching event in ${JSON.stringify(events)}`);
  };
  return {
    events,
    lastEventId: () => lastEventId,
    until,
    done,
    disconnect: async () => {
      await reader.cancel();
      await done;
    },
  };
}

const ofRun =
  (runId: string, type: AttentionStreamLine['type']) =>
  (line: AttentionStreamLine): boolean =>
    line.type === type && 'runId' in line && line.runId === runId;
const itemKey = (line: AttentionStreamLine): unknown =>
  line.type === 'attention'
    ? [line.item.runId, 'occurrence' in line.item ? line.item.occurrence : null, line.item.revision]
    : null;

describe('GET /api/runs/attention/stream', () => {
  test('a reconnect with Last-Event-ID misses no change made while disconnected', async () => {
    const store = await makeStore();
    const app = streamApp(store);
    const held = await paused(store);
    const answered = await paused(store);
    const finishing = await running(store);
    const early = await running(store);

    const response = await app.request('/api/runs/attention/stream');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const first = sseClient(response);
    await first.until(line => line.type === 'ready');
    await store.completeWorkflowRun(early, { duration_ms: 1 });
    const earlyTerminal = await first.until(ofRun(early, 'terminal'));
    await first.disconnect();
    const lastEventId = first.lastEventId();
    expect(lastEventId).toBeDefined();

    const late = await paused(store);
    await store.answerAttentionWait(answered.runId, {
      pauseId: answered.pauseId,
      answer: { decision: 'main', text: '' },
      answeredVia: 'cli',
      answeredAt: '2026-10-15T00:00:00.000Z',
    });
    await store.completeWorkflowRun(finishing, { duration_ms: 1 });

    const resumed = await app.request('/api/runs/attention/stream', {
      headers: { 'Last-Event-ID': lastEventId ?? '' },
    });
    const second = sseClient(resumed);
    await second.until(ofRun(finishing, 'terminal'));
    await second.disconnect();

    // The snapshot is the open set: the late pause is in it, the answered item is gone.
    const snapshotKeys = (client: typeof first): unknown[] =>
      client.events
        .filter(event => event.line.type === 'attention' && event.line.snapshot)
        .map(event => itemKey(event.line));
    expect(snapshotKeys(first)).toEqual(
      expect.arrayContaining([
        [held.runId, held.pauseId, 1],
        [answered.runId, answered.pauseId, 1],
      ])
    );
    expect(snapshotKeys(first)).toHaveLength(2);
    expect(snapshotKeys(second)).toEqual(
      expect.arrayContaining([
        [held.runId, held.pauseId, 1],
        [late.runId, late.pauseId, 1],
      ])
    );
    expect(snapshotKeys(second)).toHaveLength(2);
    // The id lags the event in progress, so the reconnect repeats it with the same key.
    expect(
      second.events.filter(event => ofRun(early, 'terminal')(event.line)).map(e => e.line)
    ).toEqual([earlyTerminal]);
  });

  test('a cursor the store cannot read ends the stream with one error event', async () => {
    const app = streamApp(await makeStore());
    const response = await app.request('/api/runs/attention/stream', {
      headers: { 'Last-Event-ID': 'not-a-cursor' },
    });
    const client = sseClient(response);
    await client.done;
    expect(client.events).toEqual([
      { id: undefined, line: { type: 'error', error: 'cursor_invalid' } },
    ]);
  });

  test('scopes the watch by project and label as the list route does', async () => {
    const seen: AttentionWatchOptions[] = [];
    const app = new OpenAPIHono();
    registerAttentionStreamRoute(app, async (listener, options) => {
      seen.push(options);
      await listener({ type: 'error', error: 'cursor_invalid' });
      return { close: async () => undefined };
    });
    const open = async (query: string): Promise<number> => {
      const response = await app.request(`/api/runs/attention/stream${query}`);
      await response.text();
      return response.status;
    };

    expect(await open('')).toBe(200);
    expect(await open('?project=acme%2Fsite&label=ci%3Dred&label=team%3Dweb')).toBe(200);
    expect(await open('?project=nowhere')).toBe(400);
    expect(await open('?label=ci%3Dred&label=ci%3Dgreen')).toBe(400);
    expect(seen.map(({ scope, labels }) => ({ scope, labels }))).toEqual([
      { scope: { kind: 'all' }, labels: {} },
      {
        scope: {
          kind: 'project',
          project: { key: 'acme/site', codebaseId: null, name: 'site' },
        },
        labels: { ci: 'red', team: 'web' },
      },
    ]);
  });
});

test('an SSE id names the last event all of whose lines were sent', () => {
  const at = (text: string) => workflowEventCursor(text);
  const run = { project: null, runId: 'r', workflow: 'wf', parentRunId: null };
  const idOf = attentionSseIds();
  const ids = [
    idOf({ type: 'unmatched', cursor: at('S'), ...run, occurrence: 'o', revision: 1 }),
    idOf({ type: 'ready', cursor: at('S') }),
    idOf({ type: 'resolved', cursor: at('X'), ...run, occurrence: 'o', reason: 'withdrawn' }),
    idOf({
      type: 'terminal',
      cursor: at('X'),
      ...run,
      status: 'completed',
      outcome: null,
      cause: null,
    }),
    idOf({ type: 'resolved', cursor: at('Y'), ...run, occurrence: 'o', reason: 'withdrawn' }),
    // Position-stamped lines interleave at the cursor before the delivery in progress.
    idOf({ type: 'owner_lost', cursor: at('X'), ...run, observedStatus: 'running' }),
    idOf({ type: 'degraded', reason: 'run_unreadable', cursor: at('X') }),
    idOf({ type: 'resumed', cursor: at('Y'), ...run, status: 'running' }),
    idOf({
      type: 'terminal',
      cursor: at('W'),
      ...run,
      status: 'failed',
      outcome: null,
      cause: null,
    }),
    idOf({ type: 'bookmark', cursor: at('Z') }),
    idOf({ type: 'error', error: 'cursor_invalid' }),
  ];
  expect(ids).toEqual([undefined, 'S', 'S', 'S', 'X', 'X', 'X', 'X', 'Y', 'Z', undefined]);
});
