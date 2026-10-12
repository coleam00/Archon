import { describe, expect, test } from 'bun:test';
import type { Run } from '../primitives/run';
import { watchRunAttention, type RunAttentionWatcher } from './run-attention';

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    projectId: null,
    projectName: null,
    costUsd: null,
    conversationId: null,
    conversationPlatformId: null,
    workerPlatformId: null,
    workflow: 'implement',
    origin: 'cli',
    status: 'running',
    outcome: null,
    terminalRecord: null,
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: null,
    workingPath: null,
    userMessage: '',
    activeNodes: [],
    ...over,
  };
}

const gate: Run['approval'] = {
  nodeId: 'review',
  message: 'Approve?',
  completionSignaled: false,
  decisions: [],
  decisionsAuthored: false,
};

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A fake server: `current` is what a fetch returns now; the seed resolves on `seed()`.
 * `failing` makes every read throw; `pageSize` splits the seed into pages.
 */
function harness(
  initial: Run[],
  pageSize = 100
): {
  current: Map<string, Run>;
  alerted: string[];
  errors: string[];
  recovered: number;
  failing: { on: boolean };
  watcher: RunAttentionWatcher;
  seed: () => Promise<void>;
  change: (next: Run) => Promise<void>;
} {
  const current = new Map(initial.map(r => [r.id, r]));
  const failing = { on: false };
  const result = {
    current,
    alerted: [] as string[],
    errors: [] as string[],
    recovered: 0,
    failing,
  };
  let resolveSeed: (() => void) | undefined;
  const seedReady = new Promise<void>(resolve => {
    resolveSeed = resolve;
  });
  const watcher = watchRunAttention(
    {
      listRuns: async offset => {
        await seedReady;
        if (failing.on) throw new Error('listing failed');
        const all = [...current.values()];
        return { runs: all.slice(offset, offset + pageSize), total: all.length };
      },
      getRun: async id => {
        if (failing.on) throw new Error(`reading ${id} failed`);
        const found = current.get(id);
        if (found === undefined) throw new Error(`run ${id} not found`);
        return found;
      },
    },
    {
      onAttention: r => result.alerted.push(`${r.id}:${r.status}`),
      onError: e => result.errors.push(e.message),
      onRecovered: () => {
        result.recovered++;
      },
    }
  );
  return Object.assign(result, {
    watcher,
    seed: async () => {
      resolveSeed?.();
      await flush();
    },
    change: async (next: Run) => {
      current.set(next.id, next);
      watcher.runChanged(next.id);
      await flush();
    },
  });
}

