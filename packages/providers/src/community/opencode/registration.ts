import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { OpencodeProvider } from './provider';

/**
 * Register the OpenCode community provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints.
 */
export function registerOpencodeProvider(): void {
  if (isRegisteredProvider('opencode')) return;
  registerProvider({
    id: 'opencode',
    displayName: 'OpenCode (community)',
    factory: () => new OpencodeProvider(),
    capabilities: OPENCODE_CAPABILITIES,
    builtIn: false,
  });
}
