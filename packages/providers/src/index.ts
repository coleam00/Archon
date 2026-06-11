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

// Shared structured-output helpers (cross-provider; the dag-executor validates
// every provider's output_format result against the declared schema).
export {
  validateStructuredOutput,
  formatSchemaErrors,
  type StructuredValidationResult,
} from './shared/structured-output';

// Provider classes
export { ClaudeProvider } from './claude/provider';
export { CodexProvider } from './codex/provider';

// Config parsers
export { parseClaudeConfig, type ClaudeProviderDefaults } from './claude/config';
export { parseCodexConfig, type CodexProviderDefaults } from './codex/config';

// Utilities (needed by consumers)
export { resetCodexSingleton } from './codex/provider';
export { loadMcpConfig, type LoadedMcpConfig } from './mcp/config';
export { resolveCodexBinaryPath, fileExists as codexFileExists } from './codex/binary-resolver';
export { resolveClaudeBinaryPath, fileExists as claudeFileExists } from './claude/binary-resolver';

// Community providers
export {
  OpencodeProvider,
  parseOpencodeConfig,
  registerOpencodeProvider,
  type OpencodeProviderDefaults,
} from './community/opencode';
export {
  PiProvider,
  parsePiConfig,
  registerPiProvider,
  listPiModels,
  type PiProviderDefaults,
  type PiModelInfo,
} from './community/pi';

export {
  CopilotProvider,
  parseCopilotConfig,
  registerCopilotProvider,
  resetCopilotSingleton,
  type CopilotProviderDefaults,
} from './community/copilot';
export {
  resolveCopilotBinaryPath,
  fileExists as copilotFileExists,
} from './community/copilot/binary-resolver';
