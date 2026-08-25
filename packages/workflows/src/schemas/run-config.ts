import { z } from '@hono/zod-openapi';
import { MAX_DURABLE_WAIT_MS } from './dag-node';
import { runAliasesConfigSchema, runTiersConfigSchema } from './model-binding';

const providerDefaultsSchema = z.record(z.string(), z.unknown());

export const workflowRunContinuationConfigSchema = z
  .object({
    autoResumeOnQuotaReset: z.boolean().optional(),
    quotaFallbackDelayMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
    quotaMaxAttempts: z.number().int().positive().optional(),
    quotaDeadlineMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
  })
  .strict();

/** Sparse configuration values whose consumers still run after dispatch. */
export const workflowRunConfigLayerSchema = z
  .object({
    assistant: z.string().trim().min(1).optional(),
    assistants: z.record(z.string(), providerDefaultsSchema).optional(),
    aliases: runAliasesConfigSchema.optional(),
    tiers: runTiersConfigSchema.optional(),
    workflows: workflowRunContinuationConfigSchema.optional(),
    docsPath: z.string().trim().min(1).optional(),
    envVars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type WorkflowRunConfigLayer = z.infer<typeof workflowRunConfigLayerSchema>;

export const workflowRunConfigSourceSchema = z
  .object({
    kind: z.enum(['cli', 'http']),
    label: z.string().min(1),
  })
  .strict();

export type WorkflowRunConfigSource = z.infer<typeof workflowRunConfigSourceSchema>;

export const workflowRunConfigInputSchema = z
  .object({
    layer: workflowRunConfigLayerSchema,
    source: workflowRunConfigSourceSchema,
  })
  .strict();

export type WorkflowRunConfigInput = z.infer<typeof workflowRunConfigInputSchema>;

export const workflowRunConfigMetadataSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z.string().min(1),
    source: workflowRunConfigSourceSchema,
    keys: z.array(z.string().min(1)),
  })
  .strict();

export type WorkflowRunConfigMetadata = z.infer<typeof workflowRunConfigMetadataSchema>;
