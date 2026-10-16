import {
  checkForgeAccess,
  REQUIRED_FORGE_OPERATIONS,
} from '../../../../.archon/workflows/sdlc/.shared/forge-check.ts';
import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { clearRegistry, registerProvider } from '@archon/providers';
import { descriptor } from '@archon/providers/claude/descriptor';

mock.module('@archon/core', () => ({
  loadConfig: async () => ({ assistants: { fixture: {} } }),
  pool: { query: async () => [] },
  getDatabaseType: () => 'sqlite',
  getSchemaVersion: async () => null,
  loadGitHubAppConfig: () => null,
}));
mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByDefaultCwd: async () => null,
  findCodebaseByPathPrefix: async () => null,
}));
const { doctorCommand, checkSdlcForge } = await import('./doctor');
const nativeEnv = process.env;

test('normal doctor dispatch renders registered diagnostics and fails on their failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-doctor-dispatch-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const output = spyOn(console, 'log').mockImplementation(() => {});
  const diagnose = mock(async () => ({
    checks: [
      {
        id: 'fixture',
        label: 'Distinctive probe',
        status: 'fail' as const,
        message: 'fixture needs repair',
        remedy: 'repair fixture',
      },
    ],
  }));
  clearRegistry();
  registerProvider({
    id: 'fixture',
    displayName: 'Fixture',
    builtIn: false,
    capabilities: descriptor.capabilities,
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
    parseConfig: raw => raw,
    factory: () => ({
      diagnose,
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
      getType: () => 'fixture',
      getCapabilities: () => descriptor.capabilities,
      async *sendQuery() {
        throw new Error('unused');
      },
    }),
  });
  try {
    process.chdir(root);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: root,
      USERPROFILE: root,
      ARCHON_HOME: root,
      ARCHON_TELEMETRY_DISABLED: '1',
    });
    expect(await doctorCommand()).toBe(1);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.flat().join('\n')).toContain(
      '✗ fixture: Distinctive probe: fixture needs repair Remedy: repair fixture'
    );
    expect(output.mock.calls.flat().join('\n')).toContain('2 check(s) failed');
  } finally {
    clearRegistry();
    output.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(savedCwd);
    await removeTempTree(root);
  }
});

test.each([true, false])(
  'default forge runner reports its selected credential without exposing it (accepted: %s)',
  async accepted => {
    const root = mkdtempSync(join(tmpdir(), 'archon-doctor-credential-'));
    const token = 'github-doctor-private-token';
    try {
      writeFileSync(
        join(root, 'config.yaml'),
        JSON.stringify({
          forge: {
            scanPath: false,
            plugins: [
              {
                plugin: 'github',
                command: process.execPath,
                args: [
                  '--no-env-file',
                  '-e',
                  `if (process.argv.includes('metadata')) console.log(JSON.stringify({protocol: 1, name: 'github', version: 'test', forge: 'github', hosts: ['github.com'], capabilities: ${JSON.stringify(REQUIRED_FORGE_OPERATIONS)}, token_env: ['GITHUB_TOKEN']})); else { const request = await Bun.stdin.json(); if (process.env.ARCHON_FORGE_TOKEN !== '${token}') throw new Error('wrong token'); console.log(JSON.stringify(${accepted} ? {operationId: request.operationId, ok: true, result: {op: request.op, value: null}} : {operationId: request.operationId, ok: false, error: {kind: 'authorization', message: 'Bad credentials'}})); }`,
                ],
              },
            ],
          },
        })
      );
      const result = await checkSdlcForge({
        ARCHON_SDLC_FORGE: 'forge',
        ARCHON_HOME: root,
        HOME: root,
        GITHUB_TOKEN: token,
      });
      expect(result).toMatchObject({
        status: accepted ? 'pass' : 'fail',
        message: expect.stringContaining('source: GITHUB_TOKEN'),
      });
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await removeTempTree(root);
    }
  }
);

test('released v0.11.1 refuses the same eight missing operations in doctor and run preflight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-doctor-release-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const args of [
      ['init'],
      ['remote', 'add', 'origin', 'https://ghe.example.com/example/repo.git'],
    ]) {
      expect(Bun.spawnSync(['git', ...args], { cwd: root }).exitCode).toBe(0);
    }
    writeFileSync(
      join(root, 'config.yaml'),
      JSON.stringify({
        forge: {
          scanPath: false,
          plugins: [
            {
              plugin: 'github',
              command: process.execPath,
              args: [
                '--no-env-file',
                join(
                  import.meta.dir,
                  '../../../../.archon/scripts/__tests__/fixtures/released-github-plugin.ts'
                ),
              ],
            },
          ],
        },
      })
    );
    process.chdir(root);
    Object.assign(process.env, {
      ARCHON_HOME: root,
      HOME: root,
      ARCHON_SDLC_FORGE: 'forge',
      GH_TOKEN: 'accepted',
      ARCHON_CLI_COMMAND: JSON.stringify([
        process.execPath,
        '--no-env-file',
        join(import.meta.dir, '../cli.ts'),
      ]),
    });
    let refusal = '';
    try {
      await checkForgeAccess();
    } catch (error) {
      refusal = (error as Error).message;
    }
    const result = await checkSdlcForge(process.env);
    expect(result.status).toBe('fail');
    expect(result.message).toBe(refusal);
    for (const op of [
      'pr.draft',
      'checks.rerun',
      'repo.labels.list',
      'repo.label.ensure',
      'workitem.labels.set',
      'workitem.comment.upsert',
      'workitem.close',
      'workitem.create',
    ])
      expect(result.message).toContain(op);
    expect(await doctorCommand([async () => result])).toBe(1);
    expect(result.message).not.toContain('source:');
  } finally {
    output.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(savedCwd);
    await removeTempTree(root);
  }
});

test('dispatch fixtures preserve the native environment object for Windows PATH lookups', () => {
  expect(process.env === nativeEnv).toBe(true);
});
