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

const providerCredentialSourceSchema = z
  .object({
    type: z.enum(['env', 'file', 'login']),
    name: z.string(),
    present: z.boolean(),
    active: z.boolean().optional(),
    note: z.string().optional(),
    displayHint: z.string().optional(),
  })
  .openapi('ProviderCredentialSource');

const providerDiagnosticsSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    builtIn: z.boolean(),
    capabilities: providerCapabilitiesSchema,
    credentialStatus: z.object({
      available: z.boolean(),
      verified: z.boolean(),
      mode: z.string(),
      activeCredentialHint: z.string().optional(),
      sources: z.array(providerCredentialSourceSchema),
      notes: z.array(z.string()),
    }),
    modelStatus: z.object({
      configured: z.string().nullable(),
      examples: z.array(z.string()),
      accessVerified: z.boolean(),
      notes: z.array(z.string()),
    }),
  })
  .openapi('ProviderDiagnostics');

export const providerDiagnosticsListResponseSchema = z
  .object({
    providers: z.array(providerDiagnosticsSchema),
  })
  .openapi('ProviderDiagnosticsListResponse');
