import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { receiptPath } from '@archon/plugin-manifest/store';
import type { ChatPluginDescriptor } from '@archon/chat-contract';
import { isChatReceipt } from '@archon/plugin-manifest';
import { loadRuntimeReceipts } from '../utils/plugin-receipts';
import type { PlatformPolicy } from './types';

// Policy registration and process startup share this selection, so a receipt that
// cannot start never owns a platform policy either.
async function usableChatReceipts(pluginsDir: string) {
  const receipts = (await loadRuntimeReceipts(pluginsDir)).filter(isChatReceipt);
  return receipts.flatMap(receipt => {
    const executable = receipt.manifest.executable + (process.platform === 'win32' ? '.exe' : '');
    if (receipt.files.some(file => file.path === executable))
      return [{ descriptor: receipt.descriptor, executable }];
    createLogger('core.chat-plugins').warn(
      {
        receipt: receiptPath(pluginsDir, receipt.id),
        reason: 'receipt does not own its executable',
      },
      `Plugin unavailable. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`
    );
    return [];
  });
}

export async function chatPluginPolicies(pluginsDir: string): Promise<PlatformPolicy[]> {
  return (await usableChatReceipts(pluginsDir)).map(({ descriptor }) => ({
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
  const ids = new Set<string>();
  return (await usableChatReceipts(pluginsDir)).map(({ descriptor, executable }) => {
    if (ids.has(descriptor.id))
      throw new Error(`Duplicate installed chat platform ${descriptor.id}`);
    ids.add(descriptor.id);
    return { descriptor, argv: [join(pluginsDir, executable)] };
  });
}
