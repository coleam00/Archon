import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';

const fixture = join(import.meta.dir, 'fixtures', 'test-plugin.ts');
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
    const discovery = await discoverPlugins({ config: config(), includeDefaultDir: false });
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
      includeDefaultDir: false,
    });
    const malformed = await dispatchForge(
      { operationId: 'bad', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery: malformedDiscovery }
    );
    expect(malformed.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });

    const processDiscovery = await discoverPlugins({
      config: config('token-error'),
      includeDefaultDir: false,
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
      includeDefaultDir: false,
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
        includeDefaultDir: false,
      })
    ).rejects.toThrow();
  });

  test('requires and remaps only a declared credential', async () => {
    const discovery = await discoverPlugins({
      config: config('token'),
      env: { ...process.env, TEST_FORGE_TOKEN: 'secret' },
      includeDefaultDir: false,
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
  const discovery = await discoverPlugins({ config: config(), includeDefaultDir: false });
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
    includeDefaultDir: false,
  });
  const result = await dispatchForge(
    { operationId: 'wrong-identity', op: 'resolve', remote: 'https://forge.example/a/b' },
    { discovery }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  expect(result.audit.target).toBeNull();
});
