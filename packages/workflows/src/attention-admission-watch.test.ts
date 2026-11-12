import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { SourceReceiptAcceptance } from './schemas/resource-start';
import { createFileWorkflowStore } from './file-store';
import { resourceStartFixtures } from './resource-start-conformance';
import {
  attentionCoordinates,
  attentionCursor,
  attentionFeedStart,
  readAttentionFeed,
} from './attention-feed';
import {
  attentionStreamLineSchema,
  watchAttentionQueue,
  type AttentionStreamLine,
} from './attention-watch';
import { attentionWatchReader } from './attention-needs';
import { WorkflowEventCursorError, type IWorkflowStore } from './store';

const roots = trackTempRoots();
const host = { branchOf: async () => null };

async function fixture() {
  const root = roots(await mkdtemp(join(tmpdir(), 'admission-watch-')));
  const store = await createFileWorkflowStore({ root });
  const { start } = resourceStartFixtures('codebase', 'conversation');
  const holder = start();
  await store.admitResourceStart(holder);
  const drop = async (
    deliveryId: string | null,
    sourceId: string | null = null,
    codebaseId = 'codebase'
  ) => {
    const input: SourceReceiptAcceptance = {
      receipt: {
        id: crypto.randomUUID(),
        sourceInstanceId: 'source',
        deliveryId,
        contentDigest: 'digest',
        receivedAt: '2026-01-01T00:00:00.000Z',
        occurredAt: null,
        sourceActor:
          sourceId === null ? null : { source: 'archon-run', id: sourceId, display: 'handoff' },
      },
      outcome: 'matched' as const,
      bindings: [
        {
          bindingId: 'binding',
          bindingRevision: null,
          hostId: 'host',
          runAsUserId: 'operator',
          resource: holder.resource,
          capacity: 1,
          overlap: 'skip' as const,
          launch: {
            cwd: '/test',
            workflowName: 'target',
            inputs: {},
            isolation: { kind: 'in-place' as const },
          },
        },
      ],
    };
    const receipt = await store.acceptStartReceipt(input);
    if (receipt.replay) return null;
    const identity = { receiptId: receipt.receiptId, bindingId: 'binding', ownerId: 'owner' };
    await store.claimStartBindingPreparation(identity);
    const prepared = resourceStartFixtures(codebaseId, 'conversation').launch(undefined, {
      cwd: '/test',
    });
    expect(
      await store.completeStartBindingPreparation({ ...identity, launch: prepared })
    ).toMatchObject({ status: 'skipped' });
    return prepared.run.id;
  };
  return { root, store, holder, drop };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('watch did not deliver');
    await Bun.sleep(5);
  }
}

