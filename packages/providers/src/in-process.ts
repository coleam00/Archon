import { singleVendorCatalog } from './credential-catalog';
import { createProvider as createClaudeProvider, descriptor as claudeDescriptor } from './claude';
import { createProvider as createCodexProvider, descriptor as codexDescriptor } from './codex';
import { parseClaudeConfigStrict } from './claude/config';
import { parseCodexConfigStrict } from './codex/config';
import { registerCopilotProvider } from './community/copilot/registration';
import { registerOpencodeProvider } from './community/opencode/registration';
import { registerPiProvider } from './community/pi/registration';
import type { ProviderRegistration } from './types';
import { registerProvider, isRegisteredProvider } from './registry';
/**
 * Register built-in providers (Claude, Codex). Idempotent — skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: claudeDescriptor.id,
      displayName: claudeDescriptor.displayName,
      factory: createClaudeProvider,
      capabilities: claudeDescriptor.capabilities,
      builtIn: true,
      parseConfig: parseClaudeConfigStrict,
      credentials: singleVendorCatalog(claudeDescriptor.credentials.specs[0]),
    },
    {
      id: codexDescriptor.id,
      displayName: codexDescriptor.displayName,
      factory: createCodexProvider,
      capabilities: codexDescriptor.capabilities,
      builtIn: true,
      parseConfig: parseCodexConfigStrict,
      credentials: singleVendorCatalog(codexDescriptor.credentials.specs[0]),
    },
  ];

  for (const entry of builtins) {
    if (!isRegisteredProvider(entry.id)) {
      registerProvider(entry);
    }
  }
}

/** Register the remaining bundled providers; new community providers install as plugins. */
export function registerCommunityProviders(): void {
  registerOpencodeProvider();
  registerPiProvider();
  registerCopilotProvider();
}

export function registerInProcessProviders(): void {
  registerBuiltinProviders();
  registerCommunityProviders();
}
export { registerPiProvider } from './community/pi/registration';
export { registerOpencodeProvider, introspectOpencodeCredentials } from './community/opencode';
export { registerCopilotProvider } from './community/copilot';
export { claimPiExtensionProcessError, listPiModels } from './community/pi';
export { registerProvider } from './registry';
export { ClaudeProvider } from './claude/provider';
export { CodexProvider } from './codex/provider';
export { PiProvider } from './community/pi/provider';
