import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';
import { repoRefSchema, type RepoRef } from './identity';

const fixture = join(import.meta.dir, 'fixtures', 'test-plugin.ts');

test.each(['github.com', 'ghes.example.test'])(
  'retains HTTPS :443 authority from a released normalized resolver on %s',
  async host => {
    const discovery = await discoverPlugins({
      config: {
        ...config('normalized-resolve'),
        hosts: { [host]: 'test', [`${host}:443`]: 'test' },
      },
      env: {},
    });
    const plugin = discovery.plugins[0];
    for (const claims of [[host], [`${host}:443`], [host, `${host}:443`]]) {
      const selected = {
        ...discovery,
        byHost: new Map(claims.map(claim => [claim, plugin])),
      };
      const result = await dispatchForge(
        { operationId: 'compat', op: 'resolve', remote: `https://${host}:443/team/repo.git` },
        { discovery: selected, env: {} }
      );
      const repo: RepoRef = {
        host: `${host}:443`,
        path: 'team/repo',
        ...(claims.includes(`${host}:443`) ? {} : { hostClaim: true }),
      };
      expect(result.response).toMatchObject({
        ok: true,
        result: { op: 'resolve', value: { kind: 'resolved', repo } },
      });
      if (
        !result.response.ok ||
        result.response.result.op !== 'resolve' ||
        result.response.result.value.kind !== 'resolved'
      )
        throw new Error('Expected repository');
      expect(result.response.result.value.repo).toEqual(repo);
      const qualified = await dispatchForge(
        {
          operationId: 'qualified-compat',
          op: 'repo.labels.list',
          repo: JSON.parse(JSON.stringify(result.response.result.value.repo)),
        },
        { discovery: selected, env: {} }
      );
      expect(qualified.response).toMatchObject({
        ok: true,
        result: { op: 'repo.labels.list', value: { repo, labels: [] } },
      });
    }
  }
);

test('qualified operations use the retained HTTPS claim and its credential configuration', async () => {
  const discovery = await discoverPlugins({
    config: {
      plugins: [
        {
          plugin: 'mutator',
          command: process.execPath,
          args: [join(import.meta.dir, 'fixtures', 'mutation-plugin.ts')],
        },
      ],
      hosts: { 'forge.example': { plugin: 'mutator', token_env: 'BARE_TOKEN' } },
      scanPath: false,
    },
    env: {},
  });
  const repo = repoRefSchema.parse(
    JSON.parse(
      JSON.stringify({
        host: 'forge.example:443',
        path: 'team/repo',
        hostClaim: true,
      })
    )
  );
  for (const request of [
    { operationId: 'labels', op: 'repo.labels.list', repo },
    { operationId: 'threads', op: 'pr.threads', ref: { repo, number: 1 } },
  ] as const) {
    const result = await dispatchForge(request, { discovery, env: { BARE_TOKEN: 'fixture' } });
    expect(result.response.ok).toBe(true);
    expect(result.credentialSource).toBe('BARE_TOKEN');
    expect(result.audit.target).toEqual('repo' in request ? repo : request.ref);
  }
  const missing = await dispatchForge(
    { operationId: 'missing', op: 'repo.labels.list', repo },
    { discovery, env: {} }
  );
  expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
});

test.each([
  'forge.example',
  'forge.example:8443',
  'forge.example:443:443',
  'user@forge.example:443',
  'forge.example/path:443',
  'forge.example?query:443',
  'forge.example#fragment:443',
])('rejects a host claim marker on invalid authority %s', host => {
  expect(repoRefSchema.safeParse({ host, path: 'team/repo', hostClaim: true }).success).toBe(false);
});

test.each([false, 'true', { host: 'forge.example', transport: 'https' }])(
  'rejects a non-marker host claim %j',
  hostClaim => {
    expect(
      repoRefSchema.safeParse({ host: 'forge.example:443', path: 'team/repo', hostClaim }).success
    ).toBe(false);
  }
);
function config(mode = 'ok') {
  return {
    plugins: [{ plugin: 'test', command: process.execPath, args: [fixture, '--mode', mode] }],
    scanPath: false,
  };
}

