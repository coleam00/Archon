/**
 * Zod schemas for provider API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { EFFORT_LADDER } from '@archon/paths/effort';
import type { ProviderCapabilities } from '@archon/providers';

type ProviderCapabilityShape = {
  [K in keyof ProviderCapabilities]-?: z.ZodType<ProviderCapabilities[K]>;
};

/** Provider capability flags. */
const providerCapabilitiesSchema = z
  .object({
    sessionResume: z.boolean(),
    sessionFork: z.boolean().optional(),
    mcp: z.boolean(),
    hooks: z.boolean(),
    skills: z.boolean(),
    agents: z.boolean(),
    toolRestrictions: z.boolean(),
    knownToolNames: z.array(z.string()).optional(),
    renamedTools: z.record(z.string(), z.string()).optional(),
    structuredOutput: z.union([z.literal('enforced'), z.literal('best-effort'), z.literal(false)]),
    requiresAllPropertiesRequired: z.boolean(),
    envInjection: z.boolean(),
    costControl: z.boolean(),
    costReporting: z.boolean(),
    tokenReporting: z.boolean().optional(),
    stopReasonReporting: z.boolean().optional(),
    turnCountReporting: z.boolean().optional(),
    resolvedModelReporting: z.boolean().optional(),
    effortControl: z.boolean(),
    fallbackModel: z.boolean(),
    sandbox: z.boolean(),
    settingSources: z.boolean(),
    nativeTools: z.boolean(),
    containerExec: z.boolean(),
  } satisfies ProviderCapabilityShape)
  .openapi('ProviderCapabilities');

/** A single provider info entry (API-safe projection of ProviderRegistration). */
export const providerInfoSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    capabilities: providerCapabilitiesSchema,
    builtIn: z.boolean(),
    effortLevels: z.array(z.enum(EFFORT_LADDER)).optional(),
  })
  .openapi('ProviderInfo');

/** Response for GET /api/providers. */
export const providerListResponseSchema = z
  .object({
    providers: z.array(providerInfoSchema),
  })
  .openapi('ProviderListResponse');

/** One Pi catalog model — metadata only (no credentials). */
export const piModelInfoSchema = z
  .object({
    ref: z.string(),
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    reasoning: z.boolean(),
    cost: z.object({ input: z.number(), output: z.number() }),
    contextWindow: z.number(),
  })
  .openapi('PiModelInfo');

/** Response for GET /api/providers/pi/models — `[]` when the catalog can't load. */
export const piModelListResponseSchema = z
  .object({
    models: z.array(piModelInfoSchema),
  })
  .openapi('PiModelListResponse');

/** One OpenCode backend provider, introspected from the embedded server (#1955). */
export const opencodeCredentialProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    env: z.array(z.string()),
    /** Install-wide: OpenCode's auth store is server-global, not per-user. */
    connected: z.boolean(),
    modelCount: z.number(),
    authMethods: z.array(z.object({ type: z.enum(['oauth', 'api']), label: z.string() })),
  })
  .openapi('OpencodeCredentialProvider');

/** Response for GET /api/providers/opencode/credentials. */
export const opencodeCredentialListResponseSchema = z
  .object({
    providers: z.array(opencodeCredentialProviderSchema),
  })
  .openapi('OpencodeCredentialListResponse');
