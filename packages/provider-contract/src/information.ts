import { z } from 'zod';

export const providerDiagnosticsSchema = z.object({
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.enum(['ok', 'warn', 'fail', 'skip']),
      message: z.string(),
      remedy: z.string().optional(),
    })
  ),
});
export type ProviderDiagnostics = z.infer<typeof providerDiagnosticsSchema>;

export const providerModelListSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      details: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          reasoning: z.boolean(),
          cost: z.object({ input: z.number(), output: z.number() }),
          contextWindow: z.number(),
        })
        .optional(),
    })
  ),
});
export type ProviderModelList = z.infer<typeof providerModelListSchema>;
