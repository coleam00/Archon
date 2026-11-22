import { isRegisteredProvider, registerProvider } from '../../registry';

import { ZCODE_CAPABILITIES } from './capabilities';
import { parseZcodeConfigStrict } from './config';
import { ZcodeProvider } from './provider';

/**
 * Register the ZCode community provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints.
 */
export function registerZcodeProvider(): void {
  if (isRegisteredProvider('zcode')) return;
  registerProvider({
    id: 'zcode',
    displayName: 'ZCode (community)',
    factory: () => new ZcodeProvider(),
    capabilities: ZCODE_CAPABILITIES,
    builtIn: false,
    parseConfig: parseZcodeConfigStrict,
    // The CLI authenticates through its own desktop login; no Archon-side credential
    // catalog exists to declare.
    credentials: { kind: 'dynamic', vendorFor: () => undefined },
  });
}
