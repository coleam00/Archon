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
    structuredOutput: z.boolean(),
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
