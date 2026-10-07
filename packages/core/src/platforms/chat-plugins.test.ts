import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { receiptPath } from '@archon/plugin-manifest/store';
import { chatPluginPolicies } from './chat-plugins';

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

test('invalid receipts name their path and repair commands without echoing contents', async () => {
  const dir = trackRoot(await mkdtemp(join(tmpdir(), 'invalid-chat-policies-')));
  const file = receiptPath(dir, receipt.id);
  await mkdir(dirname(file), { recursive: true });
  for (const contents of [
    JSON.stringify({ ...receipt, descriptor: undefined }),
    JSON.stringify({
      ...receipt,
      descriptor: { ...receipt.descriptor, protocol: 'archon-chat/2' },
    }),
    '{"credential": SECRET_TOKEN_AND_MESSAGE}',
  ]) {
    await writeFile(file, contents);
    const error = await chatPluginPolicies(dir).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain(file);
    expect(message).toContain('archon plugin update');
    expect(message).toContain('archon plugin remove');
    expect(message).not.toContain('SECRET_TOKEN_AND_MESSAGE');
  }
});
