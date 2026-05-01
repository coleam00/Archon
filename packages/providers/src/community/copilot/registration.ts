/**
 * GitHub Copilot CLI community provider — registration.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: Copilot validates the community-provider seam and must
 * not be conflated with core providers.
 */
import { isRegisteredProvider, registerProvider } from '../../registry';
import { COPILOT_CAPABILITIES } from './capabilities';
import { CopilotProvider } from './provider';

/**
 * Register the GitHub Copilot CLI community provider.
 *
 * Experimental — requires the `copilot` CLI binary to be installed and
 * authenticated separately. See docs/getting-started/ai-assistants.md
 * for configuration details.
 */
export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'GitHub Copilot CLI (community)',
    factory: () => new CopilotProvider(),
    capabilities: COPILOT_CAPABILITIES,
    builtIn: false,
  });
}
