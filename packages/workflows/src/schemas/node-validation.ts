/**
 * The superRefine half of `dagNodeSchema` once a node has selected exactly one mode:
 * one check per mode for the fields only that mode reads, then the checks every mode
 * shares. Mode selection itself, and its errors, stay in dag-node.ts beside the mode table.
 */
import { z } from 'zod';
import { isValidCommandName } from '../command-validation';
import {
  declaredFieldsFromSchema,
  outputFieldConstraints,
  jsonValueSchema,
  parseWholeOutputRef,
} from '../output-ref';
import type { DagNodeFields, NodeMode } from './dag-node';
import { bashExecAuthoringSchema, execNodeSchema, scriptExecAuthoringSchema } from './exec-node';
import { composeFanOutNodeSchema } from './include-node';
import { bindingDirectiveSchema, INPUT_NAME_PATTERN, inputEnvKey } from './node-bindings';
import { loopRetryConfigSchema, stepRetryConfigSchema } from './retry';

type NodeIssue = { message: string; path?: readonly PropertyKey[] };
type ModeValidator = (data: DagNodeFields, ctx: z.RefinementCtx) => void;

export function addIssue(
  ctx: z.RefinementCtx,
  message: string,
  path?: readonly PropertyKey[]
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    ...(path !== undefined ? { path: [...path] } : {}),
  });
}

export function addIssues(ctx: z.RefinementCtx, issues: readonly NodeIssue[]): void {
  for (const issue of issues) addIssue(ctx, issue.message, issue.path);
}

export function validateSelectedMode(
  data: DagNodeFields,
  mode: NodeMode,
  ctx: z.RefinementCtx
): void {
  MODE_VALIDATORS[mode]?.(data, ctx);
  validateRetry(data, mode, ctx);
  const idleTimeout = data.idle_timeout;
  if (idleTimeout !== undefined && (idleTimeout <= 0 || !isFinite(idleTimeout))) {
    addIssue(ctx, "'idle_timeout' must be a finite positive number (ms)", ['idle_timeout']);
  }
}

function validateRetry(data: DagNodeFields, mode: NodeMode, ctx: z.RefinementCtx): void {
  if (data.retry === undefined) return;
  const retrySchema = mode === 'loop' ? loopRetryConfigSchema : stepRetryConfigSchema;
  const result = retrySchema.safeParse(data.retry);
  if (result.success) return;
  addIssues(
    ctx,
    result.error.issues.map(issue => ({ message: issue.message, path: ['retry', ...issue.path] }))
  );
}

/** Checks that need the selected mode's own fields, or that apply only to that mode. */
const MODE_VALIDATORS: Partial<Record<NodeMode, ModeValidator>> = {
  command: validateCommandNode,
  bash: validateBashNode,
  script: validateScriptNode,
  loop: validateLoopNode,
  loop_group: validateLoopGroupNode,
  approval: validateApprovalNode,
  wait: validateWaitNode,
  include: validateIncludeNode,
  workflow: validateWorkflowNode,
};

function validateCommandNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (data.with !== undefined) validateBindings('command', data.with, ctx);
  const command = (data.command ?? '').trim();
  if (!isValidCommandName(command)) {
    addIssue(ctx, `invalid command name "${command}"`, ['command']);
  }
}

function validateBashNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const authoring = bashExecAuthoringSchema.partial().safeParse(data);
  if (!authoring.success) addIssues(ctx, authoring.error.issues);
}

function validateScriptNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const authoring = scriptExecAuthoringSchema.partial().safeParse(data);
  if (!authoring.success) {
    addIssues(ctx, authoring.error.issues.map(scriptAuthoringIssue));
  } else if (authoring.data.with !== undefined) {
    // Shape, input-name, and JSON-value checks run as on a command node. Skipping them
    // here would accept a script `with:` key that command rejects.
    validateBindings('script', data.with, ctx);
  }
  if (data.runtime === undefined) {
    addIssue(ctx, "'runtime' is required for script nodes ('bun' or 'uv')", ['runtime']);
  }
}

