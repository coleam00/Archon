import { isRegisteredProvider, registerProvider } from '../../registry';

import { getOpencodeCapabilities } from './capabilities';
import { parseOpencodeRunConfig } from './config';
import { OpencodeProvider } from './provider';

/**
 * Register the OpenCode community provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints.
 */
export function registerOpencodeProvider(): void {
  if (isRegisteredProvider('opencode')) return;
  const useV2 = process.env.OPENCODE_V2 === '1';
  registerProvider({
    id: 'opencode',
    displayName: 'OpenCode (community)',
    factory: (): OpencodeProvider => new OpencodeProvider({ useV2 }),
    capabilities: getOpencodeCapabilities(useV2),
    builtIn: false,
    parseRunConfig: parseOpencodeRunConfig,
    // OpenCode's backend universe is the models.dev catalog, resolved at
    // runtime by the embedded server — there is no static list to declare.
    // Introspection is exposed via GET /api/providers/opencode/credentials.
    credentials: { kind: 'dynamic' },
  });
}
