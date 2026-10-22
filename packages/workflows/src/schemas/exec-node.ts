import { z } from 'zod';
import { dagNodeBaseSchema } from './dag-node-base';
import { nodeBindingsSchema } from './node-bindings';

/**
 * `bash:` + `script:` collapsed into one body kind (#2486) at the TYPE level —
 * one `ExecNode` shape, discriminated by `runtime`. `bash:` becomes
 * `runtime: 'sh'`; `deps`/`with` are only ever populated by `dagNodeSchema`'s transform for a
 * `script:` input (a `bash:` input never sets them, matching today's `BashNode`
 * behavior — see the bash and script builders in node-normalize.ts).
 * AI-specific fields from the base are present in the type but ignored at runtime with a
 * warning — except `output_format`, which the transform keeps and the executor enforces
 * against the node's own stdout (#2453).
 *
 * The EXECUTOR deliberately did not follow this collapse: `executeBashNode`/
 * `executeScriptNode` in dag/nodes/exec/ stay two separate functions rather than
 * one `executeExecNode` branching on `runtime` (#2718, decided after a full
 * side-by-side read of both, 222 + 323 = 545 lines). The two are not thin
 * wrappers around one shell-out — real, non-superficial differences: output-ref
 * substitution (shell-escaped + artifacts-dir-aware for bash vs. raw splice for
 * script), `deps:`/named-script-file resolution (script-only), and per-runtime
 * error diagnostics. `$LOOP_USER_INPUT` delivery is NOT a script-only concept —
 * both runtimes deliver it via env (#2725); bash additionally gets the literal
 * `$LOOP_USER_INPUT` token shell-quoted into its source by its loop_group scope, a
 * channel script has no equivalent of. A "merge but
 * keep behavior byte-identical" refactor would relocate rather than remove that
 * complexity, while unifying the ~230 lines of near-identical scaffolding (event
 * emission/persistence, retry wiring, error formatting) into one function risks
 * a regression that touches every deterministic node in every workflow at once —
 * today a bug in one runtime's path can't touch the other. Two bugs the read
 * surfaced along the way (`executeBashNode`'s own env channel for
 * `$LOOP_USER_INPUT` was unwired, so a `bash:` loop_group body node reading it
 * indirectly — `${LOOP_USER_INPUT}`, `printenv`, `env` — always saw an empty
 * value even though the literal-token splice worked; and `script:` node output
 * never getting the truncation cap `bash:` gets) are real independently-evolved
 * drift, not evidence for merging — they're filed as their own fixes, #2725 and
 * #2726, rather than folded into this call.
 */
export const execScriptInputSchema = z.string();
export const execTimeoutInputSchema = z.number();

export const execNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('exec'),
  script: execScriptInputSchema.trim().min(1, {
    error: issue =>
      issue.path?.at(-1) === 'bash' ? 'bash script cannot be empty' : 'script cannot be empty',
  }),
  runtime: z.enum(['sh', 'bun', 'uv']),
  deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
  timeout: execTimeoutInputSchema
    .positive("'timeout' must be a positive number (ms)")
    .finite("'timeout' must be a positive number (ms)")
    .optional(),
  on_timeout: z.literal('skip').optional(),
  // Node-local named bindings (#2637): delivered as INPUTS_<UPPER_SNAKE> env vars.
  // Same value grammar as an agent node's command-sourced `with:`. Only meaningful
  // (and only ever populated) when `runtime !== 'sh'`.
  with: nodeBindingsSchema.optional(),
});

/** DAG node that runs a shell script, or a TypeScript/Python script via bun or uv, without AI */
export type ExecNode = z.infer<typeof execNodeSchema>;

export const bashExecAuthoringSchema = z.object({
  bash: execNodeSchema.shape.script,
  timeout: execNodeSchema.shape.timeout,
  on_timeout: execNodeSchema.shape.on_timeout,
});

export const scriptExecAuthoringSchema = execNodeSchema
  .pick({
    script: true,
    runtime: true,
    deps: true,
    timeout: true,
    on_timeout: true,
    with: true,
  })
  .extend({
    runtime: execNodeSchema.shape.runtime.exclude(['sh']),
  });

// Loose flat types: until a node mode is known the value cannot be judged. A
// selected bash/script node is validated against its strict projection in
// dagNodeSchema; on any other mode these keys are a load error.
export const bashExecFlatSchema = bashExecAuthoringSchema.extend({
  bash: execScriptInputSchema,
  timeout: execTimeoutInputSchema.optional(),
} satisfies Partial<Record<keyof typeof bashExecAuthoringSchema.shape, z.ZodType>>);

export const scriptExecFlatSchema = scriptExecAuthoringSchema.extend({
  script: execScriptInputSchema,
  timeout: execTimeoutInputSchema.optional(),
  with: z.unknown().optional(),
} satisfies Partial<Record<keyof typeof scriptExecAuthoringSchema.shape, z.ZodType>>);

type BashExecAuthoring = z.infer<typeof bashExecAuthoringSchema>;
type ScriptExecAuthoring = z.infer<typeof scriptExecAuthoringSchema>;
type ResolvedExecAuthoring = Pick<
  ExecNode,
  'script' | 'runtime' | 'deps' | 'timeout' | 'on_timeout' | 'with'
>;

export function resolveBashExecAuthoring({
  bash,
  timeout,
  on_timeout,
}: BashExecAuthoring): ResolvedExecAuthoring {
  return {
    script: bash,
    runtime: 'sh',
    ...(timeout !== undefined ? { timeout } : {}),
    ...(on_timeout !== undefined ? { on_timeout } : {}),
  };
}

export function resolveScriptExecAuthoring({
  script,
  runtime,
  deps,
  timeout,
  on_timeout,
  with: bindings,
}: ScriptExecAuthoring): ResolvedExecAuthoring {
  return {
    script,
    runtime,
    ...(deps !== undefined ? { deps } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(on_timeout !== undefined ? { on_timeout } : {}),
    ...(bindings !== undefined ? { with: bindings } : {}),
  };
}
