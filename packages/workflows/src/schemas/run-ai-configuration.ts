import { z } from '@hono/zod-openapi';
import { jsonValueSchema } from '../output-ref';
import { resolvedAiProfileSchema, resolvedRunModelOverridesSchema } from './model-binding';

export const RUN_AI_CONFIGURATION_METADATA_KEY = 'ai_configuration';

export const runAiConfigurationSnapshotSchema = z
  .object({
    version: z.literal(1),
    assistant: z.string().min(1),
    assistants: z.record(z.string(), z.record(z.string(), jsonValueSchema)),
    baseAiProfile: resolvedAiProfileSchema,
    modelOverrides: resolvedRunModelOverridesSchema,
  })
  .strict();

export type RunAiConfigurationSnapshot = z.infer<typeof runAiConfigurationSnapshotSchema>;
