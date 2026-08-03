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
import { isValidCommandName } from '../command-validation';

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
    /**
     * When true, a detected completion signal completes the node immediately —
     * even on the first iteration of a fresh interactive loop — instead of gating.
     * No effect on non-interactive loops (the signal already completes them). Default false.
     */
    signal_completes: z.boolean().optional(),
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

/**
 * `loop:` node config — iteration control plus exactly one iteration-prompt source:
 * an inline `prompt` or a named command file (`command`). `loop_group:` shares only
 * the control surface, so the one-of refinement lives here, not on `loopControlSchema`.
 */
export const loopNodeConfigSchema = loopControlSchema
  .extend({
    /** Inline prompt text executed each iteration. Mutually exclusive with `command`. */
    prompt: z.string().min(1, "'loop.prompt' must be a non-empty string").optional(),
    /**
     * Named command file (under `.archon/commands/`) whose body is loaded as the iteration
     * prompt. Resolved with repo → home → bundled precedence, identical to `command:` nodes.
     * Mutually exclusive with `prompt`. Surrounding whitespace is trimmed so the stored value
     * matches what downstream resolution sees — otherwise a value like `" my-cmd "` could pass
     * parse-time validation and fail at runtime with a confusing "not found" error.
     */
    command: z.string().trim().min(1, "'loop.command' must be a non-empty string").optional(),
  })
  .superRefine((data, ctx) => {
    const hasPrompt = typeof data.prompt === 'string' && data.prompt.length > 0;
    const hasCommand = typeof data.command === 'string' && data.command.length > 0;

    if (hasPrompt && hasCommand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "loop node accepts exactly one of 'loop.prompt' or 'loop.command' (both were provided)",
        path: ['command'],
      });
    } else if (!hasPrompt && !hasCommand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loop node requires either 'loop.prompt' (inline) or 'loop.command' (file)",
        path: ['prompt'],
      });
    }

    if (hasCommand && !isValidCommandName(data.command ?? '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid command name "${data.command ?? ''}" — must not contain path separators, '..', or start with '.'`,
        path: ['command'],
      });
    }
  });

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
