import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
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
const { doctorCommand } = await import('./doctor');
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
    expect(output.mock.calls.flat().join('\n')).toContain('1 check(s) failed');
  } finally {
    clearRegistry();
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
