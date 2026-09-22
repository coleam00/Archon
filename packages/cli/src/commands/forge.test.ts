import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forgeCommand } from './forge';
import type { ForgeResponse } from '@archon/forge/operations';

test('local resolve does not discover plugins and emits no-forge JSON', async () => {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'resolve',
    { cwd: '/tmp', data: '{"remote":null}', command: [process.execPath] },
    {
      readConfig: async () => ({
        plugins: [{ plugin: 'broken', command: join(tmpdir(), 'missing-forge.exe') }],
      }),
      write: async value => {
        output.push(value);
      },
      env: {},
    }
  );
  expect(code).toBe(0);
  expect(output[0]).toMatchObject({
    ok: true,
    result: { op: 'resolve', value: { forge: 'none' } },
  });
});

test('records qualified target and evaluated revision through the host audit', async () => {
  const observed: unknown[] = [];
  const ref = { repo: { host: 'forge.example', path: 'group/team/repo' }, number: 42 };
  const code = await forgeCommand(
    'checks',
    { cwd: '/tmp', data: JSON.stringify({ ref }), command: [process.execPath] },
    {
      readConfig: async () => ({}),
      env: { WORKFLOW_ID: 'run-42' },
      dispatch: async request => {
        const response: ForgeResponse = {
          operationId: request.operationId,
          ok: true,
          result: {
            op: 'checks.state',
            value: {
              ref,
              revision: 'opaque-full-object-id',
              units: [],
              required: null,
              summary: {
                state: 'none',
                counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
              },
            },
          },
        };
        const plugin = { name: 'test', version: '1' };
        return {
          response,
          plugin,
          audit: {
            operationId: request.operationId,
            operation: request.op,
            target: ref,
            plugin,
            result: response,
            durationMs: 1,
          },
        };
      },
      audit: async (audit, runId) => {
        observed.push({ audit, runId });
      },
      write: async value => {
        observed.push(value);
      },
    }
  );
  expect(code).toBe(0);
  expect(observed[0]).toMatchObject({
    runId: 'run-42',
    audit: { target: ref, result: { result: { value: { revision: 'opaque-full-object-id' } } } },
  });
});

test('audit failure retains the known result and returns a distinct nonzero exit', async () => {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'resolve',
    { cwd: '/tmp', data: '{"remote":null}', command: [process.execPath] },
    {
      readConfig: async () => ({}),
      env: { WORKFLOW_ID: 'missing-run' },
      audit: async () => {
        throw new Error('unavailable');
      },
      write: async value => {
        output.push(value);
      },
    }
  );
  expect(code).toBe(2);
  expect(output[0]).toMatchObject({ ok: true, result: { value: { forge: 'none' } } });
});

test('invalid data fails before dispatch without echoing user data', async () => {
  const output: unknown[] = [];
  let dispatched = false;
  const code = await forgeCommand(
    'checks',
    { cwd: '/tmp', data: '{secret', command: [process.execPath] },
    {
      dispatch: async () => {
        dispatched = true;
        throw new Error('must not execute');
      },
      write: async value => {
        output.push(value);
      },
      env: {},
    }
  );
  expect(code).toBe(1);
  expect(dispatched).toBe(false);
  expect(JSON.stringify(output)).not.toContain('secret');
});

test('an explicit host executable replaces the bundled producer by name', async () => {
  let configured: unknown;
  await forgeCommand(
    'resolve',
    { cwd: '/tmp', data: '{"remote":null}', command: [process.execPath] },
    {
      readConfig: async () => ({
        hosts: {
          'github.example': { plugin: 'github', command: process.execPath, args: ['custom'] },
        },
      }),
      dispatch: async (request, options) => {
        configured = options?.config;
        return {
          response: {
            operationId: request.operationId,
            ok: true,
            result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
          },
          plugin: null,
          audit: {
            operationId: request.operationId,
            operation: request.op,
            target: null,
            plugin: null,
            result: {
              operationId: request.operationId,
              ok: true,
              result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
            },
            durationMs: 0,
          },
        };
      },
      write: async () => {},
      env: {},
    }
  );
  expect(configured).toMatchObject({
    plugins: [],
    hosts: { 'github.example': { args: ['custom'] } },
  });
});
