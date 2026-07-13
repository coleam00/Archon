/**
 * Zod schemas for loop node configuration.
 *
 * Two loop variants share the same iteration-control surface (`loopControlSchema`):
 *  - `loop:`           — intra-node iteration: repeats a single inline `prompt` per iteration.
 *  - `loop_group:`     — cross-node iteration: repeats a `nodes:` sub-DAG body per iteration.
 *
 * `loopControlSchema` carries the fields both need (completion gate, iteration cap,
 * session reset, interactive gate). Each variant extends it with its body shape.
 */
import { z } from '@hono/zod-openapi';

/**
 * Shared iteration-control fields for `loop:` and `loop_group:`.
 * Error messages keep the `loop.` qualifier (matching the pre-refactor `loop:`
 * wording, which existing tests assert) — both variants surface the same text.
 */
export const loopControlSchema = z
  .object({
    /** Completion signal string detected in AI output (e.g., "COMPLETE"). */
    until: z.string().min(1, "loop node requires 'loop.until' (completion signal string)"),
    /** Maximum iterations allowed; exceeding this fails the node. */
    max_iterations: z.number().int().positive("'loop.max_iterations' must be a positive integer"),
    /** Whether to start fresh session each iteration (default: false). */
    fresh_context: z.boolean().default(false),
    /** Optional bash script run after each iteration; exit 0 = complete. */
    until_bash: z.string().optional(),
    /** When true, pause between iterations for user input via /workflow approve. */
    interactive: z.boolean().optional(),
    /** Message shown to user when paused (required when interactive is true). */
    gate_message: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.interactive === true && !data.gate_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "interactive loop requires 'loop.gate_message' (non-empty string)",
        path: ['gate_message'],
      });
    }
  });

export type LoopControl = z.infer<typeof loopControlSchema>;

/** `loop:` node config — iteration control plus a single inline prompt. */
export const loopNodeConfigSchema = loopControlSchema.extend({
  /** Inline prompt text executed each iteration. */
  prompt: z.string().min(1, "loop node requires 'loop.prompt' (non-empty string)"),
});

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
