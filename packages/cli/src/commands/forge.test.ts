import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginsPath } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { sourceForgePlugins } from '@archon/forge/host-plugins';
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
            retries: 0,
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
            retries: 0,
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
  let dispatchedOptions:
    | { env?: NodeJS.ProcessEnv; credentialEnv?: NodeJS.ProcessEnv; pluginsDir?: string }
    | undefined;
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
            retries: 0,
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
    pluginsDir: getPluginsPath('/trusted'),
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
              retries: 0,
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

test('a refused request names the fields the schema refused, not their values', async () => {
  const output: unknown[] = [];
  const unit = { kind: 'check', id: 'job-secret-id', name: 'e2e' };
  const code = await forgeCommand(
    'checks.rerun',
    {
      data: JSON.stringify({
        ref: { repo: { host: 'forge.example', path: 'a/b' }, number: 9 },
        revision: 'head',
        // A bare check unit, where the request takes `{unit, rerun}` entries.
        units: [unit],
      }),
    },
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
  const { error } = output[0] as { error: { kind: string; message: string } };
  expect(error.kind).toBe('invalid_request');
  expect(error.message).toContain('units.0.unit');
  expect(error.message).toContain('units.0.rerun');
  expect(error.message).not.toContain(unit.id);
});

test('new work-item mutations use file requests and record content-free verified audits', async () => {
  const repo = { host: 'forge.example', path: 'a/b' };
  const ref = { repo, number: 4 };
  const marker = '<!-- private marker -->';
  const requests = [
    {
      op: 'workitem.create',
      repo,
      title: 'Private title',
      body: `${marker}\nPrivate body`,
      marker,
    },
    { op: 'workitem.labels.set', ref, labels: ['a', 'b'] },
    {
      op: 'repo.label.ensure',
      repo,
      name: 'label',
      color: 'ABCDEF',
      description: 'Private description',
    },
  ];
  const directory = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-workitem-cli-')));
  for (const request of requests) {
    const path = join(directory, 'request.json');
    writeFileSync(path, JSON.stringify(request));
    const output: unknown[] = [];
    const audits: unknown[] = [];
    const code = await forgeCommand(
      request.op,
      { dataFile: path },
      {
        readConfig: async () => ({
          scanPath: false,
          plugins: [
            {
              plugin: 'mutator',
              command: process.execPath,
              args: [join(import.meta.dir, '../../../forge/src/fixtures/mutation-plugin.ts')],
            },
          ],
        }),
        // Real discovery runs here, so it scans this home and never the developer's.
        env: { HOME: directory, ARCHON_HOME: directory, WORKFLOW_ID: 'workitems-run' },
        write: async value => {
          output.push(value);
        },
        audit: async value => {
          audits.push(value);
        },
      }
    );
    expect(code).toBe(0);
    expect(output[0]).toMatchObject({
      ok: true,
      result: { op: request.op, value: { outcome: 'applied' } },
    });
    expect(audits[0]).toMatchObject({ operation: request.op, target: request.ref ?? repo });
    for (const secret of ['Private title', 'Private body', 'Private description', marker])
      expect(JSON.stringify(audits)).not.toContain(secret);
  }
});

test('reviews retain bodies in stdout and digest them through the CLI audit boundary', async () => {
  const ref = { repo: { host: 'forge.example', path: 'group/repo' }, number: 42 };
  const auditRecords: unknown[] = [];
  const responses: unknown[] = [];
  const code = await forgeCommand(
    'pr.reviews',
    { data: JSON.stringify({ ref }) },
    {
      env: { WORKFLOW_ID: 'run' },
      readConfig: async () => ({}),
      dispatch: async request => {
        const response: ForgeResponse = {
          operationId: request.operationId,
          ok: true,
          result: {
            op: 'pr.reviews',
            value: {
              ref,
              items: [
                {
                  kind: 'review',
                  id: '1',
                  author: null,
                  commit: 'head',
                  state: 'COMMENTED',
                  createdAt: null,
                  url: 'https://forge.example/review/1',
                  body: 'confidential review',
                },
              ],
            },
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
            retries: 0,
            durationMs: 1,
          },
        };
      },
      audit: async audit => {
        auditRecords.push(audit);
      },
      write: async response => {
        responses.push(response);
      },
    }
  );
  expect(code).toBe(0);
  expect(JSON.stringify(responses)).toContain('confidential review');
  expect(JSON.stringify(auditRecords)).not.toContain('confidential review');
  expect(JSON.stringify(auditRecords)).toContain('digest');
});

test('host metadata exposes selected plugin capabilities without credentials or operations', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-metadata-')));
  const output: unknown[] = [];
  const code = await forgeCommand(
    'metadata',
    { data: JSON.stringify({ host: 'github.com' }) },
    {
      env: { HOME: root, ARCHON_HOME: root, PATH: '' },
      readConfig: async () => ({
        scanPath: false,
        plugins: [
          {
            plugin: 'github',
            command: process.execPath,
            args: [
              '--no-env-file',
              join(import.meta.dir, '../../../forge/src/fixtures/credential-plugin.ts'),
            ],
          },
        ],
      }),
      write: async value => {
        output.push(value);
      },
    }
  );
  expect(code).toBe(0);
  expect(output[0]).toMatchObject({
    ok: true,
    result: { op: 'metadata', value: { capabilities: ['pr.view', 'resolve'] } },
  });
});

