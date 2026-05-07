import { isRegisteredProvider, registerProvider } from '../../registry';

import { COPILOT_CAPABILITIES } from './capabilities';
import { CopilotSdkProvider } from './provider';

/**
 * Register the GitHub Copilot community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: community providers are distinct from core providers.
 */
export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'GitHub Copilot (community)',
    factory: () => new CopilotSdkProvider(),
    capabilities: COPILOT_CAPABILITIES,
    builtIn: false,
  });
}
