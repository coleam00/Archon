/**
 * Zod schemas for configuration API endpoints.
 */
import { platformStreamingSchema, type SafeConfig } from '@archon/core/config';
import { z } from '@hono/zod-openapi';
import {
  modelAliasPresetSchema,
  TIER_NAMES,
  type TierName,
} from '@archon/workflows/schemas/model-binding';

/** Schema for the safe config subset returned to web clients (mirrors SafeConfig in config-types.ts). */
const providerDefaultsSchema = z.record(z.string(), z.unknown()).openapi('ProviderDefaults');

/** A single model-tier preset ({ provider, model, effort? }), owned by the engine. */
export const tierEntrySchema = modelAliasPresetSchema.meta({ id: 'TierEntry' });

/**
 * One field per engine tier name. Every tier-shaped body builds its fields here,
 * so a tier added to `TIER_NAMES` reaches the config, user-prefs and update
 * schemas together. Named properties (not a record) keep the generated shape.
 */
export function tierFields<T extends z.ZodType>(entry: T): Record<TierName, T> {
  return Object.fromEntries(TIER_NAMES.map(name => [name, entry])) as Record<TierName, T>;
}

/** The reserved tiers, each optional. */
export const tiersConfigSchema = z
  .object(tierFields(tierEntrySchema.optional()))
  .openapi('TiersConfig');

/** PATCH /api/config/tiers body — each tier optional; `null` unsets that tier. */
export const updateTiersBodySchema = z
  .object({ tiers: z.object(tierFields(tierEntrySchema.nullable().optional())) })
  .openapi('UpdateTiersBody');

export const safeConfigSchema = z
  .object({
    botName: z.string(),
    assistant: z.string().min(1).optional(),
    assistants: z.record(z.string(), providerDefaultsSchema),
    streaming: platformStreamingSchema,
    concurrency: z.object({ maxConversations: z.number() }),
    defaults: z.object({
      loadDefaultCommands: z.boolean(),
      loadDefaultWorkflows: z.boolean(),
    } satisfies {
      [K in keyof SafeConfig['defaults']]: z.ZodType<SafeConfig['defaults'][K]>;
    }),
    // Configured small/medium/large tiers (merged repo > global). Absent keys
    // fall back to `tierDefaults` (built-in presets for the default provider).
    tiers: tiersConfigSchema.optional(),
    tierDefaults: tiersConfigSchema.optional(),
    // Configured @custom model aliases (merged repo > global). Not secrets.
    aliases: z.record(z.string(), tierEntrySchema).optional(),
  } satisfies {
    [K in keyof SafeConfig]-?: z.ZodType<SafeConfig[K]>;
  })
  .openapi('SafeConfig');

/** PATCH /api/config/aliases body — per-key merge; `null` unsets that alias. */
export const updateAliasesBodySchema = z
  .object({
    aliases: z.record(z.string(), tierEntrySchema.nullable()),
  })
  .openapi('UpdateAliasesBody');

/** Body for PATCH /api/config/assistants — all fields optional (partial update). */
export const updateAssistantConfigBodySchema = z
  .object({
    assistant: z.string().min(1).optional(),
    assistants: z.record(z.string(), providerDefaultsSchema).optional(),
  })
  .openapi('UpdateAssistantConfigBody');

/** Response for GET /api/config and PATCH /api/config/assistants — returns updated safe config. */
export const configResponseSchema = z
  .object({
    config: safeConfigSchema,
    database: z.string(),
  })
  .openapi('ConfigResponse');

/** @deprecated Use configResponseSchema instead. */
export const updateAssistantConfigResponseSchema = configResponseSchema;

/** A single isolation environment record. */
export const isolationEnvironmentSchema = z
  .object({
    id: z.string(),
    codebase_id: z.string(),
    branch_name: z.string(),
    working_path: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    days_since_activity: z.number(),
  })
  .openapi('IsolationEnvironment');

/** Response for GET /api/codebases/:id/environments. */
export const codebaseEnvironmentsResponseSchema = z
  .object({
    environments: z.array(isolationEnvironmentSchema),
  })
  .openapi('CodebaseEnvironmentsResponse');
