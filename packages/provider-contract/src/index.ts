/**
 * SDK-free shapes exchanged by providers, the engine and hosts. zod is the only
 * dependency, so plugin providers can depend on this contract too.
 * The JSON Schema in `schema/` is generated from these schemas by
 * `src/scripts/generate-schema.ts` (`bun run generate:provider-contract-schema`).
 */
export {
  providerFailureClassSchema,
  providerFailureSchema,
  type ProviderFailure,
  type ProviderFailureClass,
} from './failure';
export {
  credentialSourceSchema,
  credentialStatusSchema,
  type CredentialSource,
  type CredentialStatus,
} from './credential-status';
export {
  providerResultSchema,
  providerStopReasonSchema,
  resolvedModelSchema,
  SESSION_PREVIEW_LENGTH,
  sessionPreview,
  tokenUsageSchema,
  type ProviderResult,
  type ProviderStopReason,
  type ResolvedModel,
  type TokenUsage,
} from './result';
export {
  agentMessageChunkSchema,
  agentThoughtChunkSchema,
  compactionSchema,
  hookSchema,
  mcpServerStatusSchema,
  providerChunkSchema,
  providerEventSchema,
  providerWarningSchema,
  stateUpdateSchema,
  subtaskSchema,
  subtaskTerminalStatusSchema,
  TOOL_OUTPUT_MAX_CHARS,
  toolCallSchema,
  toolCallStatusSchema,
  toolCallUpdateSchema,
  toolCallDisplayName,
  truncateToolOutput,
  warningSchema,
  type ProviderChunk,
  type ProviderEvent,
  type ProviderWarning,
} from './events';
export { providerSettledSchema, type ProviderSettled } from './settled';
export { providerCapabilitiesSchema, type ProviderCapabilities } from './capabilities';

export {
  EFFORT_LADDER,
  isEffortRung,
  clampEffort,
  type EffortRung,
  type AssertNever,
} from './effort';
export { mergeTokenUsage } from './result';
export {
  isObjectSchemaNode,
  findStrictSchemaIssues,
  type StrictSchemaIssue,
} from './output-schema';
export {
  agentDefinitionSchema,
  type AgentDefinition,
  CONTAINER_ENV_DENYLIST,
  defineNativeToolInputSchema,
  type MessageChunk,
  type ResultChunk,
  type SystemPromptPreset,
  type SystemPromptInput,
  type ExecutionContext,
  type AgentRequestOptions,
  type NativeToolProperty,
  type NativeToolInputSchema,
  type NativeTool,
  type NodeConfig,
  type ProviderAdmissionEvent,
  type SendQueryOptions,
  type IAgentProvider,
  type PiExtensionPosture,
} from './agent-provider';
export {
  CREDENTIAL_KINDS,
  UnknownProviderError,
  InvalidProviderRunConfigError,
  type ProviderDefaults,
  type ProviderConfigScope,
  type ProviderConfigParser,
  type ProviderDefaultsMap,
  type CredentialKind,
  type CredentialSpec,
  type ProviderCredentialCatalog,
  type ProviderRegistration,
  type ProviderDescriptor,
  type ProviderRegistry,
  requireProvider,
  parseProviderRunModel,
} from './registration';
