import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subscribeKey, versionOf, get, set, invalidate, useEntity } from './cache';

// The store's Maps are module-level, so every test uses its own unique key —
// no cross-test state to reset.

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('subscribeKey — per-key Map lifecycle (#1933)', () => {
  test('last unsubscribe prunes versions; cache is retained for warm remount', async () => {
    const key = 'test:prune-versions';
    let loads = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v1');
      }
    );
    await flush();

    expect(get(key)).toBe('v1');
    expect(versionOf(key)).toBe(1); // notify bumped on load resolve
    expect(loads).toBe(1);

    unsubscribe();
    expect(versionOf(key)).toBe(0); // counter released
    expect(get(key)).toBe('v1'); // cached value deliberately retained

    // Remount reads warm: ensureLoad short-circuits on the cached value.
    const unsubscribe2 = subscribeKey(
      key,
      () => {},
      () => {
        loads += 1;
        return Promise.resolve('v2');
      }
    );
    await flush();
    expect(get(key)).toBe('v1');
    expect(loads).toBe(1); // loader not re-invoked
    unsubscribe2();
  });

  test('unsubscribing a non-last subscriber keeps the counter', async () => {
    const key = 'test:non-last';
    const unsubA = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    expect(versionOf(key)).toBe(1);

    unsubA();
    expect(versionOf(key)).toBe(1); // B still subscribed

    unsubB();
    expect(versionOf(key)).toBe(0);
  });

  test('unsubscribe stops change notifications', async () => {
    const key = 'test:notify-stops';
    let renders = 0;
    const unsubscribe = subscribeKey(
      key,
      () => {
        renders += 1;
      },
      () => Promise.resolve('a')
    );
    await flush();
    expect(renders).toBe(1);

    unsubscribe();
    set(key, 'b');
    expect(renders).toBe(1); // no further signal after cleanup
  });

  test('invalidate fully releases a subscriber-less key (cache + versions)', async () => {
    const key = 'test:invalidate-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('a')
    );
    await flush();
    unsubscribe();

    // An SSE push for an unsubscribed key updates the still-warm cache; the
    // version counter stays released because notify skips subscriber-less keys.
    set(key, 'pushed');
    expect(get(key)).toBe('pushed');
    expect(versionOf(key)).toBe(0);

    // With no loader registered, revalidate's prune branch drops the cache too.
    invalidate(key);
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(0);
  });

  test('a load resolving after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-resolve';
    let resolveLoad: (v: string) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        })
    );

    unsubscribe(); // last subscriber leaves while the load is still in flight
    expect(versionOf(key)).toBe(0);

    resolveLoad('late');
    await flush();
    expect(versionOf(key)).toBe(0); // notify skipped — nothing subscribes
    expect(get(key)).toBe('late'); // cache still warms for a future remount
  });

  test('a load rejecting after the last unsubscribe does not resurrect the counter', async () => {
    const key = 'test:inflight-reject';
    let rejectLoad: (e: Error) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLoad = reject;
        })
    );

    unsubscribe();
    expect(versionOf(key)).toBe(0);

    rejectLoad(new Error('late boom'));
    await flush();
    expect(versionOf(key)).toBe(0);
  });

  test('invalidate by prefix releases every matching subscriber-less key', async () => {
    const unsubA = subscribeKey(
      'test-prefix:a',
      () => {},
      () => Promise.resolve('a')
    );
    const unsubB = subscribeKey(
      'test-prefix:b',
      () => {},
      () => Promise.resolve('b')
    );
    await flush();
    unsubA();
    unsubB();

    invalidate('test-prefix');
    expect(get('test-prefix:a')).toBeUndefined();
    expect(get('test-prefix:b')).toBeUndefined();
    expect(versionOf('test-prefix:a')).toBe(0);
    expect(versionOf('test-prefix:b')).toBe(0);
  });

  test('errored key still releases its counter on last unsubscribe', async () => {
    const key = 'test:error-prune';
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () => Promise.reject(new Error('boom'))
    );
    await flush();
    expect(get(key)).toBeUndefined();
    expect(versionOf(key)).toBe(1); // error transition notified

    unsubscribe();
    expect(versionOf(key)).toBe(0);
  });
});

