// Types (contract layer — re-exported for convenience)
export type {
  IAgentProvider,
  AgentRequestOptions,
  SendQueryOptions,
  NodeConfig,
  ProviderCapabilities,
  MessageChunk,
  TokenUsage,
  PiProviderDefaults,
} from './types';

// Provider config types (canonical definitions in ./types, re-exported via config modules)
// Import from ./types directly or from the config modules — both work.

// Factory
export { getAgentProvider, getProviderCapabilities } from './factory';
// Static capability constants are intentionally NOT re-exported here.
// Use getProviderCapabilities() instead — it's the correct public seam.

// Error
export { UnknownProviderError } from './errors';

// Provider classes
export { ClaudeProvider } from './claude/provider';
export { CodexProvider } from './codex/provider';
export { PiProvider } from './pi/provider';

// Config parsers
export { parseClaudeConfig, type ClaudeProviderDefaults } from './claude/config';
export { parseCodexConfig, type CodexProviderDefaults } from './codex/config';
export { parsePiConfig } from './pi/config';

// Utilities (needed by consumers)
export { resetCodexSingleton } from './codex/provider';
export { resolveCodexBinaryPath, fileExists } from './codex/binary-resolver';
