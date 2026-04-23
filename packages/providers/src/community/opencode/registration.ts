import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { OpenCodeProvider } from './provider';

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
    factory: () => new OpenCodeProvider(),
    capabilities: OPENCODE_CAPABILITIES,
    isModelCompatible: (model: string): boolean => {
      // OpenCode supports provider/model refs (e.g. 'anthropic/claude-sonnet-4')
      // and common model name prefixes.
      if (model.includes('/')) return true;
      const prefixes = ['gpt', 'claude', 'gemini', 'llama', 'deepseek', 'qwen'];
      return prefixes.some(p => model.toLowerCase().startsWith(p));
    },
    builtIn: false,
  });
}