describe('subscribeKey — resubscribe during an abandoned in-flight load (#2101)', () => {
  test('a resubscribe before the old load settles runs its own loader and wins', async () => {
    const key = 'test:resub-inflight';
    let resolveA: (v: string) => void = () => {};
    let bLoads = 0;

    const unsubA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveA = resolve;
        })
    );
    unsubA(); // last subscriber leaves while loaderA is still pending

    const unsubB = subscribeKey(
      key,
      () => {},
      () => {
        bLoads += 1;
        return Promise.resolve('B');
      }
    );
    await flush();

    expect(bLoads).toBe(1); // B's own loader ran (the bug: it was never invoked)
    expect(get(key)).toBe('B'); // B's result landed
    expect(versionOf(key)).toBe(1); // one notify, from B's load

    resolveA('A'); // the abandoned load settles late
    await flush();
    expect(get(key)).toBe('B'); // A does not clobber B
    expect(versionOf(key)).toBe(1); // A's stale settle did not notify

    unsubB();
  });

  test('a rejecting abandoned load does not surface an error to the resubscriber', async () => {
    const key = 'test:resub-reject';
    let rejectA: (e: Error) => void = () => {};

    const unsubA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectA = reject;
        })
    );
    unsubA();

    const unsubB = subscribeKey(
      key,
      () => {},
      () => Promise.resolve('B')
    );
    await flush();
    expect(get(key)).toBe('B');
    expect(versionOf(key)).toBe(1);

    rejectA(new Error('stale boom')); // loaderA rejects after B already resolved
    await flush();
    expect(get(key)).toBe('B'); // B's value untouched
    expect(versionOf(key)).toBe(1); // no extra notify — A's error was not surfaced

    unsubB();
  });
});

