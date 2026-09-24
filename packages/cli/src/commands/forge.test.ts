import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { forgeCommand } from './forge';
import {
  forgeAuditResponse,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';

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

const trackTempRoot = trackTempRoots();

test('reads an authored request from a file so no body reaches argv', async () => {
  const directory = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-cli-')));
  {
    const path = join(directory, 'request.json');
    const body = 'A pull request body\nwith authored prose';
    writeFileSync(
      path,
      JSON.stringify({ ref: { repo: { host: 'forge.example', path: 'a/b' }, number: 4 }, body })
    );
    let received: ForgeRequest | undefined;
    const output: unknown[] = [];
    const code = await forgeCommand(
      'pr.edit-body',
      { dataFile: path },
      {
        readConfig: async () => ({}),
        dispatch: async request => {
          received = request;
          const response: ForgeResponse = {
            operationId: request.operationId,
            ok: true,
            result: {
              op: 'pr.edit-body',
              value: {
                target: { repo: { host: 'forge.example', path: 'a/b' }, number: 4 },
                outcome: 'applied',
                changed: true,
                pr: {
                  schemaVersion: 1,
                  repo: { host: 'forge.example', path: 'a/b' },
                  number: 4,
                  url: 'https://forge.example/a/b/pull/4',
                  head: 'feature',
                  base: 'dev',
                  is_draft: false,
                  state: 'open',
                  head_repo: { host: 'forge.example', path: 'a/b' },
                  head_revision: 'headsha',
                  base_revision: 'basesha',
                  maintainer_can_modify: null,
                },
                bodyDigest: 'digest',
              },
            },
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
        write: async value => {
          output.push(value);
        },
        env: {},
      }
    );
    expect(code).toBe(0);
    expect(received).toMatchObject({ op: 'pr.edit-body', body });
    expect(output[0]).toMatchObject({ ok: true, result: { op: 'pr.edit-body' } });
  }
});

test('refuses two request sources without touching the forge', async () => {
  let dispatched = false;
  const output: unknown[] = [];
  const code = await forgeCommand(
    'pr.ready',
    { data: '{"ref":{"repo":{"host":"a","path":"a/b"},"number":1}}', dataFile: '/nowhere.json' },
    {
      readConfig: async () => ({}),
      dispatch: async () => {
        dispatched = true;
        throw new Error('must not dispatch');
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

test('a dispatch that throws leaves a mutation unknown, never refused', async () => {
  const output: unknown[] = [];
  const request = {
    ref: { repo: { host: 'forge.example', path: 'a/b' }, number: 9 },
    marker: '<!-- archon-review-report -->',
    body: '<!-- archon-review-report -->\nreport',
  };
  const code = await forgeCommand(
    'comment.upsert',
    { data: JSON.stringify(request) },
    {
      readConfig: async () => ({}),
      dispatch: async () => {
        throw new Error('the dispatcher fell over');
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
    mutation: { op: 'comment.upsert', target: request.ref, outcome: 'outcome_unknown' },
  });
  // The authored report never travels back out through the failure envelope.
  expect(JSON.stringify(output[0])).not.toContain('report');
});

test('an invalid mutation request is refused before dispatch begins', async () => {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'pr.ready',
    { data: '{"ref":{"repo":{"host":"forge.example","path":"a/b"},"number":0}}' },
    {
      readConfig: async () => ({}),
      dispatch: async () => {
        throw new Error('must not dispatch');
      },
      write: async value => {
        output.push(value);
      },
      env: {},
    }
  );
  expect(code).toBe(1);
  expect(output[0]).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  expect(output[0]).not.toHaveProperty('mutation');
});