function scriptAuthoringIssue(issue: z.core.$ZodIssue): NodeIssue {
  if (issue.path[0] !== 'with') return issue;
  const key = issue.path.at(1);
  return {
    message:
      typeof key === 'string'
        ? `script input '${key}' must be a JSON-compatible value (string, number, boolean, null, array, or object)`
        : "'with' on script nodes must be an object mapping input names to values",
    path: ['with'],
  };
}

function validateLoopNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  validateLoopUntilField(data, ctx);
  validateLoopTimeout(data, ctx);
}

function validateLoopGroupNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  // The loop_group manages its own iteration.
  if (data.retry !== undefined) {
    addIssue(
      ctx,
      "'retry' is not supported on loop_group nodes (loop_group manages its own iteration)",
      ['retry']
    );
  }
  validateLoopTimeout(data, ctx);
}

/**
 * Loop predicates are subprocesses, so a selected loop timeout has the same
 * positive, finite contract as an exec timeout.
 */
function validateLoopTimeout(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (data.timeout === undefined) return;
  const result = execNodeSchema.pick({ timeout: true }).safeParse(data);
  if (!result.success) addIssues(ctx, result.error.issues);
}

/**
 * `loop.until_field` <-> `output_format` (#2563). These live here rather than on
 * loopNodeConfigSchema because only this level can see BOTH the loop config and
 * the node's `output_format`.
 *
 * All four rules are load-time reads of data the author already wrote, and each
 * converts a silent non-termination into a load error. Without `required`, a
 * schema-valid payload may omit the property, and "absent" would mean "not
 * complete" — a model that never emits it would burn max_iterations and then
 * fail reporting the wrong cause. Without the boolean constraint,
 * `until_field: status` over a string invites truthiness semantics the engine
 * deliberately does not have (it terminates on `=== true`, nothing else).
 */
function validateLoopUntilField(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const untilField = data.loop?.until_field;
  if (untilField === undefined) return;
  const path = ['loop', 'until_field'];
  const schema = data.output_format;
  if (schema === undefined) {
    addIssue(
      ctx,
      `'loop.until_field' names '${untilField}' but this node declares no 'output_format' — the field must be a declared property of the node's schema`,
      path
    );
    return;
  }
  const declared = declaredFieldsFromSchema(schema);
  if (!declared?.includes(untilField)) {
    addIssue(
      ctx,
      `'loop.until_field' names '${untilField}', which is not declared in this node's output_format properties${declared && declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}`,
      path
    );
    return;
  }
  const constraints = outputFieldConstraints(schema, untilField);
  if (!constraints.required) {
    addIssue(
      ctx,
      `'loop.until_field' names '${untilField}', which must also be listed in output_format.required — an optional field the model omits would silently read as "not complete" and burn max_iterations`,
      path
    );
  }
  if (!constraints.boolean && constraints.hasNonBooleanType) {
    addIssue(
      ctx,
      `'loop.until_field' names '${untilField}', declares a non-boolean type — it must be 'boolean'; the loop terminates on the value being exactly true`,
      path
    );
  }
}

/**
 * 'decisions' (#2707 step 1, the new authoring surface) and 'on_reject' (the
 * deprecated legacy mechanism) are mutually exclusive: mixing them would
 * leave it ambiguous which mechanism resolves the gate. Validated here
 * rather than via a superRefine on approvalConfigSchema itself, which would
 * wrap it in a ZodEffects and erase the precise `.shape` KNOWN_NODE_NESTED_KEYS
 * relies on for compile-time-checked child keys (see approvalConfigSchema's doc).
 */
function validateApprovalNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const decisions = data.approval?.decisions;
  if (decisions === undefined) return;
  const path = ['approval', 'decisions'];
  if (data.approval?.on_reject !== undefined) {
    addIssue(
      ctx,
      "'approval.decisions' and 'approval.on_reject' are mutually exclusive. " +
        "'on_reject' is deprecated — wire a rework node with a " +
        "\"when: \\\"$<this gate's id>.output.decision == 'reject'\\\"\" edge and declare 'decisions' instead.",
      path
    );
    return;
  }
  const ids = decisions.map(d => d.id);
  if (new Set(ids).size !== ids.length) {
    addIssue(ctx, "'approval.decisions' ids must be unique", path);
  }
}

function validateWaitNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (data.output_format !== undefined) {
    addIssue(ctx, "'output_format' is fixed by wait nodes and cannot be overridden", [
      'output_format',
    ]);
  }
  if (data.retry !== undefined) {
    addIssue(
      ctx,
      "'retry' is not supported on wait nodes; the persisted condition governs continuation",
      ['retry']
    );
  }
  if (data.always_run !== undefined) {
    addIssue(ctx, "'always_run' is not supported on wait nodes", ['always_run']);
  }
}

function validateIncludeNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (data.with !== undefined) validateWithShape('include', data.with, ctx);
  if (data.fan_out !== undefined) {
    const result = composeFanOutNodeSchema.pick({ fan_out: true }).safeParse(data);
    if (!result.success) addIssues(ctx, result.error.issues);
  }
  validateComposedFanOut(data, ctx);
}

function validateWorkflowNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (data.with !== undefined) validateWithShape('workflow', data.with, ctx);
  // A `workflow:` node has ONE input channel per invocation: either the untyped
  // `input:` string ($ARGUMENTS) or the named `with:` map ($INPUTS.<name>). Accepting
  // both would require a precedence rule between two overlapping channels — the exact
  // ambiguity the constitution's smell #5 warns against — so reject them together.
  if (data.with !== undefined && data.input !== undefined) {
    addIssue(
      ctx,
      "'with:' and 'input:' cannot both be set on a workflow node — 'with:' supplies named $INPUTS, 'input:' supplies the child's $ARGUMENTS. Use one.",
      ['with']
    );
  }
  // 'retry:' on a workflow node would spawn a NEW child run and orphan the first —
  // recovery is resume-through-parent, not retry (#1764). Reject fail-fast.
  if (data.retry !== undefined) {
    addIssue(
      ctx,
      "'retry' is not supported on workflow nodes (a retry would orphan the first child run — resume through the parent instead)",
      ['retry']
    );
  }
  validateComposedFanOut(data, ctx);
}

function validateComposedFanOut(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const fanOut = data.fan_out;
  if (fanOut === undefined) return;
  // `first_success` racing is REJECTED, not deferred — the earlier deferral is dead. A
  // winner aborting and cancelling its losers is one child's outcome ending its siblings',
  // which the independence rule forbids, and racing without terminating the losers is not
  // racing. So there is no PR to wait for and the message must not imply one.
  //
  // The enum value stays even though its original "so the eventual PR only lifts a guard"
  // justification is gone. A better one replaces it: an author whose YAML already says
  // `first_success` gets a message naming the rejection and the shape that serves the want,
  // instead of an opaque unrecognised-enum-value error. Do not remove it as dead weight.
  if (fanOut.join === 'first_success') {
    addIssue(
      ctx,
      "'fan_out.join: first_success' (racing) is rejected, not deferred: a winner cancels " +
        "the losers, which couples children that are meant to be independent. Use 'all_done' " +
        '(the default). For several genuinely different attempts, write them as separate ' +
        'nodes with their own models feeding one collector node — every attempt is kept and ' +
        'nothing is cancelled.',
      ['fan_out', 'join']
    );
  }
  const as = fanOut.as;
  if (as === undefined) return;
  if (!INPUT_NAME_PATTERN.test(as)) {
    addIssue(
      ctx,
      `invalid fan-out input name '${as}'; use letters, numbers, underscores, or hyphens and start with a letter or underscore`,
      ['fan_out', 'as']
    );
  }
  // `fan_out.as` names the per-item value as `$INPUTS.<as>` inside each child (#2470).
  // The only rejection is a COLLISION with a `with:` key, since both would populate the
  // same `$INPUTS.<name>` slot on the child with a precedence rule between them — the
  // same two-channels-one-name ambiguity the workflow node's `with:`+`input:` guard rejects.
  if (
    typeof data.with === 'object' &&
    data.with !== null &&
    !Array.isArray(data.with) &&
    Object.prototype.hasOwnProperty.call(data.with, as)
  ) {
    addIssue(
      ctx,
      `'fan_out.as: ${as}' collides with a 'with:' key of the same name — both would populate $INPUTS.${as}. Rename one.`,
      ['fan_out', 'as']
    );
  }
}

