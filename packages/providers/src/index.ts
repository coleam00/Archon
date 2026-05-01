// Types (contract layer — re-exported for convenience)
export type {
  IAgentProvider,
  AgentRequestOptions,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaults,
  ProviderDefaultsMap,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  MessageChunk,
  TokenUsage,
} from './types';

// Provider config types (canonical definitions in ./types, re-exported via config modules)
// Import from ./types directly or from the config modules — both work.

// Registry
export {
  registerProvider,
  getAgentProvider,
  getRegistration,
  getProviderCapabilities,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from './registry';

// Error
export { UnknownProviderError } from './errors';

// Provider classes
export { ClaudeProvider } from './claude/provider';
export { CodexProvider } from './codex/provider';

// Config parsers
export { parseClaudeConfig, type ClaudeProviderDefaults } from './claude/config';
export { parseCodexConfig, type CodexProviderDefaults } from './codex/config';

// Utilities (needed by consumers)
export { resetCodexSingleton } from './codex/provider';
export { resolveCodexBinaryPath, fileExists as codexFileExists } from './codex/binary-resolver';
export { resolveClaudeBinaryPath, fileExists as claudeFileExists } from './claude/binary-resolver';

// Community providers
export {
  PiProvider,
  parsePiConfig,
  registerPiProvider,
  type PiProviderDefaults,
} from './community/pi';

// Agent validation (smoke run for the Web UI's Validate button)
export {
  validateAgentSmoke,
  type ValidateAgentResult,
  type AgentValidationFrontmatter,
} from './claude/validate-agent';

// Agent-ref resolution (loaded by workflows at execution time)
export { loadAgentFile, type ResolvedAgent } from './claude/load-agent';