describe('forge plugin discovery and dispatch', () => {
  test('does not discover for an absent or local resolve target', async () => {
    const result = await dispatchForge(
      { operationId: 'local', op: 'resolve', remote: '/tmp/repo' },
      {
        config: { plugins: [{ plugin: 'test', command: '/definitely/missing' }], scanPath: false },
      }
    );
    expect(result.response).toEqual({
      operationId: 'local',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
    expect(result.plugin).toBeNull();
  });

  test('performs metadata before an operation and preserves correlation in audit', async () => {
    const discovery = await discoverPlugins({ config: config() });
    const result = await dispatchForge(
      { operationId: 'resolve-ü', op: 'resolve', remote: 'git@forge.example:team/repo.git' },
      { discovery }
    );
    expect(result.response).toEqual({
      operationId: 'resolve-ü',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
    expect(result.plugin).toEqual({ name: 'test', version: '1.0.0' });
    expect(result.audit.operationId).toBe('resolve-ü');
    expect(result.audit.result).toEqual({
      operationId: 'resolve-ü',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  });

  test('returns malformed stdout and exit classes as distinct protocol/process failures', async () => {
    const malformedDiscovery = await discoverPlugins({
      config: config('malformed'),
    });
    const malformed = await dispatchForge(
      { operationId: 'bad', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery: malformedDiscovery }
    );
    expect(malformed.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });

    const processDiscovery = await discoverPlugins({
      config: config('token-error'),
    });
    const failed = await dispatchForge(
      { operationId: 'failed', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery: processDiscovery }
    );
    expect(failed.response).toMatchObject({
      ok: false,
      error: { kind: 'process_failed', exitCode: 7 },
    });
  });

  test('does not execute an undeclared operation', async () => {
    const discovery = await discoverPlugins({
      config: config('unsupported'),
    });
    const result = await dispatchForge(
      { operationId: 'unsupported', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'unsupported_op' } });
  });

  test('rejects duplicate host claims', async () => {
    await expect(
      discoverPlugins({
        config: {
          plugins: [
            { plugin: 'test', command: process.execPath, args: [fixture] },
            { plugin: 'other', command: process.execPath, args: [fixture, '--name', 'other'] },
          ],
          scanPath: false,
        },
      })
    ).rejects.toThrow();
  });

  test('requires and remaps only a declared credential', async () => {
    const discovery = await discoverPlugins({
      config: config('token'),
      env: { ...process.env, TEST_FORGE_TOKEN: 'secret' },
    });
    const missing = await dispatchForge(
      {
        operationId: 'missing',
        op: 'checks.state',
        ref: { repo: { host: 'forge.example', path: 'a/b' }, number: 1 },
      },
      { discovery, env: {} }
    );
    expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    const present = await dispatchForge(
      { operationId: 'present', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery, env: { TEST_FORGE_TOKEN: 'secret' } }
    );
    expect(present.response.ok).toBe(true);
  });
});

test('does not accept a success response for a different operation', async () => {
  const discovery = await discoverPlugins({ config: config() });
  const result = await dispatchForge(
    {
      operationId: 'wrong-op',
      op: 'checks.state',
      ref: { repo: { host: 'forge.example', path: 'team/repo' }, number: 42 },
    },
    { discovery }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
});

test.each(['bad-protocol', 'bad-metadata'])('refuses %s before operation dispatch', async mode => {
  const result = await dispatchForge(
    { operationId: 'handshake', op: 'resolve', remote: 'https://forge.example/team/repo' },
    { config: config(mode) }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
});

test('refuses resolved identity that differs from the selected host', async () => {
  const discovery = await discoverPlugins({
    config: config('wrong-resolve'),
  });
  const result = await dispatchForge(
    { operationId: 'wrong-identity', op: 'resolve', remote: 'https://forge.example/a/b' },
    { discovery }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  expect(result.audit.target).toBeNull();
});

test('an older plugin refuses new work-item capability before executing it', async () => {
  const discovery = await discoverPlugins({ config: config('malformed') });
  const repo = { host: 'forge.example', path: 'group/team/repo' };
  const result = await dispatchForge(
    {
      operationId: 'unsupported-create',
      op: 'workitem.create',
      repo,
      title: 'Title',
      marker: 'marker',
      body: 'marker\nBody',
    },
    { discovery }
  );
  expect(result.response).toMatchObject({
    ok: false,
    error: { kind: 'unsupported_op' },
    mutation: { outcome: 'refused', target: repo },
  });
});

test.each([
  ['github-origin', 'http://ghes.example.test:8080', 'http://ghes.example.test:8080'],
  ['other-origin', 'http://ghes.example.test:8080', 'absent'],
  ['other-origin', 'http://user:private@ghes.example.test:8080', 'absent'],
])(
  'scopes the configured GitHub origin to selected GitHub operations (%s)',
  async (mode, origin, expected) => {
    const result = await dispatchForge(
      { operationId: 'origin', op: 'resolve', remote: 'https://forge.example/team/repo' },
      { config: config(mode), env: { GITHUB_URL: origin } }
    );
    expect(result.response).toEqual({
      operationId: 'origin',
      ok: false,
      error: { kind: 'forge_error', message: expected },
    });
  }
);
