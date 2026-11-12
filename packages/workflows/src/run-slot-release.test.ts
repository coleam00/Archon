import { describe, expect, test } from 'bun:test';
import {
  bindRunSlotReleaseStore,
  deferRunSlotRelease,
  holdRunSlotRelease,
  finishForcedRunSlotCleanup,
  publishRunSlotRelease,
  subscribeRunSlotRelease,
  withRunSlotReleaseScope,
} from './run-slot-release';

function channel(source = {}) {
  const store = bindRunSlotReleaseStore({}, () => source);
  const received: string[][] = [];
  const dispose = subscribeRunSlotRelease(store, async ids => {
    received.push([...ids]);
  });
  return { source, store, received, dispose };
}

describe('run slot release coordination', () => {
  test('awaits dispatch and isolates stores with the same run ID', async () => {
    const first = channel();
    const second = channel();
    const order: string[] = [];
    const dispose = subscribeRunSlotRelease(first.store, async () => {
      await Promise.resolve();
      order.push('dispatch');
    });
    try {
      await publishRunSlotRelease(first.source, 'run');
      order.push('returned');
      expect(order).toEqual(['dispatch', 'returned']);
      expect(first.received).toEqual([['run']]);
      expect(second.received).toEqual([]);
      first.dispose();
      dispose();
      await publishRunSlotRelease(first.source, 'run');
      expect(first.received).toEqual([['run']]);
    } finally {
      first.dispose();
      second.dispose();
      dispose();
    }
  });

  test('buffers nested releases until the outer scope finishes and coalesces runs', async () => {
    const c = channel();
    try {
      await withRunSlotReleaseScope(async () => {
        await publishRunSlotRelease(c.source, 'parent');
        await withRunSlotReleaseScope(async () => {
          await publishRunSlotRelease(c.source, 'child');
          await publishRunSlotRelease(c.source, 'parent');
        });
        expect(c.received).toEqual([]);
      });
      expect(c.received).toEqual([['parent', 'child']]);
    } finally {
      c.dispose();
    }
  });

  test('a continuation can finish after its admission scope has returned', async () => {
    const c = channel();
    const proceed = Promise.withResolvers<void>();
    let execution: Promise<void> | undefined;
    try {
      await withRunSlotReleaseScope(async () => {
        execution = withRunSlotReleaseScope(async () => {
          await proceed.promise;
          await publishRunSlotRelease(c.source, 'continued');
        });
      });
      expect(c.received).toEqual([]);
      proceed.resolve();
      await execution;
      expect(c.received).toEqual([['continued']]);
    } finally {
      proceed.resolve();
      await execution;
      c.dispose();
    }
  });

  test('workflow failure still dispatches a committed release after cleanup', async () => {
    const c = channel();
    try {
      await expect(
        withRunSlotReleaseScope(async () => {
          await publishRunSlotRelease(c.source, 'failed');
          throw new Error('workflow failure');
        })
      ).rejects.toThrow('workflow failure');
      expect(c.received).toEqual([['failed']]);
    } finally {
      c.dispose();
    }
  });

  test('concurrent cancellation waits for all execution and live-owner holds', async () => {
    const c = channel();
    const closeOwner = holdRunSlotRelease(c.store, 'run');
    const closeExecutor = holdRunSlotRelease(c.store, 'run');
    try {
      await withRunSlotReleaseScope(() => publishRunSlotRelease(c.source, 'run'));
      expect(c.received).toEqual([]);
      await closeExecutor();
      expect(c.received).toEqual([]);
      await closeOwner();
      await closeOwner();
      expect(c.received).toEqual([['run']]);
    } finally {
      await closeExecutor();
      await closeOwner();
      c.dispose();
    }
  });

  test('a hold on another store does not block the released run', async () => {
    const first = channel();
    const second = channel();
    const close = holdRunSlotRelease(first.store, 'run');
    try {
      await publishRunSlotRelease(second.source, 'run');
      expect(second.received).toEqual([['run']]);
      expect(first.received).toEqual([]);
    } finally {
      await close();
      first.dispose();
      second.dispose();
    }
  });

  test.each(['before', 'after'] as const)(
    'unsafe nested cleanup suppresses concurrent releases %s the scope exits',
    async timing => {
      const c = channel();
      const closeOwner = holdRunSlotRelease(c.store, 'run');
      try {
        await publishRunSlotRelease(c.source, 'run');
        await withRunSlotReleaseScope(async () => {
          const closeExecution = holdRunSlotRelease(c.store, 'run');
          await withRunSlotReleaseScope(async () => {
            await publishRunSlotRelease(c.source, 'child');
            deferRunSlotRelease();
          });
          await closeExecution();
          if (timing === 'before') await closeOwner();
        });
        await closeOwner();
        expect(c.received).toEqual([]);
        // A later explicit execution has its own cleanup outcome.
        const closeNext = holdRunSlotRelease(c.store, 'run');
        await publishRunSlotRelease(c.source, 'run');
        await closeNext();
        expect(c.received).toEqual([['run']]);
      } finally {
        await closeOwner();
        c.dispose();
      }
    }
  );

  test('overlapping execution scopes retain an unsafe cleanup outcome until both finish', async () => {
    const c = channel();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const execution = withRunSlotReleaseScope(async () => {
      const close = holdRunSlotRelease(c.store, 'run');
      entered.resolve();
      try {
        await finish.promise;
        await publishRunSlotRelease(c.source, 'run');
      } finally {
        await close();
      }
    });
    try {
      await entered.promise;
      await withRunSlotReleaseScope(async () => {
        const close = holdRunSlotRelease(c.store, 'run');
        deferRunSlotRelease();
        await close();
      });
      finish.resolve();
      await execution;
      expect(c.received).toEqual([]);
    } finally {
      finish.resolve();
      await execution;
      c.dispose();
    }
  });

  test('closing a hold inside a cleanup scope does not flush it early', async () => {
    const c = channel();
    const close = holdRunSlotRelease(c.store, 'run');
    try {
      await publishRunSlotRelease(c.source, 'run');
      await withRunSlotReleaseScope(async () => {
        await close();
        expect(c.received).toEqual([]);
        deferRunSlotRelease();
      });
      expect(c.received).toEqual([]);
    } finally {
      await close();
      c.dispose();
    }
  });

  test('forced cleanup consumes a committed release while its interrupted scope is still open', async () => {
    const c = channel();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const interrupted = withRunSlotReleaseScope(async () => {
      const close = holdRunSlotRelease(c.store, 'run');
      await publishRunSlotRelease(c.source, 'run');
      entered.resolve();
      await finish.promise;
      await close();
    });
    try {
      await entered.promise;
      expect(c.received).toEqual([]);
      await withRunSlotReleaseScope(() => finishForcedRunSlotCleanup(c.store, 'run'));
      expect(c.received).toEqual([['run']]);
      finish.resolve();
      await interrupted;
      expect(c.received).toEqual([['run']]);
    } finally {
      finish.resolve();
      await interrupted;
      c.dispose();
    }
  });

  test('dispatch starts a fresh cleanup scope and failures preserve the committed result', async () => {
    const c = channel();
    const dispose = subscribeRunSlotRelease(c.store, async ids => {
      if (ids.includes('parent')) {
        await withRunSlotReleaseScope(async () => publishRunSlotRelease(c.source, 'successor'));
        throw new Error('launch refused');
      }
    });
    try {
      await withRunSlotReleaseScope(() => publishRunSlotRelease(c.source, 'parent'));
      expect(c.received).toEqual([['parent'], ['successor']]);
    } finally {
      dispose();
      c.dispose();
    }
  });
});

