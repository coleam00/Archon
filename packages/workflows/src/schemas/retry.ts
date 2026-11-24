/**
 * Zod schema for step retry configuration.
 */
import { z } from 'zod';

const retryDelaySchema = z.number().max(60000, "'retry.delay_ms' must not exceed 60000");

export const stepRetryConfigSchema = z.object({
  /** Maximum retry attempts (not including the initial attempt). 1–5. */
  max_attempts: z
    .number()
    .int()
    .min(1, "'retry.max_attempts' must be between 1 and 5")
    .max(5, "'retry.max_attempts' must be between 1 and 5"),
  /** Initial delay in ms, doubled on each attempt. 1000–60000. */
  delay_ms: retryDelaySchema
    .min(1000, "'retry.delay_ms' must be a number between 1000 and 60000")
    .optional(),
  /**
   * Which failures trigger a retry, as a ladder. Default: 'transient', the transient,
   * rate-limit and capacity classes. 'schema_unmet' adds a final output that did not meet
   * its schema; it targets that class without retrying `unknown`, not that class only.
   * 'all' adds `unknown` too. Fatal failures are never retried.
   */
  on_error: z.enum(['transient', 'schema_unmet', 'all']).optional(),
});

export type StepRetryConfig = z.infer<typeof stepRetryConfigSchema>;

export const loopRetryConfigSchema = stepRetryConfigSchema.extend({
  delay_ms: retryDelaySchema.min(0, "'retry.delay_ms' must not be negative").optional(),
  // A loop iteration never retries `unknown`; every other value is the node's own.
  on_error: stepRetryConfigSchema.shape.on_error.unwrap().exclude(['all']).optional(),
});
