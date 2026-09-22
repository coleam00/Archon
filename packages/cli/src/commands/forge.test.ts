import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { tmpdir } from 'node:os';
import { forgeCommand } from './forge';
import { forgeAuditResponse, type ForgeResponse } from '@archon/forge/operations';

test('local resolve does not discover plugins and emits no-forge JSON', async () => {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'resolve',
    { data: '{"remote":null}' },
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
    { data: JSON.stringify({ ref }) },
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
            result: forgeAuditResponse(response),
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
    { data: '{"remote":null}' },
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
    { data: '{secret' },
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

test('the CLI does not inject a built-in producer into explicit plugin configuration', async () => {
  let configured: unknown;
  await forgeCommand(
    'resolve',
    { data: '{"remote":null}' },
    {
      readConfig: async () => ({ pluginDirs: [tmpdir()], scanPath: false }),
      dispatch: async (request, options) => {
        configured = options?.config;
        const response: ForgeResponse = {
          operationId: request.operationId,
          ok: true,
          result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
        };
        return {
          response,
          plugin: null,
          audit: {
            operationId: request.operationId,
            operation: request.op,
            target: null,
            plugin: null,
            result: forgeAuditResponse(response),
            durationMs: 0,
          },
        };
      },
      write: async () => {},
      env: {},
    }
  );
  expect(configured).toEqual({ plugins: [], hosts: {}, pluginDirs: [tmpdir()], scanPath: false });
});

test('uses trusted discovery/runtime values while retaining repo credential values', async () => {
  let dispatchedOptions: { env?: NodeJS.ProcessEnv; credentialEnv?: NodeJS.ProcessEnv } | undefined;
  await forgeCommand(
    'resolve',
    { data: '{"remote":null}', trustedEnv: { ARCHON_HOME: '/trusted', PATH: '/trusted/bin' } },
    {
      readConfig: async () => ({}),
      dispatch: async (request, options) => {
        dispatchedOptions = options;
        const response: ForgeResponse = {
          operationId: request.operationId,
          ok: true,
          result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
        };
        return {
          response,
          plugin: null,
          audit: {
            operationId: request.operationId,
            operation: request.op,
            target: null,
            plugin: null,
            result: forgeAuditResponse(response),
            durationMs: 0,
          },
        };
      },
      write: async () => {},
      env: {
        ARCHON_HOME: '/repo-controlled',
        PATH: '/repo-controlled/bin',
        REPO_SELECTED_TOKEN: 'repo-credential',
      },
    }
  );

  expect(dispatchedOptions).toMatchObject({
    env: { ARCHON_HOME: '/trusted', PATH: '/trusted/bin' },
    credentialEnv: {
      ARCHON_HOME: '/repo-controlled',
      PATH: '/repo-controlled/bin',
      REPO_SELECTED_TOKEN: 'repo-credential',
    },
  });
});

test('lifecycle schema rejects an unknown merge guarantee before dispatch', async () => {
  let dispatched = false;
  const output: unknown[] = [];
  const code = await forgeCommand(
    'pr.merge',
    {
      data: JSON.stringify({
        ref: { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 },
        method: 'merge',
        required: { snapshot: 'must-match' },
      }),
    },
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
  expect(output[0]).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
});

test('unexpected dispatch failure cannot reclassify a possibly submitted write as invalid input', async () => {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'pr.ready',
    {
      data: JSON.stringify({
        ref: { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 },
      }),
    },
    {
      readConfig: async () => ({}),
      dispatch: async () => {
        throw new Error('credential or private authored body must not leak');
      },
      write: async value => {
        output.push(value);
      },
      env: {},
    }
  );
  expect(code).toBe(1);
  expect(output[0]).toMatchObject({
    ok: false,
    error: { kind: 'process_failed' },
    mutation: { op: 'pr.ready', outcome: 'outcome_unknown' },
  });
  expect(JSON.stringify(output)).not.toContain('must not leak');
});

test('JSON file input preserves authored content and rejects two request sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-cli-input-'));
  try {
    const file = join(root, 'request.json');
    const body = 'Résumé\n'.repeat(1000);
    const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 1 };
    await writeFile(file, JSON.stringify({ ref, body }));
    const output: unknown[] = [];
    let calls = 0;
    const dependencies = {
      readConfig: async () => ({}),
      env: {},
      write: async (value: unknown) => {
        output.push(value);
      },
      dispatch: async (request: import('@archon/forge/operations').ForgeRequest) => {
        calls++;
        expect(request).toMatchObject({ op: 'pr.edit-body', ref, body });
        const response: ForgeResponse = {
          operationId: request.operationId,
          ok: false,
          error: { kind: 'authorization', message: 'fixture refuses' },
          mutation: {
            op: 'pr.edit-body',
            outcome: 'refused',
            target: ref,
            requested: {},
            enforced: {},
          },
        };
        return {
          response,
          plugin: null,
          audit: {
            operationId: request.operationId,
            operation: request.op,
            target: ref,
            plugin: null,
            result: forgeAuditResponse(response),
            durationMs: 0,
          },
        };
      },
    };
    expect(await forgeCommand('pr.edit-body', { dataFile: file }, dependencies)).toBe(1);
    expect(output[0]).toMatchObject({ mutation: { outcome: 'refused' } });
    expect(await forgeCommand('pr.edit-body', { data: '{}', dataFile: file }, dependencies)).toBe(
      1
    );
    expect(calls).toBe(1);
  } finally {
    await removeTempTree(root);
  }
});
