import { isRegisteredProvider, registerProvider } from '../../registry';

import { GEMINI_CAPABILITIES } from './capabilities';
import { GeminiProvider } from './provider';

/**
 * Register the Gemini community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept in
 * `registerCommunityProviders()` (not `registerBuiltinProviders()`) because
 * `builtIn: false` is load-bearing: Gemini wraps a third-party SDK and is
 * maintained as a community provider alongside Pi.
 */
export function registerGeminiProvider(): void {
  if (isRegisteredProvider('gemini')) return;
  registerProvider({
    id: 'gemini',
    displayName: 'Gemini (community)',
    factory: () => new GeminiProvider(),
    capabilities: GEMINI_CAPABILITIES,
    builtIn: false,
  });
}
