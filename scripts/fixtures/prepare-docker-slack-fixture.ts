import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chatReceiptSchema } from '../../packages/plugin-manifest/src/index';
import { receiptPath } from '../../packages/plugin-manifest/src/store';
import { IMAGE_SLACK_PLUGIN } from '../../packages/cli/src/commands/image-chat-plugin';
import { descriptor } from './docker-slack-plugin';

export async function createSlackFixtureBundle(bundleDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'docker-slack-plugin.ts')],
    target: 'bun',
  });
  if (!result.success) throw new Error(result.logs.join('\n'));
  const bytes = `#!${process.execPath}\n${await result.outputs[0].text()}`;
  const receipt = chatReceiptSchema.parse({
    schemaVersion: 1,
    id: IMAGE_SLACK_PLUGIN,
    tag: 'fixture',
    commit: 'a'.repeat(40),
    installedAt: '2026-01-01T00:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      kind: 'chat',
      name: 'slack',
      description: 'Docker test fixture',
      executable: 'archon-chat-slack',
    },
    descriptor,
    files: [
      { path: 'archon-chat-slack', sha256: createHash('sha256').update(bytes).digest('hex') },
    ],
  });
  const path = receiptPath(bundleDir, IMAGE_SLACK_PLUGIN);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(receipt));
  const executable = join(bundleDir, 'archon-chat-slack');
  await writeFile(executable, bytes);
  await chmod(executable, 0o755);
}

if (import.meta.main) {
  const bundleDir = process.argv[2];
  if (!bundleDir) throw new Error('Expected bundle directory');
  await createSlackFixtureBundle(bundleDir);
}
