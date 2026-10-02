/**
 * The provider contract: the shapes every provider emits and the engine, API and console
 * read unchanged. zod is the only dependency, so plugin providers can depend on it too.
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
  providerResultSchema,
  providerStopReasonSchema,
  resolvedModelSchema,
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
  truncateToolOutput,
  warningSchema,
  type ProviderChunk,
  type ProviderEvent,
  type ProviderWarning,
} from './events';
export { providerSettledSchema, type ProviderSettled } from './settled';
export { providerCapabilitiesSchema, type ProviderCapabilities } from './capabilities';
