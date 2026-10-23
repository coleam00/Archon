import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as cache from './console/store/cache';
import { K } from './console/store/keys';

const effects: React.EffectCallback[] = [];
const cleanups: (() => void)[] = [];
const react = { ...React };
// Effect execution is controlled here; this file has its own test group because mocks persist.
mock.module('react', () => ({
  ...react,
  useEffect: (effect: React.EffectCallback): void => {
    effects.push(effect);
  },
}));
const loginFlowComponent = (await import('./console/components/SubscriptionLoginFlow'))
  .SubscriptionLoginFlow;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const timers: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  effects.length = 0;
  timers.length = 0;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  mock.restore();
});

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function advancePollInterval(): Promise<void> {
  for (const callback of timers.splice(0)) callback();
  await settle();
}

function mountLogin(onDone: () => void): void {
  Object.defineProperty(globalThis, 'setTimeout', {
    value: (callback: TimerHandler, delay?: number, ...args: unknown[]): number => {
      expect(delay).toBe(2000);
      if (typeof callback !== 'function') throw new Error('Expected a timer callback');
      timers.push(() => callback(...args));
      return timers.length;
    },
    configurable: true,
    writable: true,
  });

  renderToStaticMarkup(React.createElement(loginFlowComponent, { provider: 'claude', onDone }));
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

test('connected login invalidates and completes once, then stops polling', async () => {
  const request = mock((input: RequestInfo | URL) => {
    const url = String(input);
    return Promise.resolve(
      Response.json(
        url.endsWith('/start')
          ? { sessionId: 'session-1', mode: 'manual', expiresIn: 600 }
          : { status: 'connected' }
      )
    );
  });
  globalThis.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
  const invalidate = spyOn(cache, 'invalidate');
  const onDone = mock(() => undefined);
  mountLogin(onDone);
  await settle();
  expect(request).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(1);

  await advancePollInterval();
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    '/api/auth/providers/claude/oauth/start',
    '/api/auth/providers/claude/oauth/poll',
  ]);
  expect(invalidate.mock.calls).toEqual([[K.providerConnections]]);
  expect(onDone).toHaveBeenCalledTimes(1);

  await advancePollInterval();
  await advancePollInterval();
  expect(request).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(0);
});

test.each(['unmount', 'provider change'] as const)(
  'ignores an in-flight connected poll after %s',
  async cancellation => {
    const poll = Promise.withResolvers<Response>();
    const request = mock((input: RequestInfo | URL) =>
      String(input).endsWith('/start')
        ? Promise.resolve(Response.json({ sessionId: 'session-1', mode: 'manual', expiresIn: 600 }))
        : poll.promise
    );
    globalThis.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
    const invalidate = spyOn(cache, 'invalidate');
    const onDone = mock(() => undefined);
    mountLogin(onDone);
    await settle();
    await advancePollInterval();
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/auth/providers/claude/oauth/start',
      '/api/auth/providers/claude/oauth/poll',
    ]);

    if (cancellation === 'unmount') {
      for (const cleanup of cleanups.splice(0)) cleanup();
    } else {
      // A provider change cleans up the polling effect without unmounting the hook.
      const cleanup = cleanups.pop();
      expect(cleanup).toBeDefined();
      cleanup?.();
    }
    poll.resolve(Response.json({ status: 'connected' }));
    await settle();
    await advancePollInterval();
    await advancePollInterval();

    expect(invalidate).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(0);
  }
);
