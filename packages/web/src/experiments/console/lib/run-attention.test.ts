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

/** A fake server: `current` is what a fetch returns now; the seed resolves on `seed()`. */
function harness(initial: Run[]): {
  current: Map<string, Run>;
  alerted: string[];
  errors: string[];
  watcher: RunAttentionWatcher;
  seed: () => Promise<void>;
  change: (next: Run) => Promise<void>;
} {
  const current = new Map(initial.map(r => [r.id, r]));
  const alerted: string[] = [];
  const errors: string[] = [];
  let resolveSeed: (() => void) | undefined;
  const seedReady = new Promise<void>(resolve => {
    resolveSeed = resolve;
  });
  const watcher = watchRunAttention(
    {
      listRuns: async () => {
        await seedReady;
        return [...current.values()];
      },
      getRun: async id => {
        const found = current.get(id);
        if (found === undefined) throw new Error(`run ${id} not found`);
        return found;
      },
    },
    {
      onAttention: r => alerted.push(`${r.id}:${r.status}`),
      onError: e => errors.push(e.message),
    }
  );
  return {
    current,
    alerted,
    errors,
    watcher,
    seed: async () => {
      resolveSeed?.();
      await flush();
    },
    change: async next => {
      current.set(next.id, next);
      watcher.runChanged(next.id);
      await flush();
    },
  };
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

  test('a stopped watcher alerts nothing', async () => {
    const h = harness([run('r1')]);
    await h.seed();
    h.watcher.stop();

    await h.change(run('r1', { status: 'completed' }));

    expect(h.alerted).toEqual([]);
  });
});
