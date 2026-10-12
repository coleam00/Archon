import { join } from 'node:path';
import { isProviderReceipt } from '@archon/plugin-manifest';
import { readReceipts, receiptPath } from '@archon/plugin-manifest/store';
import type { ProviderRegistration } from '@archon/provider-contract';
import { processProviderRegistration } from './process-registration';

export async function loadProviderPlugins(pluginsDir: string): Promise<ProviderRegistration[]> {
  const receipts = await readReceipts(pluginsDir).catch((error: unknown) => {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Run archon plugin update <id> or archon plugin remove <id>`
    );
  });
  return receipts.filter(isProviderReceipt).map(receipt => {
    try {
      const descriptor = receipt.descriptor;
      if (receipt.manifest.executable !== `archon-provider-${descriptor.id}`) {
        throw new Error('descriptor id does not match the manifest executable');
      }
      const executable = receipt.files.find(file =>
        [receipt.manifest.executable, `${receipt.manifest.executable}.exe`].includes(file.path)
      );
      if (!executable) throw new Error('receipt does not own its executable');
      return processProviderRegistration(descriptor, [join(pluginsDir, executable.path)]);
    } catch {
      throw new Error(
        `Invalid provider plugin receipt ${receiptPath(pluginsDir, receipt.id)}. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`
      );
    }
  });
}
