import { isRegisteredProvider, registerProvider } from '../../registry';

import { COPILOT_CAPABILITIES } from './capabilities';
import { CopilotProvider } from './provider';

/**
 * Register the GitHub Copilot community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: Copilot is a community provider and must not be conflated
 * with core providers until it's explicitly promoted.
 */
export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'Copilot (GitHub)',
    factory: () => new CopilotProvider(),
    capabilities: COPILOT_CAPABILITIES,
    builtIn: false,
  });
}
