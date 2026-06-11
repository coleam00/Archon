/**
 * Zod schemas for provider API endpoints.
 */
import { z } from '@hono/zod-openapi';

/** Provider capability flags. */
const providerCapabilitiesSchema = z
  .object({
    sessionResume: z.boolean(),
    mcp: z.boolean(),
    hooks: z.boolean(),
    skills: z.boolean(),
    toolRestrictions: z.boolean(),
    // Mirrors ProviderCapabilities.structuredOutput: 'enforced' | 'best-effort' | false.
    structuredOutput: z.union([z.literal('enforced'), z.literal('best-effort'), z.literal(false)]),
    envInjection: z.boolean(),
    costControl: z.boolean(),
    effortControl: z.boolean(),
    thinkingControl: z.boolean(),
    fallbackModel: z.boolean(),
    sandbox: z.boolean(),
  })
  .openapi('ProviderCapabilities');

/** A single provider info entry (API-safe projection of ProviderRegistration). */
export const providerInfoSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    capabilities: providerCapabilitiesSchema,
    builtIn: z.boolean(),
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
