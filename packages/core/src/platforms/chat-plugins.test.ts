// @archon-test-isolated
import { expect, test, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as paths from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { receiptPath } from '@archon/plugin-manifest/store';
import { chatPluginPolicies, loadPlatformPolicies, loadChatPlugins } from './chat-plugins';
import type { PlatformPolicy } from './types';

const trackRoot = trackTempRoots();
const receipt = {
  schemaVersion: 1,
  id: 'owner/chat-fixture',
  manifest: {
    schemaVersion: 1,
    kind: 'chat',
    name: 'fixture',
    description: 'Fixture chat',
    executable: 'archon-chat-fixture',
  },
  tag: 'v1',
  commit: 'a'.repeat(40),
  installedAt: new Date(0).toISOString(),
  files: [{ path: 'archon-chat-fixture', sha256: 'b'.repeat(64) }],
  descriptor: {
    protocol: 'archon-chat/1',
    id: 'matrix-chat',
    displayName: 'Fixture',
    version: '1',
    capabilities: { defaultWorkflowDispatch: 'background' },
    policy: {
      workspaceRetention: 'retain',
      streaming: { defaultMode: 'batch', envVar: 'MATRIX_STREAMING_MODE' },
    },
  },
} as const;

test('loads descriptor policies without requiring or executing the binary', async () => {
  const dir = trackRoot(await mkdtemp(join(tmpdir(), 'chat-policies-')));
  expect(await chatPluginPolicies(dir)).toEqual([]);
  const file = receiptPath(dir, receipt.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(receipt));
  expect(await chatPluginPolicies(dir)).toEqual([
    { id: 'matrix-chat', ...receipt.descriptor.policy },
  ]);
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      manifest: { ...receipt.manifest, kind: 'forge', executable: 'archon-forge-fixture' },
      descriptor: undefined,
    })
  );
  expect(await chatPluginPolicies(dir)).toEqual([]);
});

test('invalid receipts do not block valid chat policies or runtime loading', async () => {
  const dir = trackRoot(await mkdtemp(join(tmpdir(), 'invalid-chat-policies-')));
  const file = receiptPath(dir, 'owner/broken');
  const valid = receiptPath(dir, receipt.id);
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(valid), { recursive: true });
  const executable = receipt.manifest.executable + (process.platform === 'win32' ? '.exe' : '');
  await writeFile(
    valid,
    JSON.stringify({ ...receipt, files: [{ path: executable, sha256: 'b'.repeat(64) }] })
  );
  const logger = paths.createLogger('test');
  const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const loggerFactory = spyOn(paths, 'createLogger').mockReturnValue(logger);
  try {
    for (const contents of [
      JSON.stringify({ ...receipt, descriptor: undefined }),
      JSON.stringify({
        ...receipt,
        descriptor: { ...receipt.descriptor, protocol: 'archon-chat/2' },
      }),
      '{"credential": SECRET_TOKEN_AND_MESSAGE}',
    ]) {
      await writeFile(file, contents);
      warning.mockClear();
      expect(await chatPluginPolicies(dir)).toEqual([
        { id: 'matrix-chat', ...receipt.descriptor.policy },
      ]);
      expect(await loadChatPlugins(dir)).toEqual([
        { descriptor: receipt.descriptor, argv: [join(dir, executable)] },
      ]);
      const warnings = JSON.stringify(warning.mock.calls);
      expect(warnings).toContain(file);
      expect(warnings).toContain('archon plugin update owner/broken');
      expect(warnings).toContain('archon plugin remove owner/broken');
      expect(warnings).not.toContain('SECRET_TOKEN_AND_MESSAGE');
    }
  } finally {
    loggerFactory.mockRestore();
    warning.mockRestore();
  }
});

test('receipt policies replace defaults and follow the remaining defaults in order', async () => {
  const dir = trackRoot(await mkdtemp(join(tmpdir(), 'composed-chat-policies-')));
  const defaults: readonly PlatformPolicy[] = [
    { id: 'cli', workspaceRetention: 'age-based' },
    { id: 'matrix-chat', workspaceRetention: 'age-based' },
    { id: 'web', workspaceRetention: 'age-based' },
  ];
  expect(await loadPlatformPolicies(dir, defaults)).toEqual([...defaults]);
  const file = receiptPath(dir, receipt.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(receipt));
  expect(await loadPlatformPolicies(dir, defaults)).toEqual([
    defaults[0],
    defaults[2],
    { id: 'matrix-chat', ...receipt.descriptor.policy },
  ]);
  expect(defaults[1]).toEqual({ id: 'matrix-chat', workspaceRetention: 'age-based' });
});

test('chat runtime skips unowned executables while duplicate platform ids remain errors', async () => {
  const dir = trackRoot(await mkdtemp(join(tmpdir(), 'chat-runtime-')));
  expect(await loadChatPlugins(dir)).toEqual([]);
  const file = receiptPath(dir, receipt.id);
  await mkdir(dirname(file), { recursive: true });
  const executable = receipt.manifest.executable + (process.platform === 'win32' ? '.exe' : '');
  const installed = { ...receipt, files: [{ path: executable, sha256: 'b'.repeat(64) }] };
  await writeFile(file, JSON.stringify(installed));
  expect(await loadChatPlugins(dir)).toEqual([
    { descriptor: receipt.descriptor, argv: [join(dir, executable)] },
  ]);
  await writeFile(
    file,
    JSON.stringify({ ...installed, files: [{ path: 'other', sha256: 'b'.repeat(64) }] })
  );
  const peer = receiptPath(dir, 'other/healthy');
  await mkdir(dirname(peer), { recursive: true });
  const healthy = {
    ...installed,
    id: 'other/healthy',
    descriptor: { ...installed.descriptor, id: receipt.descriptor.id },
  };
  await writeFile(peer, JSON.stringify(healthy));
  const logger = paths.createLogger('test');
  const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const loggerFactory = spyOn(paths, 'createLogger').mockReturnValue(logger);
  try {
    expect(await loadChatPlugins(dir)).toEqual([
      { descriptor: healthy.descriptor, argv: [join(dir, executable)] },
    ]);
    const warnings = JSON.stringify(warning.mock.calls);
    expect(warnings).toContain(file);
    expect(warnings).toContain('archon plugin update owner/chat-fixture');
    expect(warnings).toContain('archon plugin remove owner/chat-fixture');
  } finally {
    loggerFactory.mockRestore();
    warning.mockRestore();
  }
  await writeFile(file, JSON.stringify(installed));
  await expect(loadChatPlugins(dir)).rejects.toThrow('Duplicate installed chat platform');
});
