import { isRegisteredProvider, registerProvider } from '../../registry';

import { CURSOR_CAPABILITIES } from './capabilities';
import { CursorProvider } from './provider';

/**
 * Register the Cursor community provider.
 *
 * Idempotent — safe to call from CLI, server, and config-loader bootstrap paths.
 */
export function registerCursorProvider(): void {
  if (isRegisteredProvider('cursor')) return;
  registerProvider({
    id: 'cursor',
    displayName: 'Cursor (community)',
    factory: () => new CursorProvider(),
    capabilities: CURSOR_CAPABILITIES,
    builtIn: false,
  });
}
