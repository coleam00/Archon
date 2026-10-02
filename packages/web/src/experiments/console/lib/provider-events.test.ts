import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  GAP_FETCH_ATTEMPTS,
  createProviderEventStore,
  findProviderEventGap,
  mergeProviderEventRecords,
  type ProviderEventCursor,
  type ProviderEventRecord,
} from './provider-events';

function rec(attemptId: string | null, seq: number, stepName = 'build'): ProviderEventRecord {
  return {
    runId: 'r1',
    stepName,
    attemptId,
    seq,
    observedAt: '2026-10-02T10:00:00.000Z',
    event: { type: 'agent_message_chunk', text: `${String(attemptId)}-${String(seq)}` },
  };
}

type FetchCall = [string, string, ProviderEventCursor | undefined];

/** A store whose fetches resolve when the test says, so ordering is explicit. */
function harness(): {
  store: ReturnType<typeof createProviderEventStore>;
  calls: FetchCall[];
  resolveNext: (records: ProviderEventRecord[]) => Promise<void>;
  records: () => Array<[string | null, number]>;
} {
  const calls: FetchCall[] = [];
  const pending: Array<(records: ProviderEventRecord[]) => void> = [];
  const fetcher = mock(
    (runId: string, stepName: string, after?: ProviderEventCursor) =>
      new Promise<ProviderEventRecord[]>(resolve => {
        calls.push([runId, stepName, after]);
        pending.push(resolve);
      })
  );
  const store = createProviderEventStore(fetcher);
  return {
    store,
    calls,
    resolveNext: async records => {
      pending.shift()?.(records);
      // Let the fetch's then/finally run.
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    records: () =>
      (store.snapshot('r1').get('build') ?? []).map(
        r => [r.attemptId, r.seq] as [string | null, number]
      ),
  };
}

describe('provider-event store', () => {
  test('a node loads once; live frames append without a fetch, and duplicates are ignored', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    h.store.load('r1', 'build');
    expect(h.calls).toEqual([['r1', 'build', undefined]]);
    await h.resolveNext([rec('a', 0), rec('a', 1)]);

    h.store.receive(rec('a', 2));
    h.store.receive(rec('a', 2));
    h.store.receive(rec('a', 3));

    expect(h.calls).toHaveLength(1);
    expect(h.records()).toEqual([
      ['a', 0],
      ['a', 1],
      ['a', 2],
      ['a', 3],
    ]);
  });

  test('a skipped seq closes with one cursor fetch from the last contiguous event', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    await h.resolveNext([rec('a', 0)]);

    h.store.receive(rec('a', 3));
    h.store.receive(rec('a', 4)); // a fetch is already in flight: no second one

    expect(h.calls.slice(1)).toEqual([['r1', 'build', { attemptId: 'a', seq: 0 }]]);
    await h.resolveNext([rec('a', 1), rec('a', 2), rec('a', 3)]);
    expect(h.records()).toEqual([0, 1, 2, 3, 4].map(seq => ['a', seq]));
  });

  test('a gap the server cannot fill yet stays open until the next frame retries it', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    await h.resolveNext([rec('a', 0)]);
    h.store.receive(rec('a', 2));
    await h.resolveNext([]); // seq 1 not committed yet
    expect(h.calls).toHaveLength(2);

    h.store.receive(rec('a', 3));
    expect(h.calls[2]).toEqual(['r1', 'build', { attemptId: 'a', seq: 0 }]);
    await h.resolveNext([rec('a', 1)]);
    expect(h.records()).toEqual([0, 1, 2, 3].map(seq => ['a', seq]));
  });

  test('a hole whose row never arrives stops costing a fetch per frame', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    await h.resolveNext([rec('a', 0)]);
    for (let seq = 2; seq < 2 + GAP_FETCH_ATTEMPTS + 3; seq++) {
      h.store.receive(rec('a', seq));
      await h.resolveNext([]); // seq 1's write failed: it never comes back
    }
    expect(h.calls).toHaveLength(1 + GAP_FETCH_ATTEMPTS);
    // A reconnect still asks again.
    h.store.catchUp('r1');
    expect(h.calls.at(-1)).toEqual(['r1', 'build', { attemptId: 'a', seq: 0 }]);
  });

  test('a finished node catches up its tail, and other nodes only their holes', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    await h.resolveNext([rec('a', 0)]);
    h.store.load('r1', 'group.inner');
    await h.resolveNext([rec('g', 0, 'group.inner'), rec('g', 2, 'group.inner')]);
    await h.resolveNext([]); // the load's own gap check
    h.store.load('r1', 'other');
    await h.resolveNext([rec('o', 0, 'other')]);
    h.calls.length = 0;

    h.store.nodeFinished('r1', 'build');

    expect(h.calls).toEqual([
      ['r1', 'build', { attemptId: 'a', seq: 0 }],
      ['r1', 'group.inner', { attemptId: 'g', seq: 0 }],
    ]);
  });

  test('frames that arrive while a node loads merge with the load', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    h.store.receive(rec('a', 2));
    await h.resolveNext([rec('a', 0), rec('a', 1)]);
    expect(h.records()).toEqual([0, 1, 2].map(seq => ['a', seq]));
    expect(h.calls).toHaveLength(1);
  });

  test('a reconnect catches a loaded node up from its last event', async () => {
    const h = harness();
    h.store.load('r1', 'build');
    await h.resolveNext([rec(null, 0), rec('a', 0)]);
    h.store.catchUp('r1');
    expect(h.calls[1]).toEqual(['r1', 'build', { attemptId: 'a', seq: 0 }]);
  });
});

describe('findProviderEventGap', () => {
  test('a new attempt whose start is missing is fetched after the previous attempt', () => {
    expect(findProviderEventGap([rec('a', 0), rec('a', 1), rec('b', 2)])).toEqual({
      attemptId: 'a',
      seq: 1,
    });
  });

  test('with nothing to anchor a cursor, the whole node is fetched', () => {
    expect(findProviderEventGap([rec(null, 0), rec('a', 1)])).toBe('all');
  });

  test('legacy records and contiguous attempts have no gap', () => {
    expect(findProviderEventGap([rec(null, 0), rec(null, 1), rec('a', 0), rec('b', 0)])).toBe(null);
  });
});

describe('mergeProviderEventRecords', () => {
  // The engine orders served records by the same rule (orderProviderEventRecords in
  // @archon/workflows), which the console cannot import; both run this fixture.
  test('orders records by the shared ordering fixture', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../../../workflows/src/schemas/provider-event-order.fixture.json',
          import.meta.url
        ),
        'utf-8'
      )
    ) as {
      input: Array<{ attemptId: string | null; seq: number }>;
      expected: Array<{ attemptId: string | null; seq: number }>;
    };
    const merged = mergeProviderEventRecords(
      [],
      fixture.input.map(r => rec(r.attemptId, r.seq))
    );
    expect(merged.map(r => ({ attemptId: r.attemptId, seq: r.seq }))).toEqual(fixture.expected);
  });
});