describe('revalidate after an abandoned in-flight load', () => {
  test.each([
    ['resolve', 'before'],
    ['reject', 'before'],
    ['resolve', 'after'],
    ['reject', 'after'],
  ] as const)(
    'an abandoned load cannot %s %s its replacement settles after subscriber-less invalidation',
    async (settlement, timing) => {
      const key = `test:remount-after-invalidation:${settlement}:${timing}`;
      set(key, 'warm');
      let resolveA: (value: string) => void = () => {};
      let rejectA: (error: Error) => void = () => {};
      const unsubscribeA = subscribeKey(
        key,
        () => {},
        () =>
          new Promise<string>((resolve, reject) => {
            resolveA = resolve;
            rejectA = reject;
          })
      );
      invalidate(key);
      expect(get(key)).toBe('warm');
      unsubscribeA();
      invalidate(key);
      expect(get(key)).toBeUndefined();
      expect(versionOf(key)).toBe(0);

      let resolveB: (value: string) => void = () => {};
      const loaderB = (): Promise<string> =>
        new Promise(resolve => {
          resolveB = resolve;
        });
      let notifications = 0;
      const unsubscribeB = subscribeKey(key, () => notifications++, loaderB);
      function ErrorView(): string {
        return useEntity(key, loaderB).error?.message ?? 'no error';
      }
      try {
        if (timing === 'after') {
          resolveB('fresh');
          await flush();
          expect(get(key)).toBe('fresh');
          expect(versionOf(key)).toBe(1);
          expect(notifications).toBe(1);
        }

        if (settlement === 'resolve') resolveA('stale');
        else rejectA(new Error('stale boom'));
        await flush();

        expect(renderToStaticMarkup(createElement(ErrorView))).toBe('no error');
        expect(get(key)).toBe(timing === 'before' ? undefined : 'fresh');
        expect(versionOf(key)).toBe(timing === 'before' ? 0 : 1);
        expect(notifications).toBe(timing === 'before' ? 0 : 1);

        if (timing === 'before') {
          resolveB('fresh');
          await flush();
        }
        expect(get(key)).toBe('fresh');
        expect(versionOf(key)).toBe(1);
        expect(notifications).toBe(1);
        expect(renderToStaticMarkup(createElement(ErrorView))).toBe('no error');
      } finally {
        unsubscribeB();
        invalidate(key);
      }
    }
  );

  test.each(['resolve', 'reject'] as const)(
    'a cold load abandoned before invalidation cannot %s into the next mount',
    async settlement => {
      const key = `test:cold-abandoned-invalidation:${settlement}`;
      let resolveA: (value: string) => void = () => {};
      let rejectA: (error: Error) => void = () => {};
      const unsubscribeA = subscribeKey(
        key,
        () => {},
        () =>
          new Promise<string>((resolve, reject) => {
            resolveA = resolve;
            rejectA = reject;
          })
      );
      unsubscribeA();
      invalidate(key);

      if (settlement === 'resolve') resolveA('stale');
      else rejectA(new Error('stale boom'));
      await flush();

      let loadsB = 0;
      const loaderB = (): Promise<string> => {
        loadsB++;
        return new Promise<string>(() => {});
      };
      function View(): string {
        const { data, error } = useEntity(key, loaderB);
        return error?.message ?? data ?? 'no data';
      }
      const unsubscribeB = subscribeKey(key, () => {}, loaderB);
      try {
        expect(renderToStaticMarkup(createElement(View))).toBe('no data');
        expect(loadsB).toBe(1);
      } finally {
        unsubscribeB();
        invalidate(key);
      }
    }
  );

  test('subscriber-less invalidation clears an old error before a remounted load settles', async () => {
    const key = 'test:invalidate-old-error';
    const unsubscribeA = subscribeKey(
      key,
      () => {},
      () => Promise.reject(new Error('old error'))
    );
    await flush();

    let resolveB: (value: string) => void = () => {};
    const loaderB = (): Promise<string> =>
      new Promise(resolve => {
        resolveB = resolve;
      });
    function View(): string {
      const { data, error, loading } = useEntity(key, loaderB);
      return error?.message ?? (loading ? 'loading' : (data ?? 'no data'));
    }
    expect(renderToStaticMarkup(createElement(View))).toBe('old error');
    unsubscribeA();
    invalidate(key);

    const unsubscribeB = subscribeKey(key, () => {}, loaderB);
    try {
      expect(renderToStaticMarkup(createElement(View))).toBe('loading');
      expect(get(key)).toBeUndefined();
      expect(versionOf(key)).toBe(0);

      resolveB('fresh');
      await flush();
      expect(renderToStaticMarkup(createElement(View))).toBe('fresh');
      expect(versionOf(key)).toBe(1);
    } finally {
      unsubscribeB();
      invalidate(key);
    }
  });

  test('invalidating an abandoned revalidation cannot resurrect a purged key', async () => {
    const key = 'test:invalidate-abandoned-revalidation';
    set(key, 'warm');

    let resolveLoad: (v: string) => void = () => {};
    const unsubscribe = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        })
    );

    invalidate(key); // starts a revalidation while retaining the warm value
    unsubscribe();
    invalidate(key); // no loader left: purges the key
    expect(get(key)).toBeUndefined();

    resolveLoad('stale');
    await flush();
    expect(get(key)).toBeUndefined();
  });

  test('manual revalidation supersedes an abandoned load', async () => {
    const key = 'test:supersede-abandoned-revalidation';
    set(key, 'warm');

    let resolveA: (v: string) => void = () => {};
    const unsubscribeA = subscribeKey(
      key,
      () => {},
      () =>
        new Promise<string>(resolve => {
          resolveA = resolve;
        })
    );
    invalidate(key);
    unsubscribeA();

    let loadsB = 0;
    let resolveB: (v: string) => void = () => {};
    const unsubscribeB = subscribeKey(
      key,
      () => {},
      () => {
        loadsB += 1;
        return new Promise<string>(resolve => {
          resolveB = resolve;
        });
      }
    );

    invalidate(key);
    expect(loadsB).toBe(1);

    resolveB('fresh');
    await flush();
    expect(get(key)).toBe('fresh');

    resolveA('stale');
    await flush();
    expect(get(key)).toBe('fresh');

    unsubscribeB();
  });
});

describe('invalidation during a subscribed load', () => {
  test.each(['initial', 'revalidation', 'cancellation'] as const)(
    '%s retains the lifecycle cue and reads again after the stale response',
    async timing => {
      const key = `test-trailing:${timing}`;
      const before = timing === 'cancellation' ? ['paused'] : [];
      const after = timing === 'cancellation' ? [] : ['paused'];
      if (timing !== 'initial') set(key, before);
      let settle: (value: string[]) => void = () => {};
      let reads = 0;
      const unsubscribe = subscribeKey(
        key,
        () => {},
        () => {
          reads++;
          return reads === 1
            ? new Promise<string[]>(resolve => {
                settle = resolve;
              })
            : Promise.resolve(after);
        }
      );
      try {
        if (timing !== 'initial') invalidate(key);
        invalidate('test-trailing');
        invalidate('test-trailing');
        expect(reads).toBe(1);
        settle(before);
        await flush();
        expect(reads).toBe(2);
        expect(get(key)).toEqual(after);
      } finally {
        unsubscribe();
        invalidate(key);
      }
    }
  );
});