test('live dropped fires retain terminal attribution, runless context and replay after reopening', async () => {
  const { root, store, holder, drop } = await fixture();
  const source = await store.createWorkflowRun({ workflow_name: 'source', user_message: '' });
  await store.cancelWorkflowRun(source.id);
  await drop('retained');
  const before = await store.getWorkflowRun(holder.launch.run.id);
  const lines: AttentionStreamLine[] = [];
  const stream = await watchAttentionQueue(
    store,
    host,
    line => {
      lines.push(attentionStreamLineSchema.parse(line));
    },
    { scope: { kind: 'all' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
  );
  const ready = lines.find(line => line.type === 'ready');
  if (ready?.type !== 'ready') throw new Error('no ready');
  try {
    const request = await drop('from-run', source.id);
    await until(() =>
      lines.some(line => line.type === 'notice' && line.labels.request === request)
    );
    expect(await drop('from-run', source.id)).toBeNull();
    await drop(null);
    const runless = await drop('runless');
    await until(() => lines.filter(line => line.type === 'notice').length === 2);
    const notices = lines.filter(line => line.type === 'notice');
    expect(notices[0]).toMatchObject({
      runId: source.id,
      workflow: 'source',
      node: 'handoff',
      labels: {
        request,
        binding: 'binding',
        resource: holder.resource,
        blocker: holder.launch.run.id,
      },
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(notices[1]).toMatchObject({
      runId: null,
      workflow: null,
      parentRunId: null,
      node: null,
      labels: { request: runless },
    });
    expect(notices[1]?.project).not.toBeNull();
    expect(notices.every(line => attentionWatchReader('quiet')(line) === undefined)).toBe(true);
    expect(notices.map(line => attentionWatchReader('notices')(line)?.needs)).toEqual([
      'nothing',
      'nothing',
    ]);
    expect(await store.getWorkflowRun(holder.launch.run.id)).toEqual(before);
    await stream.close();
    const reopened = await createFileWorkflowStore({ root });
    const replay: AttentionStreamLine[] = [];
    const second = await watchAttentionQueue(
      reopened,
      host,
      line => {
        replay.push(line);
      },
      { scope: { kind: 'all' }, after: ready.cursor, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    );
    try {
      await until(() => replay.filter(line => line.type === 'notice').length === 2);
      expect(
        replay.filter(line => line.type === 'notice').map(line => line.labels.request)
      ).toEqual([request!, runless!]);
    } finally {
      await second.close();
    }
  } finally {
    await stream.close();
  }
});

test('bounded mixed pages advance each source only through accepted deliveries and support legacy cursors', async () => {
  const { store, drop } = await fixture();
  const legacy = await store.getWorkflowEventHead();
  const start = await attentionFeedStart(store);
  const requests = [await drop('a'), await drop('b'), await drop('c')];
  await store.persistWorkflowEvent({
    workflow_run_id: (await store.listWorkflowRuns()).runs[0]!.id,
    event_type: 'workflow_started',
  });
  const page = await readAttentionFeed(store, start, 1);
  expect(page.deliveries.map(row => row.kind)).toEqual(['workflow', 'admission']);
  expect(page.caughtUp).toBe(false);
  const workflow = page.deliveries[0]!;
  expect(attentionCoordinates(workflow.cursor).admission).toBe(
    attentionCoordinates(start).admission
  );
  const retry = await readAttentionFeed(store, workflow.cursor, 1);
  expect(retry.deliveries).toEqual(page.deliveries.slice(1));
  const second = await readAttentionFeed(store, retry.next, 1);
  const third = await readAttentionFeed(store, second.next, 1);
  expect(
    [...retry.deliveries, ...second.deliveries, ...third.deliveries].map(row =>
      row.kind === 'admission' ? row.facts.requestId : null
    )
  ).toEqual(requests);
  expect(third.caughtUp).toBe(true);
  const oldConnection = await attentionFeedStart(store, legacy);
  expect(
    (await readAttentionFeed(store, oldConnection, 10)).deliveries.map(row => row.kind)
  ).toEqual(['workflow']);
  await drop('future');
  expect(
    (await readAttentionFeed(store, oldConnection, 10)).deliveries.map(row => row.kind)
  ).toEqual(['workflow', 'admission']);
  for (const bad of ['attention:v2:[]', 'attention:v1:[]', 'attention:v1:["wrong","wrong"]'])
    await expect(attentionFeedStart(store, attentionCursor(bad))).rejects.toBeInstanceOf(
      WorkflowEventCursorError
    );
});

test.each(['read', 'projection', 'listener'] as const)(
  'admission %s failures retain progress and suppress bookmarks until recovery',
  async mode => {
    const { store, drop } = await fixture();
    const after = await attentionFeedStart(store);
    await drop('retry');
    const failing: IWorkflowStore = Object.create(store);
    let broken = false;
    let failures = 0;
    const fail = () => {
      failures++;
      throw new Error('unavailable');
    };
    failing.readAdmissionNoticesAfter = (cursor, options) =>
      broken && mode === 'read'
        ? Promise.reject(new Error('read unavailable')).finally(() => {
            failures++;
          })
        : store.readAdmissionNoticesAfter(cursor, options);
    failing.getCodebase = id =>
      broken && mode === 'projection' ? Promise.resolve().then(fail) : store.getCodebase(id);
    const lines: AttentionStreamLine[] = [];
    const stream = await watchAttentionQueue(
      failing,
      host,
      line => {
        if (line.type === 'ready') broken = true;
        if (broken && mode === 'listener' && line.type === 'notice') fail();
        lines.push(line);
      },
      { scope: { kind: 'all' }, after, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    );
    try {
      lines.length = 0;
      await until(() => failures >= 3);
      expect(lines.some(line => line.type === 'bookmark' || line.type === 'notice')).toBe(false);
      broken = false;
      await until(() => lines.some(line => line.type === 'bookmark'));
      expect(lines.filter(line => line.type === 'notice')).toHaveLength(1);
    } finally {
      await stream.close();
    }
  }
);

test.each(['run', 'source-project', 'binding-project'] as const)(
  'an unreadable admission %s cannot block independent notices or workflow events',
  async boundary => {
    const { store, drop } = await fixture();
    const source = await store.createWorkflowRun({
      workflow_name: 'source',
      user_message: '',
      ...(boundary === 'source-project' ? { codebase_id: 'codebase' } : {}),
    });
    const independent = await store.createWorkflowRun({
      workflow_name: 'independent',
      user_message: '',
    });
    const failing: IWorkflowStore = Object.create(store);
    let broken = false;
    failing.getWorkflowRun = id =>
      broken && boundary === 'run' && id === source.id
        ? Promise.reject(new Error('private source failure'))
        : store.getWorkflowRun(id);
    failing.getCodebase = id =>
      broken && boundary !== 'run' && id === 'codebase'
        ? Promise.reject(new Error('private project failure'))
        : store.getCodebase(id);
    const lines: AttentionStreamLine[] = [];
    const stream = await watchAttentionQueue(
      failing,
      host,
      line => {
        lines.push(line);
      },
      { scope: { kind: 'all' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    );
    let bad: string | null = null;
    try {
      broken = true;
      bad = await drop('unreadable', boundary === 'binding-project' ? null : source.id);
      await until(() => lines.some(line => line.type === 'degraded'));
      const good = await drop('readable', independent.id);
      await until(() => lines.some(line => line.type === 'notice' && line.labels.request === good));
      await store.persistWorkflowEvent({
        workflow_run_id: independent.id,
        event_type: 'workflow_resumed',
      });
      await until(() =>
        lines.some(line => line.type === 'resumed' && line.runId === independent.id)
      );
      await until(() => lines.some(line => line.type === 'bookmark'));
      expect(lines.filter(line => line.type === 'notice').map(line => line.labels.request)).toEqual(
        [good!]
      );
      expect(JSON.stringify(lines)).not.toContain('private');
    } finally {
      await stream.close();
    }
    broken = false;
    const ready = lines.find(line => line.type === 'ready');
    if (!ready) throw new Error('no ready');
    const replay: AttentionStreamLine[] = [];
    const recovered = await watchAttentionQueue(
      failing,
      host,
      line => {
        replay.push(line);
      },
      { scope: { kind: 'all' }, after: ready.cursor, pollIntervalMs: 5 }
    );
    try {
      await until(() => replay.filter(line => line.type === 'notice').length === 2);
      expect(replay.filter(line => line.type === 'notice')[0]?.labels.request).toBe(bad!);
    } finally {
      await recovered.close();
    }
  }
);

test('admissions from a deleted source can witness a different binding project', async () => {
  const { store, drop } = await fixture();
  const source = await store.createWorkflowRun({ workflow_name: 'source', user_message: '' });
  await store.cancelWorkflowRun(source.id);
  await store.deleteWorkflowRun(source.id);
  const failing: IWorkflowStore = Object.create(store);
  failing.getCodebase = id =>
    id === 'codebase'
      ? Promise.reject(new Error('private project failure'))
      : store.getCodebase(id);
  const lines: AttentionStreamLine[] = [];
  const stream = await watchAttentionQueue(
    failing,
    host,
    line => {
      lines.push(line);
    },
    { scope: { kind: 'all' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
  );
  try {
    await drop('unreadable', source.id);
    await until(() => lines.some(line => line.type === 'degraded'));
    const good = await drop('readable', source.id, 'other-codebase');
    await until(() => lines.some(line => line.type === 'notice' && line.labels.request === good));
    await until(() => lines.some(line => line.type === 'bookmark'));
    expect(lines.filter(line => line.type === 'notice')).toMatchObject([
      { runId: source.id, workflow: null, labels: { request: good } },
    ]);
  } finally {
    await stream.close();
  }
});

test('a workflow delivery can witness an admission from the same deleted source', async () => {
  const { store, drop } = await fixture();
  const source = await store.createWorkflowRun({ workflow_name: 'source', user_message: '' });
  const after = await attentionFeedStart(store);
  await drop('unreadable', source.id);
  const page = await readAttentionFeed(store, after, 100);
  const delivery = page.deliveries.find(row => row.kind === 'admission');
  if (!delivery) throw new Error('no admission');
  await store.cancelWorkflowRun(source.id);
  await store.deleteWorkflowRun(source.id);
  const failing: IWorkflowStore = Object.create(store);
  failing.getCodebase = () => Promise.reject(new Error('private project failure'));
  const { admissionWorkflowNotice } = await import('./workflow-notice');
  const { hasReadableAttentionWitness } = await import('./attention-watch-witness');
  await expect(admissionWorkflowNotice({ store: failing }, delivery.facts, null)).rejects.toThrow();
  expect(
    await hasReadableAttentionWitness(
      store,
      delivery,
      async candidate => {
        if (candidate.kind === 'workflow')
          return store.getWorkflowRun(candidate.event.workflow_run_id);
        return admissionWorkflowNotice({ store: failing }, candidate.facts, null);
      },
      () => false
    )
  ).toBe(true);
});

test('an admission witnesses a workflow projection failure for the same source', async () => {
  const { store, drop } = await fixture();
  const source = await store.createWorkflowRun({ workflow_name: 'source', user_message: '' });
  await store.claimPendingWorkflowRun(source.id);
  let broken = false;
  const lines: AttentionStreamLine[] = [];
  const stream = await watchAttentionQueue(
    store,
    {
      branchOf: async () => {
        if (broken) throw new Error('private branch failure');
        return null;
      },
    },
    line => {
      lines.push(line);
    },
    { scope: { kind: 'all' }, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
  );
  try {
    broken = true;
    await store.pauseWorkflowRun(
      source.id,
      {
        nodeId: 'review',
        message: 'Ship?',
        type: 'approval',
        pauseId: crypto.randomUUID(),
      },
      undefined,
      { workflow_run_id: source.id, event_type: 'node_suspended', step_name: 'review', data: {} }
    );
    await until(() => lines.some(line => line.type === 'degraded'));
    const good = await drop('readable', source.id);
    await until(() => lines.some(line => line.type === 'notice' && line.labels.request === good));
    expect(lines.filter(line => line.type === 'notice')).toHaveLength(1);
  } finally {
    await stream.close();
  }
});

test('closing waits for an in-flight admission read and delivers nothing after closing', async () => {
  const { store } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const feed: IWorkflowStore = Object.create(store);
  feed.readAdmissionNoticesAfter = async (cursor, options) => {
    entered.resolve();
    await release.promise;
    return store.readAdmissionNoticesAfter(cursor, options);
  };
  const lines: AttentionStreamLine[] = [];
  const stream = await watchAttentionQueue(
    feed,
    host,
    line => {
      lines.push(line);
    },
    { scope: { kind: 'all' }, pollIntervalMs: 5 }
  );
  await entered.promise;
  let closed = false;
  const closing = stream.close().then(() => {
    closed = true;
  });
  try {
    await Bun.sleep(5);
    expect(closed).toBe(false);
  } finally {
    release.resolve();
    await closing;
  }
  expect(lines.map(line => line.type)).toEqual(['ready']);
});

test('admission watches apply project and label filters and checkpoint only accepted notices', async () => {
  const { store, drop } = await fixture();
  const after = await attentionFeedStart(store);
  const first = await drop('first');
  const second = await drop('second');
  const page = await readAttentionFeed(store, after, 10);
  const facts = page.deliveries.find(row => row.kind === 'admission')?.facts;
  if (!facts) throw new Error('no admission');
  const { admissionWorkflowNotice } = await import('./workflow-notice');
  const notice = await admissionWorkflowNotice({ store }, facts, null);
  if (notice.project === null) throw new Error('no project');
  for (const [scope, labels, expected] of [
    [{ kind: 'project', project: notice.project }, { kind: 'admission-skipped' }, 2],
    [{ kind: 'project', project: { ...notice.project, key: 'other' } }, {}, 0],
    [{ kind: 'all' }, { kind: 'other' }, 0],
  ] as const) {
    const lines: AttentionStreamLine[] = [];
    let accepting = false;
    let failures = 0;
    const stream = await watchAttentionQueue(
      store,
      host,
      line => {
        if (line.type === 'notice' && line.labels.request === second && !accepting) {
          failures++;
          throw new Error('consumer unavailable');
        }
        lines.push(line);
      },
      { scope, labels, after, pollIntervalMs: 5, bookmarkIntervalMs: 0 }
    );
    try {
      if (expected > 0) {
        await until(() => failures >= 2);
        expect(
          lines.filter(line => line.type === 'notice').map(line => line.labels.request)
        ).toEqual([first!]);
        expect(lines.some(line => line.type === 'bookmark')).toBe(false);
      }
      accepting = true;
      await until(() => lines.some(line => line.type === 'bookmark'));
      expect(lines.filter(line => line.type === 'notice')).toHaveLength(expected);
    } finally {
      await stream.close();
    }
  }
});

test('witness probing crosses empty nonterminal admission pages', async () => {
  const { store, drop } = await fixture();
  const after = await attentionFeedStart(store);
  await drop('unreadable', crypto.randomUUID());
  const page = await readAttentionFeed(store, after, 100);
  const unreadable = page.deliveries.find(row => row.kind === 'admission');
  if (!unreadable) throw new Error('no admission');
  for (let i = 0; i < 35; i++) await drop(null);
  const readable = await drop('readable');
  const empty = await readAttentionFeed(store, unreadable.cursor, 100);
  expect(empty.deliveries).toHaveLength(0);
  expect(empty.caughtUp).toBe(false);
  const tail = await readAttentionFeed(store, empty.next, 100);
  expect(tail.caughtUp).toBe(true);
  expect(tail.deliveries).toMatchObject([{ kind: 'admission', facts: { requestId: readable } }]);
  const { hasReadableAttentionWitness } = await import('./attention-watch-witness');
  const probed: string[] = [];
  expect(
    await hasReadableAttentionWitness(
      store,
      unreadable,
      async candidate => {
        if (candidate.kind === 'admission') probed.push(candidate.facts.requestId);
      },
      () => false
    )
  ).toBe(true);
  expect(probed).toEqual([readable!]);
});
