// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { maintainedProviderPluginId } from '@archon/plugin-manifest';
import { receiptPath, scanReceipts } from '@archon/plugin-manifest/store';
import {
  clearRegistry,
  claudeDescriptor,
  providerRegistry,
  registerProvider,
} from '@archon/providers';
import { registerHostProviders } from '@archon/core/providers/register-host-providers';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { setPlatformPolicies, clearPlatformPolicies } from '@archon/core/platforms/registry';
import { MAINTAINED_PROVIDER_IDS, isMaintainedProvider } from '@archon/provider-contract';
import { setLogLevel } from '@archon/paths';
import { processProviderRegistration } from '@archon/core/providers/process-registration';
import { checkInstalledProviders } from './doctor-providers';
import { listPlugins, removePlugin } from './plugin-installed';
import { installBinaryPlugin } from './plugin-binary';
import { brokenReceiptNote } from './plugin-common';
import { installPlugin } from './plugin-install';
import { parsePluginRef } from './plugin-source';
import { spyOnJsonStdout, spyOnStderr } from '../test-support/workflow-harness-output';
import { captureCommand } from '../test-support/command';
import { workflowListCommand, workflowTestCommand } from './workflow-query';

const trackRoot = trackTempRoots();

test.each([false, true])(
  'old provider receipts warn without failing workflows (json=%s)',
  async json => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), 'workflow-protocol-')));
    const home = join(root, 'home');
    const project = join(root, 'project');
    const workflow = join(project, '.archon', 'workflows', 'receipt-check');
    await mkdir(join(workflow, 'fixtures'), { recursive: true });
    await writeFile(
      join(workflow, 'check.yaml'),
      'name: receipt-check\ndescription: Test\nnodes:\n  - id: check\n    prompt: Check\n'
    );
    await writeFile(
      join(workflow, 'fixtures', 'check.stubs.yaml'),
      'fixture:\n  expect: completed\ncheck: done\n'
    );
    const id = maintainedProviderPluginId('claude');
    const file = receiptPath(join(home, 'plugins'), id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id,
        manifest: {
          schemaVersion: 1,
          kind: 'provider',
          name: 'provider-claude',
          description: 'Claude',
          executable: 'archon-provider-claude',
        },
        tag: 'v0.13.0',
        commit: 'a'.repeat(40),
        installedAt: new Date(0).toISOString(),
        files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
        descriptor: { ...claudeDescriptor, protocol: 2 },
      })
    );
    let fixtureOutput = '';
    const result = await captureCommand({ ARCHON_HOME: home }, async () => {
      clearRegistry();
      setPlatformPolicies(defaultPlatformPolicies);
      try {
        if (json) setLogLevel('silent');
        await registerHostProviders();
        const listStderr = spyOnStderr();
        const listStdout = spyOnJsonStdout();
        try {
          await workflowListCommand(project, { json, name: 'receipt-check' });
          if (json) {
            const payload = JSON.parse(String(listStdout.mock.calls[0]?.[0]));
            expect(payload.errors).toEqual([]);
            expect(payload.workflows[0].name).toBe('receipt-check');
            const notice = listStderr.mock.calls.flat().join('');
            expect(notice).toContain(`Plugin unavailable: ${id}`);
            expect(notice).toContain('uses protocol 2, but this Archon requires protocol 3');
            expect(notice).toContain(
              `archon plugin remove ${maintainedProviderPluginId('claude')}`
            );
          }
        } finally {
          listStdout.mockRestore();
          listStderr.mockRestore();
        }
        const stdout = spyOnJsonStdout();
        const stderr = spyOnStderr();
        try {
          expect(await workflowTestCommand(project, 'receipt-check', { json })).toBe(0);
          if (json) {
            const payload = JSON.parse(String(stdout.mock.calls[0]?.[0]));
            expect(payload).toMatchObject({ passed: 1, failed: 0, errors: [] });
            const notice = stderr.mock.calls.flat().join('');
            expect(notice).toContain('uses protocol 2, but this Archon requires protocol 3');
            expect(notice).toContain(
              `archon plugin remove ${maintainedProviderPluginId('claude')}`
            );
          }
          fixtureOutput = stdout.mock.calls
            .map((call: readonly unknown[]) => String(call[0]))
            .join('');
        } finally {
          stderr.mockRestore();
          stdout.mockRestore();
        }
      } finally {
        clearRegistry();
        clearPlatformPolicies();
      }
    });
    expect(result.status, result.output).toBe(0);
    if (!json) {
      expect(result.output).toContain(`Plugin unavailable: ${id}`);
      expect(result.output).toContain('uses protocol 2, but this Archon requires protocol 3');
      expect(result.output).toContain(
        `archon plugin remove ${maintainedProviderPluginId('claude')}`
      );
    }
    if (!json) expect(fixtureOutput).toContain('1 passed, 0 failed');
    expect(result.output + fixtureOutput).not.toContain('workflow(s) failed to load');
    expect(result.output).not.toContain('Invalid input');
  }
);

