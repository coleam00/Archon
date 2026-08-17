/**
 * The declared-input contract (#2470, #2554), shared by every call surface.
 *
 * A workflow's `inputs:` block is one contract with three callers:
 *   - `include:` resolves it at LOAD time (include-expander.ts), splicing values into
 *     `$INPUTS.<name>` before the DAG is ever persisted;
 *   - `workflow:` resolves it at RUN time (executor.ts), persisting the resolved map to
 *     the child's `metadata.inputs`;
 *   - a DIRECT top-level invocation resolves it at the invocation gate (#2554) —
 *     `resolveTopLevelInputs` in utils/workflow-requirements.ts — from values supplied
 *     by the CLI's `--input name=value` or the run route's `inputs` map.
 *
 * They must agree — a map accepted by one and rejected by another would make the same
 * workflow behave differently depending on how it was called. This module is the single
 * implementation they all go through, so parity is structural rather than a comment
 * asking three files to stay in sync.
 *
 * Semantics (identical on every surface): a workflow that declares NO `inputs:` keeps
 * Phase-1 passthrough (the caller's map is forwarded verbatim). One that declares
 * `inputs:` applies each spec's `default` for an omitted name, rejects an unsupplied
 * `required` input, and rejects a caller key the workflow does not declare.
 */
import type { WorkflowDefinition } from './schemas/workflow';
import { INPUT_NAME_PATTERN } from './schemas/dag-node';

/** A workflow's declared `inputs:` block, or undefined when it declares none. */
export type DeclaredInputs = WorkflowDefinition['inputs'];

/**
 * Thrown when a caller's supplied map violates the callee's declared contract.
 *
 * `undeclared` and `missingRequired` carry the offending names as data so a caller can
 * re-shape the remediation for its own surface — a direct run must say
 * `--input name=value`, not "pass it through `with:`" — without parsing the message
 * string. Exactly one is non-empty for a contract violation; both are empty for the
 * grammar errors raised by {@link parseInputAssignments}.
 */
export class WorkflowInputContractError extends Error {
  readonly undeclared: readonly string[];
  readonly missingRequired: readonly string[];

  constructor(
    message: string,
    details?: { undeclared?: readonly string[]; missingRequired?: readonly string[] }
  ) {
    super(message);
    this.name = 'WorkflowInputContractError';
    this.undeclared = details?.undeclared ?? [];
    this.missingRequired = details?.missingRequired ?? [];
  }
}

/** Render `'a', 'b'` for an error message, sorted for a deterministic string. */
function quoteNames(names: string[]): string {
  return names
    .slice()
    .sort()
    .map(n => `'${n}'`)
    .join(', ');
}

/**
 * Resolve a caller's supplied map against a callee's declared `inputs:`.
 *
 * @param supplied - the caller's `with:` values, already substituted to concrete strings.
 * @param declared - the callee's `inputs:` block (undefined ⇒ Phase-1 passthrough).
 * @param context - message prefix identifying the call site, e.g. `Node 'review'`.
 * @param calleeLabel - how the callee is named in errors, e.g. `included block 'blk'`.
 * @throws WorkflowInputContractError on an undeclared key or a missing required input.
 */
export function resolveDeclaredInputs(
  supplied: Record<string, string>,
  declared: DeclaredInputs,
  context: string,
  calleeLabel: string
): Record<string, string> {
  if (declared === undefined) return supplied;

  // Reject caller keys the callee does not declare. Checked before defaults so a typo
  // ('stlye' for 'style') fails loudly instead of silently taking the default.
  const undeclared = Object.keys(supplied).filter(k => !Object.hasOwn(declared, k));
  if (undeclared.length > 0) {
    throw new WorkflowInputContractError(
      `${context}: ${calleeLabel} does not declare input${undeclared.length === 1 ? '' : 's'} ${quoteNames(undeclared)}. Declared inputs: ${Object.keys(declared).sort().join(', ') || '(none)'}.`,
      { undeclared }
    );
  }

  const resolved: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (Object.hasOwn(supplied, name)) {
      resolved[name] = supplied[name];
    } else if (spec.default !== undefined) {
      resolved[name] = spec.default;
    } else if (spec.required === true) {
      missingRequired.push(name);
    }
    // Declared, not supplied, not required, no default: omitted. A body that references
    // `$INPUTS.<name>` fails at the reference site rather than here.
  }
  if (missingRequired.length > 0) {
    throw new WorkflowInputContractError(
      `${context}: ${calleeLabel} requires input${missingRequired.length === 1 ? '' : 's'} ${quoteNames(missingRequired)}. Pass ${missingRequired.length === 1 ? 'it' : 'them'} through 'with:'.`,
      { missingRequired }
    );
  }
  return resolved;
}

/**
 * Declared inputs that a run carries with no caller at all — the defaults of a workflow
 * started directly (CLI / chat / web), which has no parent to stamp `metadata.inputs`.
 *
 * Without this a top-level run of a workflow whose `inputs:` are all defaulted would throw
 * on its own `$INPUTS.<name>` references, while the identical workflow invoked as a
 * `workflow:` child would resolve them. Required inputs are NOT synthesized here: a bare
 * run supplies nothing, so the reference fails at its use site with the normal message.
 */
export function defaultRunInputs(declared: DeclaredInputs): Record<string, string> | undefined {
  if (declared === undefined) return undefined;
  const defaults: Record<string, string> = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (spec.default !== undefined) defaults[name] = spec.default;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/**
 * Parse `name=value` assignments into a supplied-input map (#2554) — the grammar the
 * CLI's repeatable `--input` flag speaks, kept here so every surface that ever accepts
 * a textual assignment speaks exactly the same one.
 *
 * The split is on the FIRST `=` only: the value is the literal remainder, so
 * `msg=a=b` yields `a=b`. An empty value (`name=`) is a legitimate empty string. A
 * duplicate name is rejected rather than silently last-wins — a repeated assignment is
 * far more likely a mistake than an intent, and quietly picking one is the kind of
 * behaviour the fail-fast rule exists to prevent.
 *
 * Names are validated against the shared {@link INPUT_NAME_PATTERN} rather than a local
 * copy of the grammar; that constant's docblock explains why a second copy drifts
 * silently in the dangerous direction.
 *
 * @throws WorkflowInputContractError on a missing `=`, an invalid name, or a duplicate.
 */
export function parseInputAssignments(assignments: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf('=');
    if (eq === -1) {
      throw new WorkflowInputContractError(
        `Invalid input assignment '${assignment}': expected 'name=value'.`
      );
    }
    const name = assignment.slice(0, eq);
    if (!INPUT_NAME_PATTERN.test(name)) {
      // Names the offending NAME, never the whole assignment — the value after `=` is
      // user content (often a secret) and the name alone identifies which flag to fix.
      throw new WorkflowInputContractError(
        `Invalid input name '${name}': a name must start with a letter or ` +
          'underscore and contain only letters, digits, underscores, and hyphens.'
      );
    }
    if (Object.hasOwn(parsed, name)) {
      throw new WorkflowInputContractError(
        `Duplicate input '${name}': supply each input at most once.`
      );
    }
    parsed[name] = assignment.slice(eq + 1);
  }
  return parsed;
}
