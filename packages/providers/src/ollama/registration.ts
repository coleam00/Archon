/**
 * Register the built-in Ollama provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints (same
 * pattern as the Pi/AiderDesk community providers). Built-in because Ollama is
 * a core surface for archon-v2 (the operator pulls a model and runs locally),
 * distinct from community providers that demand a separate package install.
 *
 * Credentials: Ollama typically requires no auth, but operators CAN configure
 * an API key on the server. We register an optional `api_key` spec so the
 * tier / credential catalog surfaces the option; nothing in the provider
 * actually reads AIDERDESK_STYLE keys — the request goes through fetch with
 * the URL the operator set.
 */
import { isRegisteredProvider, registerProvider } from '../registry';
import { OLLAMA_CAPABILITIES } from './capabilities';
import { OllamaProvider } from './provider';

export function registerOllamaProvider(): void {
  if (isRegisteredProvider('ollama')) return;
  registerProvider({
    id: 'ollama',
    displayName: 'Ollama (direct)',
    factory: () => new OllamaProvider(),
    capabilities: OLLAMA_CAPABILITIES,
    builtIn: true,
    credentials: { kind: 'static', specs: [] },
  });
}
