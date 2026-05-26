import { isRegisteredProvider, registerProvider } from '../../registry';

import { KIMI_CAPABILITIES } from './capabilities';
import { KimiProvider } from './provider';

/**
 * Register the Kimi K2.5 community provider.
 *
 * Idempotent — safe to call multiple times. Kimi is a simple chat-completion
 * provider via OpenRouter, suited for content-generation and synthesis DAG nodes
 * that don't need Claude's agentic tool-use capabilities (per-node model routing).
 */
export function registerKimiProvider(): void {
  if (isRegisteredProvider('kimi')) return;
  registerProvider({
    id: 'kimi',
    displayName: 'Kimi K2.5 (via OpenRouter)',
    factory: () => new KimiProvider(),
    capabilities: KIMI_CAPABILITIES,
    builtIn: false,
  });
}