async function installReceipt<Protocol extends number>(
  pluginsDir: string,
  provider: string,
  protocol: Protocol
) {
  const id = isMaintainedProvider(provider)
    ? maintainedProviderPluginId(provider)
    : `acme/${provider}`;
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'provider' as const,
    name: `provider-${provider}`,
    description: provider,
    executable: `archon-provider-${provider}`,
  };
  const descriptor = { ...claudeDescriptor, id: provider, protocol, version: '1.2.3' };
  const file = receiptPath(pluginsDir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      id,
      manifest,
      descriptor,
      tag: 'v1.2.3',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: manifest.executable, sha256: 'b'.repeat(64) }],
    })
  );
  return { id, manifest, descriptor };
}

test('repair prerequisites admit each old provider alongside other old receipts', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-repair-')));
  const pluginsDir = join(root, 'plugins');
  const entries = [];
  for (const provider of [...MAINTAINED_PROVIDER_IDS, 'community']) {
    const entry = await installReceipt(pluginsDir, provider, 2);
    const target = join(
      pluginsDir,
      entry.manifest.executable + (process.platform === 'win32' ? '.exe' : '')
    );
    await writeFile(target, 'old executable');
    entries.push({ ...entry, target });
  }
  const scan = await scanReceipts(pluginsDir);
  expect(scan.broken).toHaveLength(entries.length);
  for (const entry of entries) {
    const notice = scan.broken.find(value => value.id === entry.id);
    if (isMaintainedProvider(entry.descriptor.id)) {
      expect(notice?.message).toContain(`archon plugin remove ${entry.id}`);
    } else {
      expect(notice?.message).toContain(`If ${entry.target} exists, move it aside before retrying`);
    }
    const install = () =>
      installBinaryPlugin(
        parsePluginRef(entry.id),
        { kind: 'provider', manifest: entry.manifest, tag: 'v1.2.3', commit: 'a'.repeat(40) },
        scan.receipts,
        scan.broken,
        undefined,
        { pluginsDir, projectDir: root, archonVersion: '1.2.3' },
        async () => {
          throw new Error('acquisition reached');
        }
      );
    await expect(install()).rejects.toThrow('exists and may belong');
    await rename(entry.target, entry.target + '.old');
    await expect(install()).rejects.toThrow('acquisition reached');
  }
});

test('list and doctor distinguish old protocols and retain healthy peer versions', async () => {
  const home = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-status-')));
  const pluginsDir = join(home, 'plugins');
  const old = await installReceipt(pluginsDir, 'claude', 2);
  const peer = await installReceipt(pluginsDir, 'peer', 3);
  const result = await captureCommand({ ARCHON_HOME: home }, async () => {
    clearRegistry();
    try {
      registerProvider(processProviderRegistration(peer.descriptor, ['unused']));
      await listPlugins({ pluginsDir, projectDir: home, archonVersion: '1.2.3' });
      const check = await checkInstalledProviders(providerRegistry);
      expect(check.status).toBe('fail');
      expect(check.message).toContain('peer (1.2.3)');
      expect(check.message).toContain(`Plugin unavailable: ${old.id}`);
      expect(check.message).toContain(
        `archon plugin remove ${maintainedProviderPluginId('claude')}`
      );
    } finally {
      clearRegistry();
    }
  });
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain(`${old.id}  unavailable  Plugin unavailable:`);
  expect(result.output).not.toContain('unreadable');
});

