import { isChatReceipt } from '@archon/plugin-manifest';
import { readReceipts } from '@archon/plugin-manifest/store';
import type { PlatformPolicy } from './types';

export async function chatPluginPolicies(pluginsDir: string): Promise<PlatformPolicy[]> {
  const receipts = await readReceipts(pluginsDir).catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Run archon plugin update <id> or archon plugin remove <id>`,
      { cause: error }
    );
  });
  return receipts.filter(isChatReceipt).map(({ descriptor }) => ({
    id: descriptor.id,
    ...descriptor.policy,
  }));
}
