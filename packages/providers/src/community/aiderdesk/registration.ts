import { isRegisteredProvider, registerProvider } from '../../registry';
import { AIDERDESK_CAPABILITIES } from './capabilities';
import { AiderDeskProvider } from './provider';

/**
 * Register the AiderDesk community provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints.
 * Kept separate from registerBuiltinProviders() because `builtIn: false`
 * is load-bearing: community providers must not be conflated with core
 * providers until they are explicitly promoted.
 *
 * AiderDesk uses no external credentials — its backend is a local service
 * (localhost:24337) with no authentication. The credentials catalog is
 * empty (`specs: []`), which is valid: the field is required but the
 * spec list can be empty for providers that need no user-supplied keys.
 */
export function registerAiderdeskProvider(): void {
  if (isRegisteredProvider('aiderdesk')) return;
  registerProvider({
    id: 'aiderdesk',
    displayName: 'AiderDesk (community)',
    factory: () => new AiderDeskProvider(),
    capabilities: AIDERDESK_CAPABILITIES,
    builtIn: false,
    credentials: { kind: 'static', specs: [] },
  });
}
