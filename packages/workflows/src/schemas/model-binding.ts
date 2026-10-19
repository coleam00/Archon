import { z } from 'zod';
import { effortLevelSchema, rejectRetiredThinking } from './effort';

export const TIER_NAMES = ['small', 'medium', 'large'] as const;
export const tierNameSchema = z.enum(TIER_NAMES);
export type TierName = z.infer<typeof tierNameSchema>;

/**
 * A `model:` value: one ref, or a preference list of `@alias` refs ending in a tier or a
 * literal model id. The first alias the run's config defines wins; otherwise the final
 * entry does. The final entry always resolves, which is what lets a bundled workflow name
 * aliases an install may never configure (#3266).
 */
const modelRefListSchema = z
  .array(z.string().trim().min(1))
  .min(2, 'a model preference list needs at least one @alias and a final tier or model')
  .superRefine((refs, ctx) => {
    refs.forEach((ref, index) => {
      const last = index === refs.length - 1;
      if (last && ref.startsWith('@')) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `the last entry of a model preference list must be a tier or a model id, not the alias '${ref}', so the list always resolves`,
        });
      } else if (!last && !ref.startsWith('@')) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `'${ref}' can only be the last entry of a model preference list; entries before it must be @aliases`,
        });
      }
    });
  });
export const modelRefSchema = z.union([z.string(), modelRefListSchema]);
export type WorkflowModelRef = z.infer<typeof modelRefSchema>;

const modelAliasPresetObjectSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: effortLevelSchema.optional(),
});
export const modelAliasPresetSchema = z.preprocess(
  rejectRetiredThinking,
  modelAliasPresetObjectSchema
);
const runModelAliasPresetSchema = z.preprocess(
  rejectRetiredThinking,
  modelAliasPresetObjectSchema.extend({ model: z.string().trim().min(1) }).strict()
);

export type ModelAliasPreset = z.infer<typeof modelAliasPresetSchema>;
export type RawAliasEntry = z.infer<typeof modelAliasPresetSchema>;

export const rawAliasesConfigSchema = z.record(z.string(), modelAliasPresetSchema);
export const runAliasesConfigSchema = z.record(
  z.string().refine(name => name.startsWith('@'), 'run alias names must start with @'),
  runModelAliasPresetSchema
);
export const rawTiersConfigSchema = z.partialRecord(tierNameSchema, modelAliasPresetSchema);
export const runTiersConfigSchema = z.partialRecord(tierNameSchema, runModelAliasPresetSchema);

export type RawAliasesConfig = z.infer<typeof rawAliasesConfigSchema>;
export type RawTiersConfig = z.infer<typeof rawTiersConfigSchema>;

export const resolvedRunModelOverridesSchema = z.object({
  tiers: runTiersConfigSchema.optional(),
  aliases: runAliasesConfigSchema.optional(),
});

export type ResolvedRunModelOverrides = z.infer<typeof resolvedRunModelOverridesSchema>;

export const resolvedAiProfileSchema = z.object({
  defaultProvider: z.string().optional(),
  aliases: rawAliasesConfigSchema,
});

export type ResolvedAiProfile = z.infer<typeof resolvedAiProfileSchema>;

export const runModelBindingsMetadataSchema = z.object({
  overrides: resolvedRunModelOverridesSchema,
  effective: resolvedAiProfileSchema,
});

export type RunModelBindingsMetadata = z.infer<typeof runModelBindingsMetadataSchema>;
