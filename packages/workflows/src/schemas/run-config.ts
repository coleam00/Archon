import { z } from 'zod';
import { MAX_DURABLE_WAIT_MS } from './durable-wait';
import { runAliasesConfigSchema, runTiersConfigSchema } from './model-binding';

export const DEFAULT_TOOL_CALL_ATTENTION_MS = 30 * 60 * 1000;

const providerDefaultsSchema = z.record(z.string(), z.unknown());

/**
 * Settings of the scheduled quota continuation that a usage-limit wait replaced. They
 * still parse, so a config file or a persisted run config that sets them stays readable,
 * but they have no effect: a usage-limit wait lasts until the provider's reported reset,
 * with no fallback time, attempt cap or deadline.
 */
const deprecatedQuotaPolicySchema = z.object({
  quotaFallbackDelayMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
  quotaMaxAttempts: z.number().int().positive().optional(),
  quotaDeadlineMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
});
const DEPRECATED_QUOTA_POLICY_KEYS = deprecatedQuotaPolicySchema.keyof().options;
type DeprecatedQuotaPolicyKey = (typeof DEPRECATED_QUOTA_POLICY_KEYS)[number];

export const workflowRunContinuationConfigSchema = z
  .object({
    toolCallAttentionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    autoResumeOnQuotaReset: z.boolean().optional(),
    ...deprecatedQuotaPolicySchema.shape,
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

export type WorkflowContinuationConfig = z.infer<typeof workflowRunContinuationConfigSchema>;

export type LiveWorkflowPolicy = Omit<WorkflowContinuationConfig, DeprecatedQuotaPolicyKey>;
export type ResolvedWorkflowPolicy = LiveWorkflowPolicy & { autoResumeOnQuotaReset: boolean };

/** `config` without its deprecated keys. */
export function liveWorkflowPolicy(config: WorkflowContinuationConfig): LiveWorkflowPolicy {
  const live = { ...config };
  for (const key of DEPRECATED_QUOTA_POLICY_KEYS) delete live[key];
  return live;
}

/** The deprecation warning for `config`, or undefined when it sets no deprecated key. */
export function deprecatedQuotaPolicyWarning(
  config: WorkflowContinuationConfig
): string | undefined {
  const keys = DEPRECATED_QUOTA_POLICY_KEYS.filter(key => config[key] !== undefined);
  if (keys.length === 0) return undefined;
  return (
    `workflows.${keys.join(', workflows.')} ` +
    (keys.length === 1
      ? 'is deprecated and has no effect. '
      : 'are deprecated and have no effect. ') +
    'A run that hits a provider usage limit waits until the reset time the ' +
    'provider reports, and one whose rate limit outlasts its retries waits and tries again; ' +
    "'workflows.autoResumeOnQuotaReset: false' turns that off."
  );
}
