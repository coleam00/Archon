import { expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { observingResponseSchema, registerObservingRoute } from './api.observing';

test('the read serves the observing sources with their reads and the recorded last pass', async () => {
  const app = new OpenAPIHono();
  const lastPass = { at: '2026-11-24T12:00:00Z', pid: 7, ok: true, parts: {} };
  registerObservingRoute(app, {
    observing: [
      {
        sourceInstanceId: 'forge',
        everySeconds: 30,
        labels: [{ bindingId: 'b1', repo: { host: 'example.test', path: 'o/r' }, label: 'go' }],
        unservedBindings: [{ bindingId: 'b2', reason: 'names no label' }],
      },
    ],
    lastPass: async () => lastPass,
  });
  const body = observingResponseSchema.parse(await (await app.request('/api/observing')).json());
  expect(body.sources[0]).toMatchObject({ source: 'forge', everySeconds: 30 });
  expect(body.sources[0]?.labels.map(read => read.bindingId)).toEqual(['b1']);
  expect(body.sources[0]?.unserved.map(binding => binding.bindingId)).toEqual(['b2']);
  expect(body.lastPass?.at).toBe(lastPass.at);
});

test('with no sources and no recorded pass the read says so', async () => {
  const app = new OpenAPIHono();
  registerObservingRoute(app, { observing: [], lastPass: async () => undefined });
  expect(await (await app.request('/api/observing')).json()).toEqual({
    sources: [],
    lastPass: null,
  });
});
