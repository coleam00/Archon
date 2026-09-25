/**
 * The provider contract: the shapes every provider emits and the engine, API and console
 * read unchanged. zod is the only dependency, so plugin providers can depend on it too.
 * The JSON Schema in `schema/` is generated from these schemas by
 * `scripts/generate-provider-contract-schema.ts`.
 */
export {
  providerFailureClassSchema,
  providerFailureSchema,
  type ProviderFailure,
  type ProviderFailureClass,
} from './failure';
export {
  providerResultSchema,
  resolvedModelSchema,
  tokenUsageSchema,
  type ProviderResult,
  type ResolvedModel,
  type TokenUsage,
} from './result';
export { providerCapabilitiesSchema, type ProviderCapabilities } from './capabilities';
