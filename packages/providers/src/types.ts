import type { EffortRung, ProviderCapabilities } from '@archon/provider-contract';

export type {
  MessageChunk,
  ResultChunk,
  SystemPromptInput,
  ExecutionContext,
  AgentRequestOptions,
  NativeToolProperty,
  NativeToolInputSchema,
  NativeTool,
  NodeConfig,
  ProviderAdmissionEvent,
  SendQueryOptions,
  IAgentProvider,
  ProviderDefaults,
  ProviderConfigScope,
  ProviderConfigParser,
  ProviderDefaultsMap,
  CredentialKind,
  CredentialSpec,
  ProviderCredentialCatalog,
  ProviderRegistration,
  ProviderCapabilities,
  ProviderEvent,
  ProviderWarning,
  TokenUsage,
} from '@archon/provider-contract';
export {
  CONTAINER_ENV_DENYLIST,
  defineNativeToolInputSchema,
  CREDENTIAL_KINDS,
  mergeTokenUsage,
} from '@archon/provider-contract';

// ─── Provider Config Defaults ──────────────────────────────────────────────
// Each type is derived from its provider's config schema, which owns the shape.
// @archon/core/config/config-types.ts imports them from here.
export type { ClaudeProviderDefaults } from './claude/config';
export type { CodexProviderDefaults } from './codex/config';
export type { CopilotProviderDefaults } from './community/copilot/config';
export type { PiProviderDefaults } from './community/pi/config';
export type { OpencodeProviderDefaults } from './community/opencode/config';

/**
 * API-safe projection of ProviderRegistration (excludes non-serializable fields).
 * Used by GET /api/providers and consumed by the Web UI.
 */
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  builtIn: boolean;
  /** The shared ladder when this provider accepts `effort:`; absent otherwise. */
  effortLevels?: readonly EffortRung[];
}
