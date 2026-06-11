import { isRegisteredProvider, registerProvider } from '../../registry';

import { PI_CAPABILITIES } from './capabilities';
import { PI_CREDENTIAL_SPECS } from './pi-vendor-map.generated';
import { PiProvider } from './provider';

/**
 * Register the Pi community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: Pi validates the Phase 2 community-provider seam and must
 * not be conflated with core providers until it's explicitly promoted.
 */
export function registerPiProvider(): void {
  if (isRegisteredProvider('pi')) return;
  registerProvider({
    id: 'pi',
    displayName: 'Pi (community)',
    factory: () => new PiProvider(),
    capabilities: PI_CAPABILITIES,
    builtIn: false,
    // Generated from the installed pi-ai SDK — see generate:pi-vendor-map.
    credentials: { kind: 'static', specs: PI_CREDENTIAL_SPECS },
  });
}