/**
 * `with:` is an identifier-keyed JSON-value map on include and workflow nodes
 * (#2470, values widened from string-only in #2637). For includes it inlines at
 * load time (applyInputsMacro); for sub-runs it becomes `$INPUTS.<name>` runtime
 * variables on the child. Returns the map when its shape is an object.
 */
function validateWithShape(
  kind: 'include' | 'workflow' | 'command' | 'script',
  value: unknown,
  ctx: z.RefinementCtx
): Record<string, unknown> | undefined {
  const prototype =
    typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    addIssue(ctx, `'with' on ${kind} nodes must be an object mapping input names to values`, [
      'with',
    ]);
    return undefined;
  }
  const map = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(map)) {
    if (!INPUT_NAME_PATTERN.test(key)) {
      addIssue(
        ctx,
        `invalid ${kind} input name '${key}'; use letters, numbers, underscores, or hyphens and start with a letter or underscore`,
        ['with']
      );
    }
    if (!jsonValueSchema.safeParse(entry).success) {
      addIssue(
        ctx,
        `${kind} input '${key}' must be a JSON-compatible value (string, number, boolean, null, array, or object)`,
        ['with']
      );
    }
  }
  return map;
}

/**
 * Node-local bindings on command/script nodes (#2637): same key/value grammar as
 * include/workflow `with:`, plus the object position is RESERVED for the binding
 * directive — any other object shape is rejected naming both accepted forms.
 */
function validateBindings(kind: 'command' | 'script', value: unknown, ctx: z.RefinementCtx): void {
  const map = validateWithShape(kind, value, ctx);
  if (map === undefined) return;
  validateBindingEnvKeys(kind, map, ctx);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      validateBindingDirective(kind, key, entry, ctx);
    }
  }
}

/**
 * Two names folding to one INPUTS_<UPPER_SNAKE> env key would silently clobber
 * each other on script env delivery — same rule the loader enforces for a
 * workflow's declared `inputs:` block, applied here where the map is visible.
 * Scoped to this NEW surface only: include/workflow `with:` maps predate the
 * check and must keep loading (their callee's own `inputs:` block carries it).
 */
function validateBindingEnvKeys(
  kind: 'command' | 'script',
  map: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  const envKeyOwners = new Map<string, string>();
  for (const key of Object.keys(map)) {
    const envKey = inputEnvKey(key);
    const existing = envKeyOwners.get(envKey);
    if (existing !== undefined) {
      addIssue(
        ctx,
        `${kind} bindings '${existing}' and '${key}' both map to env var '${envKey}' — rename one so each binding has a unique env key`,
        ['with']
      );
    }
    envKeyOwners.set(envKey, key);
  }
}

function validateBindingDirective(
  kind: 'command' | 'script',
  key: string,
  value: object,
  ctx: z.RefinementCtx
): void {
  const parsed = bindingDirectiveSchema.safeParse(value);
  if (!parsed.success) {
    addIssue(
      ctx,
      `${kind} binding '${key}': an object value must be a binding directive ` +
        "{ from: '$node.output[.a.b]', if_skipped?: <value> } — " +
        `${parsed.error.issues[0]?.message ?? 'invalid shape'}. ` +
        'Use a string, number, boolean, null, or array for a literal value.',
      ['with', key]
    );
    return;
  }
  const from = parsed.data.from;
  if (parseWholeOutputRef(from) !== undefined) return;
  // $LOOP_PREV is a per-iteration TEXT substitution, not a node ref — a
  // directive's `from` must stay a ref so `if_skipped` has a producer to
  // check. Name the supported spelling instead of the generic grammar error.
  const message = from.trim().startsWith('$LOOP_PREV')
    ? `${kind} binding '${key}': 'from' cannot read '$LOOP_PREV' — it is not a node reference. Use the string form (e.g. '${key}: ${from.trim()}'), which substitutes the previous iteration's text each pass.`
    : `${kind} binding '${key}': 'from' must be exactly one whole '$node.output[.a.b]' reference, got '${from}'`;
  addIssue(ctx, message, ['with', key]);
}
