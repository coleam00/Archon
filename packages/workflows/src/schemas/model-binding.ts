import { z } from '@hono/zod-openapi';
import { thinkingConfigSchema } from './dag-node';

export const TIER_NAMES = ['small', 'medium', 'large'] as const;
export const tierNameSchema = z.enum(TIER_NAMES);
export type TierName = z.infer<typeof tierNameSchema>;

export const modelAliasPresetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().optional(),
  thinking: thinkingConfigSchema.optional(),
});

export type ModelAliasPreset = z.infer<typeof modelAliasPresetSchema>;
export type RawAliasEntry = z.infer<typeof modelAliasPresetSchema>;

export const rawAliasesConfigSchema = z.record(z.string(), modelAliasPresetSchema);
export const runAliasesConfigSchema = z.record(
  z.string().refine(name => name.startsWith('@'), 'run alias names must start with @'),
  modelAliasPresetSchema
);
export const rawTiersConfigSchema = z.partialRecord(tierNameSchema, modelAliasPresetSchema);

export type RawAliasesConfig = z.infer<typeof rawAliasesConfigSchema>;
export type RawTiersConfig = z.infer<typeof rawTiersConfigSchema>;

export const resolvedRunModelOverridesSchema = z.object({
  tiers: rawTiersConfigSchema.optional(),
  aliases: runAliasesConfigSchema.optional(),
});

export type ResolvedRunModelOverrides = z.infer<typeof resolvedRunModelOverridesSchema>;

export const resolvedAiProfileSchema = z.object({
  defaultProvider: z.string(),
  aliases: rawAliasesConfigSchema,
});

export type ResolvedAiProfile = z.infer<typeof resolvedAiProfileSchema>;

export const runModelBindingsMetadataSchema = z.object({
  overrides: resolvedRunModelOverridesSchema,
  effective: resolvedAiProfileSchema,
});

export type RunModelBindingsMetadata = z.infer<typeof runModelBindingsMetadataSchema>;
