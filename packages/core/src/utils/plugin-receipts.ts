import { createLogger } from '@archon/paths';
import { scanReceipts } from '@archon/plugin-manifest/store';

export async function loadRuntimeReceipts(pluginsDir: string) {
  const { receipts, broken } = await scanReceipts(pluginsDir);
  for (const entry of broken) {
    createLogger('core.plugin-receipts').warn(
      { receipt: entry.file, reason: entry.message },
      `Plugin unavailable. Run archon plugin update ${entry.id} or archon plugin remove ${entry.id}`
    );
  }
  return receipts;
}
