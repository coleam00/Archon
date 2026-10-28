import { z } from 'zod';
import { dagNodeBaseSchema } from './dag-node-base';
import { nodeBindingsSchema } from './node-bindings';

/**
 * Where an agent node's prompt text comes from — inline in the YAML, or a named
 * command file resolved at execution time (`loadCommandPrompt`, dag-executor.ts).
 * A real nested discriminated union rather than two optional sibling fields: it is
 * what makes `with:` on an inline-sourced node a TYPE ERROR instead of a value that
 * silently parses and is dropped (#2478) — `with:` only exists on the 'command'
 * variant, because only a command file has a `$INPUTS.<name>` surface for it to bind
 * into. Precedent for this shape: `nodeContextSchema` in dag-node-base.ts.
 */
export const promptSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), prompt: z.string() }),
  z.object({
    kind: z.literal('command'),
    name: z.string(),
    // Node-local named bindings (#2637): values delivered to the command file's
    // `$INPUTS.<name>` surface. Strings may hold refs/templates; a whole
    // `$node.output[.a.b]` ref passes the logical value; objects are binding
    // directives ({ from, if_skipped }) — validated in node-validation.ts.
    with: nodeBindingsSchema.optional(),
  }),
]);

export type PromptSource = z.infer<typeof promptSourceSchema>;

/**
 * `command:` + `prompt:` collapsed into one body kind (#2486). Both land in the
 * same execution dispatch (`executeAgentNode`, formerly `executeNodeInternal`) —
 * the only divergence between them is where the prompt text comes from, which
 * `source` now expresses directly instead of via which top-level field is set.
 */
export const agentNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('agent'),
  source: promptSourceSchema,
});

/** DAG node that runs an AI prompt — inline, or loaded from a named command file */
export type AgentNode = z.infer<typeof agentNodeSchema>;
