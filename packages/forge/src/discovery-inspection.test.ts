import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import type { BigIntStats, PathLike, StatOptions, Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverPlugins, PluginDiscoveryError } from './discovery';
import { dispatchForge } from './dispatch';
import type { ForgePluginConfig } from './plugin-config';
import * as pluginProcess from './plugin-process';

const fixture = join(import.meta.dir, 'fixtures', 'test-plugin.ts');
const exe = process.platform === 'win32' ? '.exe' : '';
const healthyPlugin = {
  plugin: 'test',
  command: process.execPath,
  args: [fixture, '--mode', 'normalized-resolve'],
};
const operations: ('stat' | 'access')[] =
  process.platform === 'win32' ? ['stat'] : ['stat', 'access'];

async function withInspectionFailure(
  operation: 'stat' | 'access',
  name: string,
  check: (directory: string, command: string, failure: Error) => Promise<void>,
  code = 'EIO'
): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-inspection-'));
  const command = join(directory, `archon-forge-${name}${exe}`);
  const failure = Object.assign(new Error('inspection sentinel'), { code });
  const originalStat = fs.stat;
  const originalAccess = fs.access;
  function inspectedStat(
    path: PathLike,
    options?: StatOptions & { bigint?: false }
  ): Promise<Stats>;
  function inspectedStat(
    path: PathLike,
    options: StatOptions & { bigint: true }
  ): Promise<BigIntStats>;
  function inspectedStat(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>;
  async function inspectedStat(
    path: PathLike,
    options?: StatOptions
  ): Promise<Stats | BigIntStats> {
    if (path === command) throw failure;
    return originalStat(path, options);
  }
  const processSpy = spyOn(pluginProcess, 'runPluginProcess');
  let inspectionSpy;
  try {
    await fs.writeFile(command, '', { mode: 0o755 });
    inspectionSpy =
      operation === 'stat'
        ? spyOn(fs, 'stat').mockImplementation(inspectedStat)
        : spyOn(fs, 'access').mockImplementation(async (...args) => {
            if (args[0] === command) throw failure;
            return originalAccess(...args);
          });
    await check(directory, command, failure);
    expect(inspectionSpy).toHaveBeenCalled();
    expect(processSpy.mock.calls.some(([candidate]) => candidate.command === command)).toBe(false);
  } finally {
    inspectionSpy?.mockRestore();
    processSpy.mockRestore();
    await removeTempTree(directory);
  }
}

const failures = operations.map(operation => ({ operation, code: 'EIO' }));
if (process.platform !== 'win32') failures.push({ operation: 'access', code: 'EACCES' });

test.each(failures)(
  '$operation $code failures preserve evidence while healthy hosts still resolve',
  async ({ operation, code }) => {
    await withInspectionFailure(
      operation,
      'uninspectable',
      async (directory, command, failure) => {
        const discovery = await discoverPlugins({
          config: { plugins: [healthyPlugin], pluginDirs: [directory], scanPath: false },
          env: {},
        });
        expect(discovery.byHost.get('forge.example')?.metadata.name).toBe('test');
        expect(discovery.unavailable).toHaveLength(1);
        const error = discovery.unavailable[0];
        expect(error).toBeInstanceOf(PluginDiscoveryError);
        expect(error.kind).toBe('process_failed');
        expect(error.cause).toBe(failure);
        for (const evidence of [
          'plugin-dir:uninspectable',
          command,
          operation,
          code,
          failure.message,
        ]) {
          expect(error.message).toContain(evidence);
        }
        const healthy = await dispatchForge(
          { operationId: 'healthy', op: 'resolve', remote: 'https://forge.example/team/repo' },
          { discovery, env: {} }
        );
        expect(healthy.plugin).toEqual({ name: 'test', version: '1.0.0' });
        expect(healthy.response).toMatchObject({
          ok: true,
          result: { op: 'resolve', value: { kind: 'resolved' } },
        });
        const unknown = await dispatchForge(
          { operationId: 'unknown', op: 'resolve', remote: 'https://unknown.example/team/repo' },
          { discovery, env: {} }
        );
        expect(unknown.response).toMatchObject({
          ok: false,
          error: { kind: 'process_failed', message: expect.stringContaining(error.message) },
        });
      },
      code
    );
  }
);

test.each(operations)(
  'host-selected %s failures reject with inspection evidence',
  async operation => {
    await withInspectionFailure(operation, 'uninspectable', async (directory, command, failure) => {
      try {
        await discoverPlugins({
          config: {
            pluginDirs: [directory],
            hosts: { 'selected.example': 'uninspectable' },
            scanPath: false,
          },
          env: {},
        });
        throw new Error('Expected selected plugin discovery to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(PluginDiscoveryError);
        if (!(error instanceof PluginDiscoveryError)) throw error;
        expect(error.cause).toBe(failure);
        expect(error.message).toContain(command);
        expect(error.message).toContain(operation);
      }
    });
  }
);

test.each(operations)('%s failures still participate in duplicate-name checks', async operation => {
  await withInspectionFailure(operation, 'test', async directory => {
    await expect(
      discoverPlugins({
        config: { plugins: [healthyPlugin], pluginDirs: [directory], scanPath: false },
        env: {},
      })
    ).rejects.toMatchObject({
      kind: 'duplicate_host',
      message: 'forge plugin test has both available and failed candidates',
    });
  });
});

test.skipIf(process.platform === 'win32')(
  'nonexecutable files keep their notice and are skipped',
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'forge-nonexecutable-'));
    const command = join(directory, 'archon-forge-nonexecutable');
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await fs.writeFile(command, '', { mode: 0o644 });
      const discovery = await discoverPlugins({
        config: { pluginDirs: [directory], scanPath: false },
        env: {},
      });
      expect(discovery.plugins).toHaveLength(0);
      expect(discovery.unavailable).toHaveLength(0);
      expect(stderr).toHaveBeenCalledWith(
        `Skipping forge plugin ${basename(command)}: file is not executable\n`
      );
    } finally {
      stderr.mockRestore();
      await removeTempTree(directory);
    }
  }
);

for (const configuredSource of ['plugins', 'hosts'] as const) {
  for (const scanSource of ['installed', 'pluginDirs', 'PATH'] as const) {
    test.each(operations)(
      `${configuredSource} duplicate scanned from ${scanSource} preserves %s evidence and fatal policy`,
      async operation => {
        await withInspectionFailure(operation, 'duplicate', async (directory, command, failure) => {
          const plugin = { plugin: 'duplicate', command, args: [] };
          const config: ForgePluginConfig = {
            plugins: configuredSource === 'plugins' ? [plugin] : [],
            hosts: configuredSource === 'hosts' ? { 'selected.example': plugin } : {},
            pluginDirs: scanSource === 'pluginDirs' ? [directory] : [],
            scanPath: scanSource === 'PATH',
          };
          try {
            await discoverPlugins({
              config,
              env: scanSource === 'PATH' ? { PATH: directory } : {},
              pluginsDir: scanSource === 'installed' ? directory : undefined,
            });
            throw new Error('Expected configured plugin discovery to fail');
          } catch (error) {
            expect(error).toBeInstanceOf(PluginDiscoveryError);
            if (!(error instanceof PluginDiscoveryError)) throw error;
            expect(error.kind).toBe('process_failed');
            expect(error.cause).toBe(failure);
            expect(error.message).toContain(
              `${operation} failed for ${command} (EIO): ${failure.message}`
            );
          }
        });
      }
    );
  }
}