/** An Archon home whose installed GitHub forge plugin is a file no host can execute. */
function homeWithUnusableInstalledGithubPlugin(): string {
  const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-source-')));
  const plugins = getPluginsPath(home);
  mkdirSync(plugins, { recursive: true });
  const exe = process.platform === 'win32' ? '.exe' : '';
  writeFileSync(join(plugins, `archon-forge-github${exe}`), 'not an executable', { mode: 0o755 });
  return home;
}

async function githubMetadata(
  home: string,
  dependencies: Parameters<typeof forgeCommand>[2] = {}
): Promise<unknown> {
  const output: unknown[] = [];
  await forgeCommand(
    'metadata',
    { data: JSON.stringify({ host: 'github.com' }) },
    {
      env: { HOME: home, ARCHON_HOME: home, PATH: process.env.PATH },
      readConfig: async () => ({ scanPath: false }),
      write: async value => {
        output.push(value);
      },
      ...dependencies,
    }
  );
  return output[0];
}

test('a source checkout runs the GitHub plugin from source, whatever is installed', async () => {
  expect(await githubMetadata(homeWithUnusableInstalledGithubPlugin())).toMatchObject({
    ok: true,
    result: {
      op: 'metadata',
      value: { name: 'github', capabilities: expect.arrayContaining(['resolve:subject']) },
    },
  });
});

test('a release binary loads the installed GitHub plugin and nothing from source', async () => {
  expect(sourceForgePlugins(true)).toEqual([]);
  expect(
    await githubMetadata(homeWithUnusableInstalledGithubPlugin(), { sourcePlugins: [] })
  ).toMatchObject({
    ok: false,
    error: { kind: 'process_failed', message: 'discovery:github: metadata handshake failed' },
  });
});

async function checkForge(
  data: object,
  env: NodeJS.ProcessEnv,
  mode = 'token',
  tokenEnv?: string
): Promise<{ code: number; response: unknown }> {
  const output: unknown[] = [];
  const code = await forgeCommand(
    'check',
    { data: JSON.stringify(data) },
    {
      env,
      readConfig: async () => ({
        scanPath: false,
        plugins: [
          {
            plugin: 'test',
            command: process.execPath,
            args: [
              '--no-env-file',
              join(import.meta.dir, '../../../forge/src/fixtures/test-plugin.ts'),
              '--mode',
              mode,
            ],
            ...(tokenEnv ? { token_env: tokenEnv } : {}),
          },
        ],
      }),
      dispatch: async () => {
        throw new Error('forge check must not dispatch an operation');
      },
      write: async value => {
        output.push(value);
      },
    }
  );
  return { code, response: output[0] };
}

test('forge check names the plugin and credential source without dispatching or printing the token', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-check-')));
  const env = { HOME: root, ARCHON_HOME: root, PATH: '', TEST_FORGE_TOKEN: 'secret-token-value' };
  const { code, response } = await checkForge(
    { host: 'Forge.Example', operations: ['checks.state'] },
    env
  );
  expect(code).toBe(0);
  expect(response).toMatchObject({
    ok: true,
    result: {
      op: 'check',
      value: {
        host: 'forge.example',
        plugin: { name: 'test', version: '1.0.0' },
        operations: ['checks.state'],
        credentialSource: 'TEST_FORGE_TOKEN',
      },
    },
  });
  expect(JSON.stringify(response)).not.toContain('secret-token-value');
});

