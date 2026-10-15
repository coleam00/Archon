import { join } from 'node:path';
import { isMaintainedProviderPlugin, isProviderReceipt } from '@archon/plugin-manifest';
import { receiptPath } from '@archon/plugin-manifest/store';
import {
  isMaintainedProvider,
  providerVersionMismatchMessage,
  type ProviderRegistration,
} from '@archon/provider-contract';
import { BUNDLED_VERSION, createLogger } from '@archon/paths';
import { markProviderUnavailable } from '@archon/providers';
import { loadRuntimeReceipts } from '../utils/plugin-receipts';
import { processProviderRegistration } from './process-registration';

export async function loadProviderPlugins(
  pluginsDir: string,
  options: { maintained?: 'source' | 'installed'; version?: string } = {}
): Promise<ProviderRegistration[]> {
  const receipts = await loadRuntimeReceipts(pluginsDir);
  const registrations: ProviderRegistration[] = [];
  for (const receipt of receipts.filter(isProviderReceipt)) {
    try {
      const descriptor = receipt.descriptor;
      if (isMaintainedProvider(descriptor.id)) {
        if (options.maintained === 'source') {
          createLogger('core.provider-plugins').warn(
            { receipt: receiptPath(pluginsDir, receipt.id) },
            'provider.receipt_skipped_source'
          );
          continue;
        }
        if (!isMaintainedProviderPlugin(receipt.id, descriptor.id)) {
          throw new Error('maintained provider receipt is not first-party');
        }
        const version = options.version ?? BUNDLED_VERSION;
        if (descriptor.version !== version) {
          markProviderUnavailable(
            descriptor.id,
            providerVersionMismatchMessage(descriptor.id, descriptor.version, version)
          );
          continue;
        }
      }
      if (receipt.manifest.executable !== `archon-provider-${descriptor.id}`) {
        throw new Error('descriptor id does not match the manifest executable');
      }
      const executable = receipt.files.find(file =>
        [receipt.manifest.executable, `${receipt.manifest.executable}.exe`].includes(file.path)
      );
      if (!executable) throw new Error('receipt does not own its executable');
      registrations.push(
        processProviderRegistration(descriptor, [join(pluginsDir, executable.path)])
      );
    } catch (error) {
      throw new Error(
        `Invalid provider plugin receipt ${receiptPath(pluginsDir, receipt.id)}. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`,
        { cause: error }
      );
    }
  }
  return registrations;
}
