import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseOpencodeModel } from './config';
import { OpencodeProvider } from './provider';

/**
 * Register the opencode community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: opencode validates the community-provider seam and must
 * not be conflated with core providers.
 */
export function registerOpencodeProvider(): void {
  if (isRegisteredProvider('opencode')) return;
  registerProvider({
    id: 'opencode',
    displayName: 'opencode (community)',
    factory: () => new OpencodeProvider(),
    capabilities: OPENCODE_CAPABILITIES,
    isModelCompatible: (model: string): boolean => {
      // opencode models use '<providerID>/<modelID>' format.
      // builtIn: false so this is never called during model inference
      // (inferProviderFromModel only iterates builtIn:true providers),
      // but implemented correctly for completeness.
      return parseOpencodeModel(model) !== undefined;
    },
    builtIn: false,
  });
}