test('forge check exits 1 with a typed reason for a missing plugin, capability or credential', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-check-')));
  const env = { HOME: root, ARCHON_HOME: root, PATH: '' };

  const unclaimed = await checkForge({ host: 'other.example', operations: [] }, env);
  expect(unclaimed.code).toBe(1);
  expect(unclaimed.response).toMatchObject({
    ok: false,
    error: { kind: 'no_plugin_for_host' },
    remedy: expect.stringContaining('archon plugin add'),
  });

  // Capabilities are refused before the credential is read, so the absent token is not the reason.
  const unsupported = await checkForge(
    { host: 'forge.example', operations: ['checks.state', 'pr.merge', 'pr.review.submit'] },
    env
  );
  expect(unsupported.code).toBe(1);
  expect(unsupported.response).toMatchObject({
    ok: false,
    error: {
      kind: 'unsupported_op',
      message: 'plugin test 1.0.0 does not support pr.merge, pr.review.submit',
    },
    unsupported: ['pr.merge', 'pr.review.submit'],
    // The test plugin states no remedies, so forge names the generic step.
    remedy: expect.stringContaining('archon plugin update'),
  });

  const noCredential = await checkForge(
    { host: 'forge.example', operations: ['checks.state'] },
    env
  );
  expect(noCredential.code).toBe(1);
  expect(noCredential.response).toMatchObject({
    ok: false,
    error: { kind: 'no_credential' },
    remedy: expect.stringContaining('TEST_FORGE_TOKEN'),
  });
});

test('forge check names the configured token_env, not the plugin declaration, for a missing credential', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-check-')));
  const env = { HOME: root, ARCHON_HOME: root, PATH: '', TEST_FORGE_TOKEN: 'ignored' };
  const { code, response } = await checkForge(
    { host: 'forge.example', operations: ['checks.state'] },
    env,
    'token',
    'CONFIGURED_FORGE_TOKEN'
  );
  expect(code).toBe(1);
  expect(response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  const remedy = (response as { remedy: string }).remedy;
  expect(remedy).toContain('CONFIGURED_FORGE_TOKEN');
  expect(remedy).not.toContain('TEST_FORGE_TOKEN');
});

test('forge check by remote selects the plugin a resolve of that remote selects', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-check-')));
  const env = { HOME: root, ARCHON_HOME: root, PATH: '', TEST_FORGE_TOKEN: 'secret-token-value' };

  for (const remote of ['git@forge.example:a/b.git', 'https://u:p@forge.example:443/a/b']) {
    const { code, response } = await checkForge({ remote, operations: ['checks.state'] }, env);
    expect(code).toBe(0);
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'check', value: { host: 'forge.example', plugin: { name: 'test' } } },
    });
  }

  const local = await checkForge({ remote: '/srv/git/repo.git', operations: [] }, env);
  expect(local.response).toMatchObject({ ok: false, error: { kind: 'no_plugin_for_host' } });
  expect(JSON.stringify(local.response)).not.toContain('/srv/git');

  const both = await checkForge({ host: 'forge.example', remote: 'git@forge.example:a/b' }, env);
  expect(both.response).toMatchObject({
    ok: false,
    error: {
      kind: 'invalid_request',
      message: expect.stringContaining('name the forge by exactly one of host, remote or repo'),
    },
  });
});

