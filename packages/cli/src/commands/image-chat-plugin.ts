import { SLACK_PLUGIN } from '@archon/adapters/retired-adapters';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chatReceiptSchema,
  isBinaryReceipt,
  isChatReceipt,
  type ChatReceipt,
  type PluginReceipt,
} from '@archon/plugin-manifest';
import { receiptPath, scanReceipts } from '@archon/plugin-manifest/store';
import type { PluginEnvironment } from './plugin-common';
import { installBinaryPlugin } from './plugin-binary';
import { parsePluginRef } from './plugin-source';
import { withPluginMutationLock } from './plugin-mutation-lock';

export const IMAGE_SLACK_PLUGIN = SLACK_PLUGIN.installSource;

export async function provisionImageSlack(
  bundleDir: string,
  env: PluginEnvironment
): Promise<void> {
  const retain = async (receipts: PluginReceipt[]): Promise<boolean> => {
    const installed = receipts
      .filter(isChatReceipt)
      .filter(entry => entry.descriptor.id === SLACK_PLUGIN.id);
    if (installed.length > 1) throw new Error('Multiple installed chat plugins claim Slack');
    const existing = installed[0];
    if (!existing) return false;
    await verifyRetainedSlack(existing, receipts, env.pluginsDir);
    console.log(
      `[archon] Slack token configuration is present; retained ${existing.id}@${existing.tag} (commit ${existing.commit})`
    );
    return true;
  };
  if (await retain((await scanReceipts(env.pluginsDir)).receipts)) return;
  await withPluginMutationLock(env.pluginsDir, async () => {
    const { receipts, broken } = await scanReceipts(env.pluginsDir);
    if (await retain(receipts)) return;
    const brokenSlack = broken.find(entry => entry.id === IMAGE_SLACK_PLUGIN);
    if (brokenSlack) throw new Error(`Cannot provision Slack: ${brokenSlack.message}`);

    const bundle = chatReceiptSchema.parse(
      JSON.parse(await readFile(receiptPath(bundleDir, IMAGE_SLACK_PLUGIN), 'utf8'))
    );
    const ref = parsePluginRef(`${bundle.id}@${bundle.tag}`);
    if (
      ref.id !== IMAGE_SLACK_PLUGIN ||
      bundle.descriptor.id !== SLACK_PLUGIN.id ||
      bundle.manifest.executable !== 'archon-chat-slack'
    ) {
      throw new Error('Image bundle must describe the image-provided Slack plugin');
    }
    if (receipts.some(entry => entry.id === ref.id)) {
      throw new Error(
        `${ref.id} is installed with a different kind or platform; remove it before provisioning Slack`
      );
    }
    const executable = `${bundle.manifest.executable}${process.platform === 'win32' ? '.exe' : ''}`;
    const file = bundle.files[0];
    if (bundle.files.length !== 1 || file?.path !== executable) {
      throw new Error('Image Slack receipt must own exactly its executable');
    }
    await installBinaryPlugin(
      ref,
      { kind: 'chat', manifest: bundle.manifest, tag: bundle.tag, commit: bundle.commit },
      receipts,
      broken,
      undefined,
      env,
      async () => ({
        bytes: await readFile(join(bundleDir, executable)),
        sha256: file.sha256,
        label: executable,
        digestSource: 'the image bundle receipt',
      }),
      bundle.descriptor
    );
    console.log(
      `[archon] Provisioned Slack because Slack token configuration is present: ${bundle.id}@${bundle.tag} (commit ${bundle.commit})`
    );
  });
}

async function verifyRetainedSlack(
  existing: ChatReceipt,
  receipts: PluginReceipt[],
  pluginsDir: string
): Promise<void> {
  const executable = `${existing.manifest.executable}${process.platform === 'win32' ? '.exe' : ''}`;
  const file = existing.files.find(entry => entry.path === executable);
  if (!file) throw new Error(`Slack receipt ${existing.id} does not own its executable`);
  const otherOwner = receipts.find(
    entry =>
      entry.id !== existing.id &&
      isBinaryReceipt(entry) &&
      entry.files.some(owned => owned.path === executable)
  );
  if (otherOwner) throw new Error(`Slack executable also belongs to ${otherOwner.id}`);
  const bytes = await readFile(join(pluginsDir, executable));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error(
      `Installed Slack executable does not match receipt ${existing.id}; run archon plugin update ${existing.id} or archon plugin remove ${existing.id}`
    );
  }
}