test.each(['acme', 'acme/broken@v1', 'acme/repo/plugins/broken@v1'])(
  'old provider at stray location %s keeps manual deletion advice',
  async id => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-stray-')));
    const pluginsDir = join(root, 'plugins');
    const entry = await installReceipt(pluginsDir, 'community', 2);
    const file = receiptPath(pluginsDir, id);
    await mkdir(dirname(file), { recursive: true });
    await rename(receiptPath(pluginsDir, entry.id), file);
    const scan = await scanReceipts(pluginsDir);
    expect(scan.broken).toHaveLength(1);
    expect(brokenReceiptNote(scan.broken[0])).toContain('delete it by hand');
    const env = { pluginsDir, projectDir: root, archonVersion: '1.2.3' };
    await expect(installPlugin(parsePluginRef('acme/new'), 'install', env)).rejects.toThrow(
      'delete it by hand'
    );
    const target = join(
      pluginsDir,
      entry.manifest.executable + (process.platform === 'win32' ? '.exe' : '')
    );
    await writeFile(target, 'stray executable');
    await expect(
      installBinaryPlugin(
        parsePluginRef(entry.id),
        { kind: 'provider', manifest: entry.manifest, tag: 'v1.2.3', commit: 'a'.repeat(40) },
        scan.receipts,
        scan.broken,
        undefined,
        env,
        async () => {
          throw new Error('must not acquire');
        }
      )
    ).rejects.toThrow('delete it by hand');
  }
);

test('JSON workflows retain project results when the installed store cannot be scanned', async () => {
  const root = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-scan-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const workflow = join(project, '.archon', 'workflows', 'scan-check');
  await mkdir(join(workflow, 'fixtures'), { recursive: true });
  await writeFile(
    join(workflow, 'check.yaml'),
    'name: scan-check\ndescription: Test\nnodes:\n  - id: check\n    prompt: Check\n'
  );
  await writeFile(
    join(workflow, 'fixtures', 'check.stubs.yaml'),
    'fixture:\n  expect: completed\ncheck: done\n'
  );
  await mkdir(join(home, 'plugins'), { recursive: true });
  await writeFile(join(home, 'plugins', 'installed'), 'not a directory');
  const result = await captureCommand({ ARCHON_HOME: home }, async () => {
    setPlatformPolicies(defaultPlatformPolicies);
    clearRegistry();
    registerProvider(processProviderRegistration(claudeDescriptor, ['unused']));
    const stdout = spyOnJsonStdout();
    try {
      await workflowListCommand(project, { json: true });
      const list = JSON.parse(String(stdout.mock.calls[0]?.[0]));
      expect(list.workflows.some((entry: { name: string }) => entry.name === 'scan-check')).toBe(
        true
      );
      expect(list.errors).toHaveLength(1);
      expect(JSON.stringify(list.errors)).toContain(join(home, 'plugins'));
      stdout.mockClear();
      expect(await workflowTestCommand(project, 'scan-check', { json: true })).toBe(1);
      const report = JSON.parse(String(stdout.mock.calls[0]?.[0]));
      expect(report.passed).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(JSON.stringify(report.errors)).toContain(join(home, 'plugins'));
    } finally {
      stdout.mockRestore();
      clearPlatformPolicies();
      clearRegistry();
    }
  });
  expect(result.status, result.output).toBe(0);
});

test('doctor fails on a malformed receipt beside a healthy provider', async () => {
  const home = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-doctor-')));
  const pluginsDir = join(home, 'plugins');
  const peer = await installReceipt(pluginsDir, 'peer', 3);
  const file = receiptPath(pluginsDir, 'acme/broken');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{invalid json');
  const result = await captureCommand({ ARCHON_HOME: home }, async () => {
    clearRegistry();
    try {
      registerProvider(processProviderRegistration(peer.descriptor, ['unused']));
      const check = await checkInstalledProviders(providerRegistry);
      expect(check.status).toBe('fail');
      expect(check.message).toContain('peer (1.2.3)');
      expect(check.message).toContain(`Invalid JSON in plugin receipt ${file}`);
    } finally {
      clearRegistry();
    }
  });
  expect(result.status, result.output).toBe(0);
});

test.each([...MAINTAINED_PROVIDER_IDS])(
  'source repair removes obsolete %s receipt and preserves its executable',
  async provider => {
    const home = trackRoot(await mkdtemp(join(tmpdir(), 'protocol-remove-')));
    const pluginsDir = join(home, 'plugins');
    const entry = await installReceipt(pluginsDir, provider, 2);
    const target = join(pluginsDir, entry.manifest.executable);
    await writeFile(target, 'old executable');
    const result = await captureCommand({ ARCHON_HOME: home }, async () => {
      const scan = await scanReceipts(pluginsDir);
      expect(scan.broken[0].message).toContain(`archon plugin remove ${entry.id}`);
      await removePlugin(parsePluginRef(entry.id), {
        pluginsDir,
        projectDir: home,
        archonVersion: '1.2.3',
      });
      expect((await scanReceipts(pluginsDir)).broken).toEqual([]);
      expect(await Bun.file(target).text()).toBe('old executable');
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Removed the unavailable receipt');
    expect(result.output).not.toContain('unreadable');
  }
);