test('forge check reads a remote or repository and refuses a credential the forge rejects', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-check-')));
  const env = (token: string) => ({
    HOME: root,
    ARCHON_HOME: root,
    PATH: '',
    TEST_FORGE_TOKEN: token,
  });
  const operations = ['pr.view'];
  const repo = { host: 'forge.example', path: 'a/b' };

  for (const target of [{ remote: 'git@forge.example:a/b.git' }, { repo }]) {
    const accepted = await checkForge({ ...target, operations }, env('accepted'), 'access');
    expect(accepted.code).toBe(0);
    expect(accepted.response).toMatchObject({
      ok: true,
      result: { op: 'check', value: { host: 'forge.example' } },
    });

    const expired = await checkForge({ ...target, operations }, env('expired-token'), 'access');
    expect(expired.code).toBe(1);
    expect(expired.response).toMatchObject({
      ok: false,
      error: { kind: 'authorization' },
      remedy: expect.stringContaining('TEST_FORGE_TOKEN'),
    });
    expect(JSON.stringify(expired.response)).not.toContain('expired-token');
  }

  const unseen = await checkForge(
    { repo: { host: 'forge.example', path: 'missing/repo' }, operations },
    env('accepted'),
    'access'
  );
  expect(unseen.code).toBe(1);
  expect(unseen.response).toMatchObject({ ok: false, error: { kind: 'not_found' } });

  // A host check names no repository, so it reads nothing, whatever the token.
  const byHost = await checkForge(
    { host: 'forge.example', operations },
    env('expired-token'),
    'access'
  );
  expect(byHost.response).toMatchObject({ ok: true });

  // A plugin with no pr.view has no read to serve: the check passes as it did before.
  const noRead = await checkForge(
    { remote: 'git@forge.example:a/b.git', operations: ['checks.state'] },
    env('expired-token')
  );
  expect(noRead.response).toMatchObject({ ok: true });
});

test('forge check under a source checkout answers for the source GitHub plugin', async () => {
  const home = homeWithUnusableInstalledGithubPlugin();
  const output: unknown[] = [];
  const code = await forgeCommand(
    'check',
    { data: JSON.stringify({ host: 'github.com', operations: ['resolve:subject'] }) },
    {
      env: { HOME: home, ARCHON_HOME: home, PATH: process.env.PATH, GH_TOKEN: 'secret-token' },
      readConfig: async () => ({ scanPath: false }),
      write: async value => {
        output.push(value);
      },
    }
  );
  expect(output[0]).toMatchObject({
    ok: true,
    result: {
      op: 'check',
      value: { host: 'github.com', plugin: { name: 'github' }, operations: ['resolve:subject'] },
    },
  });
  expect(code).toBe(0);
});

test('forge check carries the GitHub plugin remedy for a missing credential', async () => {
  const home = homeWithUnusableInstalledGithubPlugin();
  const output: unknown[] = [];
  await forgeCommand(
    'check',
    { data: JSON.stringify({ remote: 'git@github.com:o/r.git', operations: ['pr.view'] }) },
    {
      env: { HOME: home, ARCHON_HOME: home, PATH: '', GH_TOKEN: '' },
      readConfig: async () => ({ scanPath: false }),
      write: async value => {
        output.push(value);
      },
    }
  );
  expect(output[0]).toMatchObject({
    ok: false,
    error: { kind: 'no_credential' },
    remedy: expect.stringContaining('archon auth github'),
  });
});

// A `pr.merge` the forge applied for a run.
const mergeRef = { repo: { host: 'forge.example', path: 'acme/web' }, number: 7 };
const mergeCommit = 'a'.repeat(40);
const mergedAt = '2026-11-20T09:30:00Z';
const mergedPr = {
  ...mergeRef,
  schemaVersion: 1 as const,
  url: 'https://forge.example/acme/web/pull/7',
  head: 'feat/x',
  base: 'dev',
  is_draft: false,
  state: 'merged' as const,
  head_repo: mergeRef.repo,
  head_revision: 'b'.repeat(40),
  base_revision: 'c'.repeat(40),
  maintainer_can_modify: null,
};
const mergeRequest = { ref: mergeRef, method: 'squash', conditions: { head: 'b'.repeat(40) } };
/** `applied-no-time` is an applied merge from a plugin released before `merged_at`. */
type MergeOutcome = 'applied' | 'applied-no-time' | 'refused' | 'outcome_unknown';

function mergeResponse(request: ForgeRequest, outcome: MergeOutcome): ForgeResponse {
  if (outcome === 'refused' || outcome === 'outcome_unknown')
    return {
      operationId: request.operationId,
      ok: false,
      error: { kind: outcome === 'refused' ? 'conflict' : 'process_failed', message: 'not merged' },
      mutation: {
        op: 'pr.merge',
        target: mergeRef,
        merge: { method: 'squash', conditions: mergeRequest.conditions },
        outcome,
      },
    };
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'pr.merge',
      value: {
        target: mergeRef,
        outcome: 'applied',
        changed: true,
        pr: mergedPr,
        method: 'squash',
        conditions: mergeRequest.conditions,
        enforcedConditions: ['head'],
        landed: { commit: mergeCommit, tree: null, parents: null },
        ...(outcome === 'applied' ? { merged_at: mergedAt } : {}),
      },
    },
  };
}

