/**
 * Named inputs a node passes on: the `with:` value grammar of command and script nodes,
 * and the input-name rules every `with:` map and `$INPUTS.<name>` reference shares.
 */
import { z } from 'zod';
import { INPUT_NAME_SOURCE, jsonValueSchema } from '../output-ref';

/**
 * Node-local binding directive (#2637) — the explicit form of a `with:` value on a
 * `command:`/`script:` node that reads an upstream output across a possibly-skipped
 * branch. `from` must be exactly one whole `$node.output[.a.b]` reference; when the
 * producer was skipped, the binding takes `if_skipped` instead — and without one, the
 * consuming node fails loudly (never a silent `''`).
 *
 * On command/script `with:` maps, a plain OBJECT value is ALWAYS parsed as this
 * directive (any other object shape is a load error naming both accepted forms) —
 * reserving the object position removes the literal-vs-directive grammar ambiguity
 * without a `$literal` escape. Include/workflow `with:` maps have no directive, so
 * objects there stay ordinary JSON literals.
 */
export const bindingDirectiveSchema = z.strictObject({
  from: z.string().min(1, "'from' must be a non-empty $node.output reference"),
  if_skipped: jsonValueSchema.optional(),
});

export type BindingDirective = z.infer<typeof bindingDirectiveSchema>;

export const nodeBindingsSchema = z.record(
  z.string(),
  z.union([jsonValueSchema, bindingDirectiveSchema])
);

/**
 * Runtime guard for a command/script `with:` value: loader-validated maps only ever
 * hold a directive in object position, but programmatic definitions bypass the
 * loader, so the executor re-checks the discriminating shape before trusting it.
 */
export function isBindingDirective(value: unknown): value is BindingDirective {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === 'string'
  );
}

/**
 * Identifier grammar for an include input name.
 *
 * Shared deliberately with every `$INPUTS.<name>` reference pattern (include-expander,
 * and the template token and whole-ref parser in output-ref), which all build from this
 * source. They encode the identical concept and the drift between them is
 * one-directional and silent: loosening this validator alone would
 * let `with: {my.key: v}` pass while `$INPUTS.my.key` matches only `$INPUTS.my`, leaving
 * `.key` as trailing literal text in the prompt. (The reverse drift fails loudly at load,
 * because the matching `with:` key would be rejected here.) Sharing one source removes the
 * dangerous direction. This is scoped to that family only — the similar-looking node-id
 * grammar elsewhere in the tree encodes a different concept and stays separate.
 *
 * The source itself lives in output-ref.ts beside OUTPUT_REF_SOURCE (one home for
 * every ref grammar); re-exported here so schema-side validators keep their import.
 */
export { INPUT_NAME_SOURCE };
export const INPUT_NAME_PATTERN = new RegExp(`^${INPUT_NAME_SOURCE}$`);

/**
 * Env-var key an input name is delivered under to bash/script sub-run nodes (#2470):
 * `INPUTS_` + UPPER_SNAKE(name) (hyphens → underscores, uppercased). Because `-` and
 * `_` both fold to `_`, two distinct names (`foo-bar`, `foo_bar`) can collide on one
 * env key — the loader rejects that at load time (all names for one workflow are
 * visible there). Bash/script bodies read `$INPUTS_<UPPER_SNAKE>`; `$INPUTS.<name>`
 * text is only substituted into non-shell (AI/prompt) surfaces.
 */
export function inputEnvKey(name: string): string {
  return `INPUTS_${name.replace(/-/g, '_').toUpperCase()}`;
}