test('per-run cleanup deferral preserves independent releases and store identities', async () => {
  const first = channel();
  const second = channel();
  const closeUnsafe = holdRunSlotRelease(first.store, 'unsafe');
  try {
    await withRunSlotReleaseScope(async () => {
      await publishRunSlotRelease(first.source, 'unsafe');
      await publishRunSlotRelease(first.source, 'safe');
      await publishRunSlotRelease(second.source, 'unsafe');
      await withRunSlotReleaseScope(
        async () => {
          deferRunSlotRelease();
          await closeUnsafe();
        },
        { store: first.store, runId: 'unsafe' }
      );
      expect(first.received).toEqual([]);
      expect(second.received).toEqual([]);
    });
    expect(first.received).toEqual([['safe']]);
    expect(second.received).toEqual([['unsafe']]);
  } finally {
    await closeUnsafe();
    first.dispose();
    second.dispose();
  }
});

test.each(['ordinary', 'forced'] as const)(
  'held %s delivery retains unsafe sibling exclusions',
  async ending => {
    const c = channel();
    const batches: { ids: readonly string[]; deferred: readonly string[] }[] = [];
    const dispose = subscribeRunSlotRelease(c.store, async (ids, deferred) => {
      batches.push({ ids, deferred });
    });
    const close = holdRunSlotRelease(c.store, 'safe');
    try {
      await withRunSlotReleaseScope(async () => {
        await publishRunSlotRelease(c.source, 'safe');
        await publishRunSlotRelease(c.source, 'unsafe');
        await withRunSlotReleaseScope(async () => deferRunSlotRelease(), {
          store: c.store,
          runId: 'unsafe',
        });
      });
      expect(batches).toEqual([]);
      if (ending === 'forced') await finishForcedRunSlotCleanup(c.store, 'safe');
      else await close();
      expect(batches).toEqual([{ ids: ['safe'], deferred: ['unsafe'] }]);
    } finally {
      await close();
      dispose();
      c.dispose();
    }
  }
);

test('a committed held release survives composition replacing its subscriber', async () => {
  const source = {};
  const store = bindRunSlotReleaseStore({}, () => source);
  const old = subscribeRunSlotRelease(store, async () => {});
  const close = holdRunSlotRelease(store, 'run');
  old();
  await publishRunSlotRelease(source, 'run');
  const received: string[][] = [];
  const dispose = subscribeRunSlotRelease(store, async ids => {
    received.push([...ids]);
  });
  try {
    old();
    await close();
    expect(received).toEqual([['run']]);
  } finally {
    await close();
    dispose();
  }
});