async function runMerge(options: {
  outcome?: MergeOutcome;
  env?: NodeJS.ProcessEnv;
  record?: 'recorded' | 'no_item' | 'throws';
}) {
  const dispatched: string[] = [];
  const audited: string[] = [];
  const recorded: unknown[] = [];
  const output: unknown[] = [];
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await forgeCommand(
      'pr.merge',
      { data: JSON.stringify(mergeRequest) },
      {
        readConfig: async () => ({}),
        env: options.env ?? { WORKFLOW_ID: 'run-1' },
        dispatch: async request => {
          dispatched.push(request.op);
          const response = mergeResponse(request, options.outcome ?? 'applied');
          const plugin = { name: 'test', version: '1' };
          return {
            response,
            plugin,
            audit: {
              operationId: request.operationId,
              operation: request.op,
              target: mergeRef,
              plugin,
              result: forgeAuditResponse(response),
              retries: 0,
              durationMs: 1,
            },
          };
        },
        audit: async audit => {
          audited.push(audit.operation);
        },
        // Stands in for the store: a run on an item, unless `record` says otherwise.
        recordMerge: async (_runId, facts) => {
          if (options.record === 'no_item') return 'no_item';
          if (facts.at === undefined) return 'no_merge_time';
          recorded.push(facts);
          if (options.record === 'throws') throw new Error('store unavailable');
          return 'recorded';
        },
        write: async value => {
          output.push(value);
        },
      }
    );
    const lines = stderr.mock.calls.map(([line]) => String(line));
    return { code, dispatched, audited, recorded, output, stderr: lines };
  } finally {
    stderr.mockRestore();
  }
}

test("an applied merge from a run records the merge result's facts on the run's item", async () => {
  const result = await runMerge({});
  expect(result.code).toBe(0);
  // Everything recorded comes from the merge result; the forge is not read again.
  expect(result.dispatched).toEqual(['pr.merge']);
  expect(result.recorded).toEqual([
    { change: mergedPr.url, commit: mergeCommit, at: mergedAt, branch: 'dev' },
  ]);
  expect(result.audited).toEqual(['pr.merge']);
  expect(result.output).toEqual([
    expect.objectContaining({ ok: true, itemRecord: { recorded: true } }),
  ]);
  expect(result.stderr).toEqual([]);
});

test('a merge from a plugin that reports no merge time succeeds and says it was not recorded', async () => {
  const result = await runMerge({ outcome: 'applied-no-time' });
  // The merge happened, so the exit is 0: a caller must not treat a landed change as failed.
  expect(result.code).toBe(0);
  expect(result.recorded).toEqual([]);
  expect(result.output).toEqual([
    expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ op: 'pr.merge' }),
      itemRecord: { recorded: false, reason: 'no_merge_time' },
    }),
  ]);
  expect(result.stderr).toHaveLength(1);
  expect(result.stderr[0]).toContain('reported no merge time');
  expect(result.stderr[0]).toContain('archon plugin update');
});

test('a run on no item gets no item record and no item field', async () => {
  const result = await runMerge({ record: 'no_item' });
  expect(result.code).toBe(0);
  expect(result.output[0]).not.toHaveProperty('itemRecord');
  expect(result.stderr).toEqual([]);
});

test.each(['refused', 'outcome_unknown'] as const)('a %s merge records nothing', async outcome => {
  const result = await runMerge({ outcome });
  expect(result.code).toBe(1);
  expect(result.recorded).toEqual([]);
  expect(result.output[0]).not.toHaveProperty('itemRecord');
});

test('a merge outside a run records nothing', async () => {
  const result = await runMerge({ env: {} });
  expect(result.code).toBe(0);
  expect(result.audited).toEqual([]);
  expect(result.recorded).toEqual([]);
  expect(result.output[0]).not.toHaveProperty('itemRecord');
});

test('a store failure keeps the applied merge on stdout and exits 2', async () => {
  const result = await runMerge({ record: 'throws' });
  expect(result.code).toBe(2);
  expect(result.output).toEqual([expect.objectContaining({ ok: true })]);
  expect(result.output[0]).not.toHaveProperty('itemRecord');
  expect(result.stderr).toHaveLength(1);
  expect(result.stderr[0]).toContain(
    `merged ${mergedPr.url} but the item record could not be written: store unavailable`
  );
});
