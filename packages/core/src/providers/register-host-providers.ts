import { BUNDLED_IS_BINARY, getPluginsPath, getSourceProviderEntry } from '@archon/paths';
import { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import {
  claudeDescriptor,
  codexDescriptor,
  piDescriptor,
  registerProvider,
} from '@archon/providers';
import {
  registerBuiltinProviders,
  registerPiProvider,
  registerOpencodeProvider,
  registerCopilotProvider,
} from '@archon/providers/in-process';
import { getVendorCatalog } from '../credentials/catalog';
import { loadProviderPlugins } from './load-provider-plugins';
import { processProviderRegistration } from './process-registration';

export async function registerHostProviders(): Promise<void> {
  if (BUNDLED_IS_BINARY) {
    // Release binaries retain bundled providers until the provider release artifacts ship (P7).
    registerBuiltinProviders();
    registerPiProvider();
  } else {
    const descriptors = { claude: claudeDescriptor, codex: codexDescriptor, pi: piDescriptor };
    for (const id of MAINTAINED_PROVIDER_IDS) {
      registerProvider(
        processProviderRegistration(descriptors[id], [
          process.execPath,
          '--no-env-file',
          getSourceProviderEntry(id),
        ])
      );
    }
  }
  registerOpencodeProvider();
  registerCopilotProvider();
  for (const registration of await loadProviderPlugins(getPluginsPath(), {
    maintained: BUNDLED_IS_BINARY ? 'bundled' : 'source',
  })) {
    registerProvider(registration);
  }
  getVendorCatalog();
}
