import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { OpencodeProvider } from './provider';

export function isOpencodeModelCompatible(model: string): boolean {
  const i = model.indexOf('/');
  if (i <= 0 || i >= model.length - 1) return false;
  const provider = model.slice(0, i).trim();
  const modelName = model.slice(i + 1).trim();
  return provider.length > 0 && modelName.length > 0;
}

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
    isModelCompatible: isOpencodeModelCompatible,
    builtIn: false,
  });
}
