/**
 * The declared-input contract (#2470), shared by both call surfaces.
 *
 * A workflow's `inputs:` block is one contract with two callers:
 *   - `include:` resolves it at LOAD time (include-expander.ts), splicing values into
 *     `$INPUTS.<name>` before the DAG is ever persisted;
 *   - `workflow:` resolves it at RUN time (executor.ts), persisting the resolved map to
 *     the child's `metadata.inputs`.
 *
 * They must agree — a `with:` map accepted by one and rejected by the other would make
 * the same block behave differently depending on how it was called. This module is the
 * single implementation both go through, so parity is structural rather than a comment
 * asking two files to stay in sync.
 *
 * Semantics (identical on both surfaces): a workflow that declares NO `inputs:` keeps
 * Phase-1 passthrough (the caller's map is forwarded verbatim). One that declares
 * `inputs:` applies each spec's `default` for an omitted name, rejects an unsupplied
 * `required` input, and rejects a caller key the workflow does not declare.
 */
import type { WorkflowDefinition } from './schemas/workflow';

/** A workflow's declared `inputs:` block, or undefined when it declares none. */
export type DeclaredInputs = WorkflowDefinition['inputs'];

/** Thrown when a caller's `with:` map violates the callee's declared contract. */
export class WorkflowInputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowInputContractError';
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
      `${context}: ${calleeLabel} does not declare input${undeclared.length === 1 ? '' : 's'} ${quoteNames(undeclared)}. Declared inputs: ${Object.keys(declared).sort().join(', ') || '(none)'}.`
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
      `${context}: ${calleeLabel} requires input${missingRequired.length === 1 ? '' : 's'} ${quoteNames(missingRequired)}. Pass ${missingRequired.length === 1 ? 'it' : 'them'} through 'with:'.`
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
