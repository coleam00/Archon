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
 * A declared value that is not merely whitespace. Used to validate the completion
 * channels WITHOUT trimming them — see the field docs on `until` / `until_bash`
 * for why the stored value must survive verbatim.
 */
const isNonBlank = (value: string): boolean => value.trim().length > 0;

/**
 * Shared iteration-control fields for `loop:` and `loop_group:`.
 * Error messages keep the `loop.` qualifier (matching the pre-refactor `loop:`
 * wording, which existing tests assert) — both variants surface the same text.
 *
 * ## Completion channels (#2563)
 *
 * A loop ends through a **completion channel** it declared. This shared surface
 * carries two — `until` (prose signal) and `until_bash` (deterministic check) —
 * and `loop:` adds a third, `until_field` (a declared boolean in the node's
 * `output_format`), which `loop_group:` does not have. No single one is required:
 * a loop whose completion is fully checkable declares only `until_bash` and then
 * has no prose-matching path at all, so a sentinel string the model happens to
 * emit while reasoning cannot end it.
 *
 * Two independent rules govern the set, and both are needed:
 *  - **per channel** — a declared channel must carry a usable (non-blank) value;
 *  - **across channels** — at least one channel must be declared (`superRefine`).
 *
 * The across rule alone is not enough: it fires only when NO channel is declared,
 * so a blank field beside a valid sibling would slip through. A blank channel is
 * broken at runtime rather than merely untidy — `bash -c "   "` exits 0, so a blank
 * `until_bash` completes on iteration 1, and a blank `until` reaches
 * `detectCompletionSignal`, whose own-line and end-of-output patterns then match a
 * whitespace-only markdown line or any output ending in a space.
 *
 * Adding a channel means adding it to BOTH rules here, and to TWO hand-maintained
 * files in the console builder — @archon/web cannot import this package, so they
 * agree by convention rather than by type. They fail differently, and the second
 * is the dangerous one:
 *  - `builder/validation/structural.ts` mirrors these rules. Miss it and the
 *    builder reports the wrong verdict for a workflow the engine accepts.
 *  - `builder/variants/loop.ts` (`loopFromDag`/`loopToDag`) is a hand-written FIELD
 *    LIST, and the importer's unsupported-key warning only walks TOP-LEVEL wire
 *    keys — anything nested inside `loop: {…}` is invisible to it. Miss it and the
 *    field is SILENTLY DELETED the first time anyone opens the workflow in the
 *    console and saves: no import issue, no warning, the loop just quietly loses a
 *    completion channel. `signal_completes` behaves this way today.
 *
 * Verify agreement by parsing both, never by reading them —
 * `scripts/node-ref-parity.test.ts` does exactly that, in CI.
 */
export const loopControlSchema = z
  .object({
    /**
     * Completion signal string detected in AI output (e.g., "COMPLETE").
     * Optional since #2563 — required only when no other completion channel is
     * declared (see the at-least-one refinement below).
     *
     * Validated non-blank, but NOT trimmed: `detectCompletionSignal` matches this
     * value verbatim, so rewriting it here would silently change what an existing
     * workflow matches on. (`command` below does trim, deliberately — it is a
     * filename resolved downstream, where the trimmed form is what resolution
     * sees.) Different jobs, different treatment.
     */
    until: z
      .string()
      .refine(isNonBlank, "'loop.until' must be a non-blank completion signal string")
      .optional(),
    /** Maximum iterations allowed; exceeding this fails the node. */
    max_iterations: z.number().int().positive("'loop.max_iterations' must be a positive integer"),
    /** Whether to start fresh session each iteration (default: false). */
    fresh_context: z.boolean().default(false),
    /**
     * Optional bash script run after each iteration; exit 0 = complete.
     * Non-blank for the same reason as `until`, and not trimmed for the same one:
     * the script is executed verbatim, and leading whitespace can be meaningful
     * inside one (a heredoc body, an indented continuation).
     */
    until_bash: z
      .string()
      .refine(isNonBlank, "'loop.until_bash' must be a non-blank shell script")
      .optional(),
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
 * The across-channels rule, applied by each loop variant to its own channel set.
 *
 * It lives here rather than on `loopControlSchema` because the two variants no
 * longer have the same channels: `until_field` (#2563 Part B) is `loop:`-only, so a
 * shared check would either reject a valid `loop:` or accept a channel-less
 * `loop_group:`. A parent refinement cannot be relaxed by a child, so the rule
 * moves down to where the channel set is known.
 *
 * Blank values are already rejected per channel by the time this runs, so presence
 * is the only test left. `declared` is the list of channel names the variant found,
 * `available` the ones it accepts (for the message).
 */
export function addMissingChannelIssue(
  ctx: z.RefinementCtx,
  declared: readonly string[],
  available: readonly { field: string; describe: string }[]
): void {
  if (declared.length > 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'loop node requires a completion channel: set ' +
      available.map(c => `'loop.${c.field}' (${c.describe})`).join(' or '),
    path: ['until'],
  });
}

/** The two channels every loop variant has. */
export const BASE_COMPLETION_CHANNELS = [
  { field: 'until', describe: 'completion signal string' },
  { field: 'until_bash', describe: 'deterministic check, exit 0 = complete' },
] as const;

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
    /**
     * Structured completion channel (#2563 Part B): the name of a property in this
     * node's `output_format` schema whose validated value `true` ends the loop.
     *
     * This is the channel for a loop whose completion is a JUDGMENT the model makes
     * — "am I done?" — with no externally checkable state to test. `until_bash`
     * covers the checkable case; before this, judgment had only the prose sentinel.
     *
     * `loop:` only, and the asymmetry is principled rather than convenient. A
     * `loop_group:` body node can already declare `output_format` and be read by
     * `until_bash: '[ "$decide.output.done" = "true" ]'` — node-output refs are
     * substituted into `until_bash` against the current iteration's outputs, and
     * booleans render unquoted. The single-prompt `loop:` has no such handle: its
     * judgment lives in its own AI turn, which has no node id, and `until_bash` runs
     * after that turn but can only see the PREVIOUS iteration's text. That is the
     * gap this fills. On a `loop_group:` the key is unknown and warns.
     *
     * The named property must be declared in `output_format.properties`, listed in
     * `output_format.required`, and typed `boolean` — all checked at load time in
     * `dagNodeSchema`, which can see both the node's `output_format` and this field.
     */
    until_field: z
      .string()
      .trim()
      .min(1, "'loop.until_field' must name a property in the node's output_format")
      .optional(),
  })
  .superRefine((data, ctx) => {
    // The across-channels rule for `loop:` — three channels, unlike loop_group's two.
    addMissingChannelIssue(
      ctx,
      [data.until, data.until_bash, data.until_field].filter(v => v !== undefined),
      [
        ...BASE_COMPLETION_CHANNELS,
        { field: 'until_field', describe: 'a declared boolean in output_format' },
      ]
    );

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
