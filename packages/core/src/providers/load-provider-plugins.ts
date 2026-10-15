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
    const warn = (reason: string) =>
      createLogger('core.provider-plugins').warn(
        { receipt: receiptPath(pluginsDir, receipt.id), reason },
        `Plugin unavailable. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`
      );
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
        warn('maintained provider receipt is not first-party');
        continue;
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
      warn('descriptor id does not match the manifest executable');
      continue;
    }
    const executable = receipt.files.find(file =>
      [receipt.manifest.executable, `${receipt.manifest.executable}.exe`].includes(file.path)
    );
    if (!executable) {
      warn('receipt does not own its executable');
      continue;
    }
    try {
      registrations.push(
        processProviderRegistration(descriptor, [join(pluginsDir, executable.path)])
      );
    } catch {
      // Schema diagnostics can contain configured values. Keep runtime warnings value-free.
      warn('provider descriptor could not be registered');
    }
  }
  return registrations;
}
