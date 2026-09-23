import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

import {
  isAuthorizedDrainRequest,
  MAX_DRAIN_BUDGET_SECONDS,
  registerInternalDrainRoutes,
  type DrainTarget,
} from './internal-drain';

const TOKEN = 'drain-token-value';

const DRAIN_STATUS = {
  requestedAt: '2026-09-23T19:00:00.000Z',
  expiresAt: '2026-09-23T19:30:00.000Z',
  refusedCount: 0,
};

function makeApp(): { app: OpenAPIHono; target: DrainTarget } {
  const app = new OpenAPIHono();
  const target: DrainTarget = {
    beginDrain: mock(() => DRAIN_STATUS),
    cancelDrain: mock(() => {}),
  };
  registerInternalDrainRoutes(app, target, TOKEN);
  return { app, target };
}

async function post(
  app: OpenAPIHono,
  body: unknown,
  authorization = `Bearer ${TOKEN}`
): Promise<Response> {
  return await app.request('/internal/drain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify(body),
  });
}

describe('isAuthorizedDrainRequest', () => {
  test('accepts the configured token', () => {
    expect(isAuthorizedDrainRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test('rejects a wrong token of the same length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    expect(isAuthorizedDrainRequest(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch, so the length check is not an
  // optimization — without it a short token is a 500 rather than a 401.
  test('rejects a token of a different length', () => {
    expect(isAuthorizedDrainRequest('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
  });

  test('rejects a missing or non-Bearer header', () => {
    expect(isAuthorizedDrainRequest(undefined, TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest('', TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorizedDrainRequest(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe('POST /internal/drain', () => {
  test('begins drain and returns the status', async () => {
    const { app, target } = makeApp();
    const response = await post(app, { budgetSeconds: 600 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DRAIN_STATUS);
    expect(target.beginDrain).toHaveBeenCalledWith(600);
  });

  test('refuses an unauthorized caller without touching the lock manager', async () => {
    const { app, target } = makeApp();
    const response = await post(app, { budgetSeconds: 600 }, 'Bearer wrong-token-value');

    expect(response.status).toBe(401);
    expect(target.beginDrain).not.toHaveBeenCalled();
  });

  // A budget that cannot expire is a box that never accepts work again.
  test('refuses a budget outside the allowed range', async () => {
    for (const budgetSeconds of [0, -1, MAX_DRAIN_BUDGET_SECONDS + 1]) {
      const { app, target } = makeApp();
      const response = await post(app, { budgetSeconds });
      expect(response.status).toBe(400);
      expect(target.beginDrain).not.toHaveBeenCalled();
    }
  });

  test('refuses a missing or non-numeric budget', async () => {
    for (const body of [{}, { budgetSeconds: '600' }, { budgetSeconds: null }, null]) {
      const { app, target } = makeApp();
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(target.beginDrain).not.toHaveBeenCalled();
    }
  });

  test('accepts the range boundaries', async () => {
    for (const budgetSeconds of [1, MAX_DRAIN_BUDGET_SECONDS]) {
      const { app, target } = makeApp();
      const response = await post(app, { budgetSeconds });
      expect(response.status).toBe(200);
      expect(target.beginDrain).toHaveBeenCalledWith(budgetSeconds);
    }
  });
});

describe('DELETE /internal/drain', () => {
  const del = async (app: OpenAPIHono, authorization = `Bearer ${TOKEN}`): Promise<Response> =>
    await app.request('/internal/drain', {
      method: 'DELETE',
      headers: { Authorization: authorization },
    });

  // The deploy's failure path cancels blind, so cancelling a drain that never
  // started has to succeed rather than report an error the script would escalate.
  test('cancels and is idempotent', async () => {
    const { app, target } = makeApp();
    expect((await del(app)).status).toBe(200);
    expect(await (await del(app)).json()).toEqual({ draining: false });
    expect(target.cancelDrain).toHaveBeenCalledTimes(2);
  });

  test('refuses an unauthorized caller', async () => {
    const { app, target } = makeApp();
    expect((await del(app, 'Bearer wrong-token-value')).status).toBe(401);
    expect(target.cancelDrain).not.toHaveBeenCalled();
  });
});
