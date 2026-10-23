import { join } from 'node:path';
import { ZodError } from 'zod';
import {
  isMaintainedProviderPlugin,
  isProviderReceipt,
  type ProviderReceipt,
} from '@archon/plugin-manifest';
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

type ProviderPluginOptions = { maintained?: 'source' | 'installed'; version?: string };

export async function loadProviderPlugins(
  pluginsDir: string,
  options: ProviderPluginOptions = {}
): Promise<ProviderRegistration[]> {
  const receipts = await loadRuntimeReceipts(pluginsDir);
  const registrations: ProviderRegistration[] = [];
  for (const receipt of receipts.filter(isProviderReceipt)) {
    const registration = loadProviderReceipt(pluginsDir, receipt, options);
    if (registration) registrations.push(registration);
  }
  return registrations;
}

function shouldLoadMaintainedReceipt(
  pluginsDir: string,
  receipt: ProviderReceipt,
  options: ProviderPluginOptions,
  warn: (reason: string) => void
): boolean {
  const descriptor = receipt.descriptor;
  if (!isMaintainedProvider(descriptor.id)) return true;
  if (options.maintained === 'source') {
    createLogger('core.provider-plugins').warn(
      { receipt: receiptPath(pluginsDir, receipt.id) },
      'provider.receipt_skipped_source'
    );
    return false;
  }
  if (!isMaintainedProviderPlugin(receipt.id, descriptor.id)) {
    warn('maintained provider receipt is not first-party');
    return false;
  }
  const version = options.version ?? BUNDLED_VERSION;
  if (descriptor.version !== version) {
    markProviderUnavailable(
      descriptor.id,
      providerVersionMismatchMessage(descriptor.id, descriptor.version, version)
    );
    return false;
  }
  return true;
}

function loadProviderReceipt(
  pluginsDir: string,
  receipt: ProviderReceipt,
  options: ProviderPluginOptions
): ProviderRegistration | undefined {
  const warn = (reason: string) =>
    createLogger('core.provider-plugins').warn(
      { receipt: receiptPath(pluginsDir, receipt.id), reason },
      `Plugin unavailable. Run archon plugin update ${receipt.id} or archon plugin remove ${receipt.id}`
    );
  const descriptor = receipt.descriptor;
  if (!shouldLoadMaintainedReceipt(pluginsDir, receipt, options, warn)) return undefined;
  if (receipt.manifest.executable !== `archon-provider-${descriptor.id}`) {
    warn('descriptor id does not match the manifest executable');
    return undefined;
  }
  const executable = receipt.files.find(file =>
    [receipt.manifest.executable, `${receipt.manifest.executable}.exe`].includes(file.path)
  );
  if (!executable) {
    warn('receipt does not own its executable');
    return undefined;
  }
  try {
    return processProviderRegistration(descriptor, [join(pluginsDir, executable.path)]);
  } catch (error) {
    // Zod diagnostics can contain configured values. Keep runtime warnings value-free.
    warn(
      error instanceof ZodError
        ? 'provider descriptor failed schema validation'
        : `provider descriptor could not be registered: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