describe('watchRunAttention', () => {
  test('runs already waiting or finished at load never alert, even when their events replay', async () => {
    const h = harness([
      run('paused', { status: 'paused', approval: gate }),
      run('done', { status: 'completed' }),
    ]);
    h.watcher.runChanged('paused');
    h.watcher.runChanged('done');
    await h.seed();
    h.watcher.runChanged('paused');
    await flush();

    expect(h.alerted).toEqual([]);
  });

  test('a change reported before the seed lands still alerts when the run actually moved', async () => {
    const h = harness([run('r1')]);
    await flush();
    h.watcher.runChanged('r1');
    await flush();
    expect(h.alerted).toEqual([]);

    // The seed is read after the pause, so the pause is already part of the load state.
    h.current.set('r1', run('r1', { status: 'paused', approval: gate }));
    await h.seed();
    expect(h.alerted).toEqual([]);

    await h.change(run('r1', { status: 'completed' }));
    expect(h.alerted).toEqual(['r1:completed']);
  });

  test('alerts once when a run pauses on a gate, however often the change is reported', async () => {
    const h = harness([run('r1')]);
    await h.seed();

    await h.change(run('r1', { status: 'paused', approval: gate }));
    h.watcher.runChanged('r1');
    h.watcher.runChanged('r1');
    await flush();

    expect(h.alerted).toEqual(['r1:paused']);
  });

  test('alerts again when the run resumes and stops at another gate', async () => {
    const h = harness([run('r1')]);
    await h.seed();

    await h.change(run('r1', { status: 'paused', approval: gate }));
    await h.change(run('r1', { status: 'paused', approval: null, gateResolved: 'approved' }));
    await h.change(run('r1'));
    await h.change(run('r1', { status: 'paused', approval: { ...gate, nodeId: 'ship' } }));

    expect(h.alerted).toEqual(['r1:paused', 'r1:paused']);
  });

  test('alerts once per terminal state, including for runs started after load', async () => {
    const h = harness([run('r1'), run('r2')]);
    await h.seed();

    await h.change(run('r1', { status: 'failed' }));
    await h.change(run('r1', { status: 'failed' }));
    await h.change(run('r2', { status: 'cancelled' }));
    await h.change(run('new', { status: 'completed' }));

    expect(h.alerted).toEqual(['r1:failed', 'r2:cancelled', 'new:completed']);
  });

  test('a run resumed after failing alerts again when it finishes', async () => {
    const h = harness([run('r1', { status: 'failed' })]);
    await h.seed();

    await h.change(run('r1'));
    await h.change(run('r1', { status: 'completed' }));

    expect(h.alerted).toEqual(['r1:completed']);
  });

  test('an attention wait needs a human; event and scheduled waits do not', async () => {
    const h = harness([run('event'), run('time'), run('action')]);
    await h.seed();

    await h.change(
      run('event', {
        status: 'paused',
        wait: {
          kind: 'event',
          nodeId: 'w',
          event: 'deploy.done',
          waitingSince: '2026-10-01T10:00:00.000Z',
          resumeAt: '2026-10-01T11:00:00.000Z',
        },
      })
    );
    await h.change(
      run('time', {
        status: 'paused',
        wait: {
          kind: 'time',
          nodeId: 'w',
          waitingSince: '2026-10-01T10:00:00.000Z',
          resumeAt: '2026-10-01T11:00:00.000Z',
        },
      })
    );
    await h.change(
      run('action', {
        status: 'paused',
        wait: {
          kind: 'attention',
          nodeId: 'w',
          waitingSince: '2026-10-01T10:00:00.000Z',
          message: 'Rotate the key',
        },
      })
    );

    expect(h.alerted).toEqual(['action:paused']);
  });

  test('reports a failed fetch and keeps watching other runs', async () => {
    const h = harness([run('r1')]);
    await h.seed();

    h.watcher.runChanged('missing');
    await h.change(run('r1', { status: 'completed' }));

    expect(h.errors).toEqual(['run missing not found']);
    expect(h.alerted).toEqual(['r1:completed']);
  });

  test('seeds every run at load, across as many pages as the server returns', async () => {
    const h = harness(
      [run('c'), run('a', { status: 'completed' }), run('b', { status: 'failed' })],
      2
    );
    await h.seed();

    h.watcher.runChanged('b');
    await h.change(run('c', { status: 'completed' }));

    expect(h.alerted).toEqual(['c:completed']);
  });

  test('a failed seed is retried on the next change, and load-time runs still stay silent', async () => {
    const h = harness([run('done', { status: 'completed' }), run('r1')]);
    h.failing.on = true;
    await h.seed();
    expect(h.errors).toEqual(['listing failed']);

    h.failing.on = false;
    h.watcher.runChanged('done');
    await flush();
    await h.change(run('r1', { status: 'paused', approval: gate }));

    expect(h.alerted).toEqual(['r1:paused']);
    expect(h.recovered).toBe(1);
  });

  test('a run whose read failed is read again on the next change, so its alert is not lost', async () => {
    const h = harness([run('r1'), run('r2')]);
    await h.seed();

    h.failing.on = true;
    await h.change(run('r1', { status: 'completed' }));
    expect(h.errors).toEqual(['reading r1 failed']);
    expect(h.alerted).toEqual([]);

    h.failing.on = false;
    await h.change(run('r2'));

    expect(h.alerted).toEqual(['r1:completed']);
    expect(h.recovered).toBe(1);
  });

  test('a stopped watcher alerts nothing', async () => {
    const h = harness([run('r1')]);
    await h.seed();
    h.watcher.stop();

    await h.change(run('r1', { status: 'completed' }));

    expect(h.alerted).toEqual([]);
  });
});

test('running tool advisories alert only on new occurrence identities', async () => {
  const call = {
    streamId: 's',
    nodeId: 'node',
    provider: 'codex',
    toolCallId: 'call',
    name: 'bash',
    title: 'COMMAND_SENTINEL',
    startedAt: '2026-10-01T00:00:00Z',
    lastProgressAt: '2026-10-01T00:00:00Z',
    raisedAt: '2026-10-01T00:30:00Z',
    thresholdMs: 1800000,
  };
  const h = harness([run('live', { toolCallAttention: [call] })]);
  await h.seed();
  await h.change(run('live', { toolCallAttention: [call] }));
  expect(h.alerted).toEqual([]);
  const second = { ...call, toolCallId: 'second' };
  await h.change(run('live', { toolCallAttention: [call, second] }));
  expect(h.alerted).toEqual(['live:running']);
  await h.change(run('live', { toolCallAttention: [second] }));
  await h.change(run('live', { toolCallAttention: [] }));
  expect(h.alerted).toHaveLength(1);
  await h.change(
    run('live', { toolCallAttention: [{ ...call, raisedAt: '2026-10-01T01:00:00Z' }] })
  );
  expect(h.alerted).toHaveLength(2);
  h.watcher.stop();
});
