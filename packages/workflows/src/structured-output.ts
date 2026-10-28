// ajv MUST resolve to ^8 — a transitive ajv@6 has a different API/draft.
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

// ─── Schema validation (ajv) ─────────────────────────────────────────────────

/**
 * Single process-wide ajv instance. `strict: false` keeps it tolerant of the
 * dialect drift real author schemas carry (unknown keywords/formats are ignored
 * rather than throwing at compile time); `allErrors: true` surfaces every
 * failure at once so a reask prompt can list them all.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compiled-validator cache keyed by the schema object identity. Compilation is
 * the cost (validation is cheap), and the dag-executor passes the same
 * `node.output_format` object across a node's lifetime (including every reask
 * attempt), so a WeakMap keyed by reference is a free hit without holding the
 * schema alive past its node.
 */
const validatorCache = new WeakMap<object, ValidateFunction>();

/**
 * Compile `schema` once and keep the validator in {@link validatorCache}.
 * Throws ajv's compile error unchanged; both public entry points translate it.
 *
 * The `removeSchema` call drops ajv's OWN registry entry while keeping the
 * compiled function. Without it, a schema that declares `$id` registers that id
 * process-wide, and the next compile of an equivalent-but-distinct schema object
 * — the same workflow re-parsed for `/workflow list`, an include-expanded clone,
 * or a second run of the same file — throws `schema with key or id "…" already
 * exists`. That used to degrade to a warning; a compile failure is now fatal at
 * load and at the node boundary, so the duplicate registration would turn a
 * perfectly valid workflow into a spurious failure. Nothing here resolves a
 * `$ref` against another node's schema, so the registry has no other job.
 */
function compileAndCache(schema: Record<string, unknown>): ValidateFunction {
  try {
    const validate = ajv.compile(schema);
    validatorCache.set(schema, validate);
    return validate;
  } finally {
    // ajv registers a `$id` BEFORE it resolves references, so a compile that throws on
    // a dangling `$ref` still leaves the id registered; without this the author's next
    // attempt with the same `$id` fails with "already exists" instead of their real error.
    ajv.removeSchema(schema);
  }
}

/**
 * Compile a declared `output_format` and report why ajv rejected it, or `null`
 * when it compiles. The workflow loader calls this for every node schema so a
 * contract that cannot be enforced fails the file BEFORE a provider is paid,
 * instead of surfacing as a runtime warning after the spend.
 *
 * `strict: false` keeps tolerated dialect annotations (unknown keywords and
 * formats) compiling, so only a schema ajv genuinely rejects — a dangling
 * `$ref`, an invalid keyword value — produces a message. A successful compile
 * warms the same cache {@link validateStructuredOutput} reads, so the load-time
 * check costs nothing at runtime.
 */
export function compileOutputSchema(schema: Record<string, unknown>): string | null {
  if (validatorCache.has(schema)) return null;
  try {
    compileAndCache(schema);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Discriminated so the `errors` array only exists on the failure branch — the
 * caller can't read errors off a valid result, and a valid result can't smuggle
 * a non-empty errors list.
 */
export type StructuredValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validate a parsed structured-output value against the node's declared JSON
 * Schema. Used for EVERY provider that declares `output_format` — even
 * SDK-enforced ones (Claude/Codex/OpenCode) need this net for the refusal /
 * `max_tokens`-truncation edges that bypass grammar-constrained decoding.
 *
 * The author's schema is validated as written — `additionalProperties` is NOT
 * required (that is an OpenAI-strict-mode concern handled separately by the
 * Codex normalizer), and optional fields stay optional.
 *
 * A schema ajv cannot compile (exotic dialect, bad `$ref`) is reported through
 * the `onCompileError` hook and the value is NOT judged here — the result is
 * `{ valid: true }` because this helper has no schema to judge against. Deciding
 * what an unenforceable contract means belongs to the caller: the dag-executor
 * fails the node, because {@link compileOutputSchema} already rejects such a
 * schema at load time, so reaching this branch means a declared contract would
 * otherwise cross a boundary unenforced.
 */
export function validateStructuredOutput(
  value: unknown,
  schema: Record<string, unknown>,
  onCompileError?: (message: string) => void
): StructuredValidationResult {
  let validate = validatorCache.get(schema);
  if (!validate) {
    try {
      validate = compileAndCache(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onCompileError?.(message);
      // Can't validate → don't block. The net only covers compilable schemas.
      return { valid: true };
    }
  }

  if (validate(value)) return { valid: true };
  return { valid: false, errors: formatSchemaErrors(validate.errors) };
}

/**
 * Render ajv errors as `path: message` lines for reask prompts and logs.
 * `instancePath` is empty for a root-level failure (e.g. a missing top-level
 * required field), rendered as `(root)`. Returns a single generic line when ajv
 * reports a failure with no error detail (shouldn't happen with `allErrors`).
 */
export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ['value does not match the declared schema'];
  }
  return errors.map(e => {
    const path = e.instancePath && e.instancePath.length > 0 ? e.instancePath : '(root)';
    const detail = e.params?.missingProperty
      ? `${e.message} ('${String(e.params.missingProperty)}')`
      : (e.message ?? 'invalid');
    return `${path}: ${detail}`;
  });
}
