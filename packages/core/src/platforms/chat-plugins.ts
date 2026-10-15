import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { receiptPath } from '@archon/plugin-manifest/store';
import type { ChatPluginDescriptor } from '@archon/chat-contract';
import { isChatReceipt } from '@archon/plugin-manifest';
import { loadRuntimeReceipts } from '../utils/plugin-receipts';
import type { PlatformPolicy } from './types';

export async function chatPluginPolicies(pluginsDir: string): Promise<PlatformPolicy[]> {
  const receipts = await loadRuntimeReceipts(pluginsDir);
  return receipts.filter(isChatReceipt).map(({ descriptor }) => ({
    id: descriptor.id,
    ...descriptor.policy,
  }));
}

export async function loadPlatformPolicies(
  pluginsDir: string,
  defaults: readonly PlatformPolicy[]
): Promise<PlatformPolicy[]> {
  const chatPolicies = await chatPluginPolicies(pluginsDir);
  const chatIds = new Set(chatPolicies.map(policy => policy.id));
  return [...defaults.filter(policy => !chatIds.has(policy.id)), ...chatPolicies];
}

export async function loadChatPlugins(pluginsDir: string): Promise<
  {
    descriptor: ChatPluginDescriptor;
    argv: readonly [string, ...string[]];
  }[]
> {
  const receipts = (await loadRuntimeReceipts(pluginsDir)).filter(isChatReceipt);
  const ids = new Set<string>();
  const plugins: Awaited<ReturnType<typeof loadChatPlugins>> = [];
  for (const receipt of receipts) {
    const { descriptor, manifest } = receipt;
    const executable = manifest.executable + (process.platform === 'win32' ? '.exe' : '');
    if (!receipt.files.some(file => file.path === executable)) {
      createLogger('core.chat-plugins').warn(
        {
          receipt: receiptPath(pluginsDir, receipt.id),
          reason: 'receipt does not own its executable',
        },
        `Plugin unavailable. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`
      );
      continue;
    }
    if (ids.has(descriptor.id))
      throw new Error(`Duplicate installed chat platform ${descriptor.id}`);
    ids.add(descriptor.id);
    plugins.push({ descriptor, argv: [join(pluginsDir, executable)] });
  }
  return plugins;
}
