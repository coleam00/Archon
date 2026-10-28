import {
  type WorkflowRun,
  type NodeOutput,
  type DagNode,
  type BindingDirective,
  readSubrunMetadata,
  inputEnvKey,
  isExecNode,
  isBindingDirective,
} from '../schemas';
import {
  type JsonValue,
  type TemplateToken,
  canonicalValueText,
  assertProducerNotFailed,
  resolveNodeOutputField,
  parseWholeInputsRef,
  similarNodeIds,
  parseWholeOutputRef,
  OutputRefError,
  parseWholeExecutionCheckoutRef,
  resolveExecutionCheckoutStart,
  templateToken,
  CURRENT_OUTPUT_PATH_SOURCE,
  assertSupportedOutputRefs,
  substituteTemplate,
  inputRefToken,
  resolveInputValue,
} from '../output-ref';
import { readComposedMeta } from '../compiled-command';
import { type ExecNodeEnvironmentContext, buildExecNodeEnvironment } from '../exec-environment';
import { substituteWorkflowVariables, type TemplateReferences } from '../workflow-variables';
import { type AttentionOption, attentionOptionsSchema } from '../schemas/wait-node';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';
import { type LoopBodyScope, loopScopeTokens, substituteLoopBodyText } from './loop-scope';
import { shellQuoteOrFile } from './shell-quote';

/**
 * Resolve this run's named inputs (#2470) from persisted sub-run metadata. Non-empty
 * only for `workflow:` sub-run children (the parent stamps `metadata.inputs` at spawn);
 * a top-level run has none. Threaded into every AI/prompt substitution so `$INPUTS.<name>`
 * resolves, and mangled to `INPUTS_<UPPER_SNAKE>` env vars for bash/script nodes.
 * Values are logical JSON values (#2637): `readSubrunMetadata` prefers the
 * `inputs_values` sibling key and degrades to the legacy text map.
 */
export function resolveRunInputs(
  workflowRun: Pick<WorkflowRun, 'metadata'>
): Record<string, JsonValue> | undefined {
  return readSubrunMetadata(workflowRun.metadata as Record<string, unknown> | undefined).inputs;
}

/**
 * Everything resolving a composed input value needs; the caller has all of it in scope.
 * `workflowRun` is a Pick so the dry-run simulator — which has no WorkflowRun row —
 * can construct one for {@link resolveNodeBindings} (#2637); executor callers pass
 * their full run unchanged.
 */
export interface ShellInputContext {
  workflowRun: Pick<WorkflowRun, 'id' | 'user_message' | 'metadata'>;
  artifactsDir: string;
  stateDir: string;
  baseBranch: string;
  docsDir: string;
  issueContext?: string;
  nodeOutputs: Map<string, NodeOutput>;
  loopBodyScopes: readonly LoopBodyScope[];
}

/**
 * Env-var bag delivering named inputs to a node shell as `INPUTS_<UPPER_SNAKE>`.
 *
 * Sources, in precedence order:
 *   - the RUN's own inputs (#2470) — a `workflow:` sub-run child carries them in metadata.
 *   - the node's COMPOSED inputs (#1764) — the contract-resolved `inputs:` of the workflow
 *     this node was authored in, stamped at expansion when it arrived through `include:`.
 *     These win: a node's own file is the nearer contract. This bag is their only channel
 *     into a shell or script: the include `$INPUTS` macro rewrites a bash body to a quoted
 *     reference to it and refuses an inline script body (#2115).
 *   - node-local `with:` bindings on script nodes (#2637), the nearest contract.
 *
 * A composed value resolves like a `workflow:` node's `with:` template — workflow variables
 * (NOT shell-safe: these become env values, never shell source) and `$node.output` refs —
 * resolved here rather than at load because a value may hold
 * `$ARTIFACTS_DIR` or a ref that only exists at run time. Values are never shell-escaped:
 * the env bag is itself the injection-safe channel (#2115), which is why they never touch
 * the script source.
 *
 * `runInputs` is explicit for the same reason as in {@link resolveNodeBindings}: the
 * dry-run simulator builds the bag with this function and passes its effective input map,
 * so the preview cannot drift from the real run.
 */
export function inputEnvVars(
  node: DagNode,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined = resolveRunInputs(ctx.workflowRun)
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(runInputs ?? {})) {
    // Canonical text (#2637): env vars are text, so a typed input rides its one
    // deterministic representation (strings raw, everything else JSON text).
    env[inputEnvKey(name)] = canonicalValueText(value);
  }
  for (const [name, value] of Object.entries(readComposedMeta(node)?.inputs ?? {})) {
    // Only strings can carry templates/refs; a typed composed value passes as-is.
    env[inputEnvKey(name)] =
      typeof value === 'string'
        ? resolveValueTemplate(value, ctx, runInputs)
        : canonicalValueText(value);
  }
  // Node-local bindings (#2637) — a script node's own `with:` map, resolved against
  // upstream outputs. Third and NEAREST source: the node's own file is the nearest
  // contract, so it wins over composed and run inputs (extends the documented order
  // above). Resolution failures throw and fail the node — never a silent ''.
  if (isExecNode(node) && node.runtime !== 'sh' && node.with !== undefined) {
    for (const [name, value] of Object.entries(
      resolveNodeBindings(node.id, node.with, ctx, runInputs)
    )) {
      env[inputEnvKey(name)] = canonicalValueText(value);
    }
  }
  return env;
}

/** Project env cannot shadow inputs or engine-owned delivery keys (#2115). */
export function buildNodeShellEnvironment(
  node: DagNode,
  ctx: ShellInputContext,
  envVars: NodeJS.ProcessEnv | undefined,
  executionContext: Omit<ExecNodeEnvironmentContext, 'inputEnvKeys'>
): NodeJS.ProcessEnv {
  const inputs = inputEnvVars(node, ctx);
  return {
    ...envVars,
    ...inputs,
    ...buildExecNodeEnvironment({ ...executionContext, inputEnvKeys: Object.keys(inputs) }),
  };
}

/**
 * The logical value of one whole `$node.output[.field]` reference (#2637): the
 * producer's parsed structured payload when it has one (else its output text) for
 * the unfielded form, and the raw field value under the strict no-silent-drop
 * contract for the fielded form (declared-optional-absent → '').
 *
 * A failed producer never resolves here, fielded or not (#2713): `resolveBindingDirective`
 * already guards its own call below before reaching this function, so the check below only
 * ever fires for this function's OTHER caller, `resolveWorkflowValue`'s whole-ref tier — the
 * plain (non-directive) `with:` value on a script/command node, a `workflow:` node's `with:`,
 * or `fan_out`'s static `with:`, none of which had #2710's guard. Routes through
 * `assertProducerNotFailed` in output-ref.ts (#2722), which every other whole-text reader
 * of `nodeOutputs` shares.
 */
export function wholeRefLogicalValue(
  producer: NodeOutput,
  nodeId: string,
  field: string | undefined,
  reference: string
): JsonValue {
  if (field === undefined) {
    assertProducerNotFailed(
      producer,
      failed =>
        `Binding value '$${nodeId}.output' references node '${nodeId}', but it failed ` +
        `(${failed.error}), so its output cannot be trusted. Fix the failure, or guard ` +
        "the referencing node with a 'when:' condition that excludes the failed branch."
    );
    const structured = 'structuredOutput' in producer ? producer.structuredOutput : undefined;
    // Provider payloads are ajv-validated / DB-round-tripped JSON, so the cast
    // asserts what production already guarantees.
    return structured !== undefined ? (structured as JsonValue) : producer.output;
  }
  // A failed producer's fielded form is rejected inside resolveNodeOutputField itself
  // (#2713) — the same 'producer-failed' guard as the unfielded branch above.
  const resolution = resolveNodeOutputField(producer, nodeId, field, reference);
  return resolution.kind === 'empty' ? '' : (resolution.value as JsonValue);
}

/**
 * Resolve one `with:` value to its logical JSON value (#2637).
 *
 * Three tiers, in order:
 *  - a non-string literal (boolean/number/null/array/object) passes through as-is;
 *  - a string that is EXACTLY one whole `$INPUTS.<name>` or `$node.output[.field]`
 *    reference resolves to the LOGICAL value (type preserved);
 *  - any other string is a template: text substitution (workflow vars and
 *    `$node.output` refs), exactly as `input:` resolves.
 *
 * `strictWholeRef` selects the unknown-producer posture for the unfielded whole-ref
 * form: node-local bindings are a new surface and FAIL (with a did-you-mean hint);
 * `workflow:`/fan-out `with:` values keep the template path's historical lenient ''
 * so pre-#2637 workflows resolve byte-identically. Fielded refs fail everywhere.
 */
export function resolveWorkflowValue(
  rawValue: JsonValue,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined,
  strictWholeRef: boolean
): JsonValue {
  if (typeof rawValue !== 'string') return rawValue;
  const inputsName = parseWholeInputsRef(rawValue);
  if (inputsName !== undefined) return resolveInputValue(inputsName, runInputs);
  const wholeRef = parseWholeOutputRef(rawValue);
  if (wholeRef !== undefined) {
    const producer = ctx.nodeOutputs.get(wholeRef.nodeId);
    if (producer !== undefined) {
      return wholeRefLogicalValue(producer, wholeRef.nodeId, wholeRef.field, rawValue.trim());
    }
    if (wholeRef.field !== undefined) {
      throw new OutputRefError(wholeRef.nodeId, wholeRef.field, 'unknown-node', {
        reference: rawValue.trim(),
        candidates: similarNodeIds(wholeRef.nodeId, ctx.nodeOutputs.keys()),
      });
    }
    if (strictWholeRef) {
      const candidates = similarNodeIds(wholeRef.nodeId, ctx.nodeOutputs.keys());
      const hint =
        candidates.length > 0 ? ` Did you mean: ${candidates.map(c => `'${c}'`).join(', ')}?` : '';
      throw new Error(
        `Binding value '$${wholeRef.nodeId}.output' references node '${wholeRef.nodeId}', ` +
          'but no node with that id has produced output at this point — the id is either ' +
          'unknown (a typo) or belongs to a node that has not run before this reference.' +
          `${hint} Fix the id, or add '${wholeRef.nodeId}' to depends_on.`
      );
    }
    // Lenient legacy surface: fall through to the template path, which resolves the
    // unknown whole-text ref to '' with a warn — byte-identical to pre-#2637.
  }
  return resolveValueTemplate(rawValue, ctx, runInputs);
}

/**
 * Resolve a value template (a `with:` value, a composed input) to text: workflow variables
 * — never shell-safe, a value is delivered as data, not shell source — and `$node.output`
 * references, in one pass.
 */
export function resolveValueTemplate(
  template: string,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined
): string {
  return substituteWorkflowVariables(
    template,
    ctx.workflowRun.id,
    ctx.workflowRun.user_message,
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    undefined,
    undefined,
    undefined,
    {
      stateDir: ctx.stateDir,
      inputs: runInputs,
      references: nodeTemplateReferences(template, ctx),
    }
  ).prompt;
}

/**
 * Resolve a command/script node's node-local `with:` map (#2637) to logical values.
 *
 * A plain-object value is the explicit binding directive `{ from, if_skipped? }`:
 * `from` reads one whole upstream ref; a producer that did not run (skipped or
 * pending — reachable under `trigger_rule: all_done` across a skipped branch)
 * takes `if_skipped` instead, and without one the node fails with the fix named.
 * Everything else resolves through {@link resolveWorkflowValue} in strict mode.
 * The loader guarantees bound producers are upstream `depends_on`, so resolution
 * here is a per-node pre-step with no new scheduling.
 *
 * `runInputs` is explicit (not derived from ctx) so the dry-run simulator can pass
 * its effective input map — its synthetic context carries no run metadata. Exported
 * for that simulator only; it must resolve bindings with THIS function so preview
 * and execution cannot drift (#2637 R2).
 */
export function resolveNodeBindings(
  consumerId: string,
  withMap: Record<string, JsonValue | BindingDirective>,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {};
  for (const [name, rawValue] of Object.entries(withMap)) {
    if (isBindingDirective(rawValue)) {
      resolved[name] = resolveBindingDirective(consumerId, name, rawValue, ctx);
      continue;
    }
    if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
      // The loader rejects this shape at load time; programmatic definitions can
      // still reach here, so keep the failure loud and actionable.
      throw new Error(
        `Node '${consumerId}' binding '${name}': an object value must be a binding directive ` +
          "{ from: '$node.output[.field]', if_skipped?: <value> }. Use a string, number, " +
          'boolean, null, or array for a literal value.'
      );
    }
    const checkoutProducer =
      typeof rawValue === 'string' ? parseWholeExecutionCheckoutRef(rawValue) : undefined;
    resolved[name] =
      checkoutProducer !== undefined
        ? resolveExecutionCheckoutStart(ctx.nodeOutputs.get(checkoutProducer), checkoutProducer)
        : resolveWorkflowValue(rawValue, ctx, runInputs, true);
  }
  return resolved;
}

export function resolveBindingDirective(
  consumerId: string,
  name: string,
  directive: BindingDirective,
  ctx: ShellInputContext
): JsonValue {
  const ref = parseWholeOutputRef(directive.from);
  if (ref === undefined) {
    throw new Error(
      `Node '${consumerId}' binding '${name}': 'from' must be exactly one whole ` +
        `'$node.output' or '$node.output.field' reference, got '${directive.from}'.`
    );
  }
  const producer = ctx.nodeOutputs.get(ref.nodeId);
  if (producer === undefined || producer.state === 'skipped' || producer.state === 'pending') {
    // Presence-keyed: `if_skipped: null` (or false/0/'') is a real declared default.
    if (Object.hasOwn(directive, 'if_skipped')) {
      const fallback = directive.if_skipped as JsonValue;
      return typeof fallback === 'string'
        ? substituteLoopBodyText(fallback, ctx.loopBodyScopes)
        : fallback;
    }
    throw new Error(
      `Node '${consumerId}' binding '${name}' reads '${directive.from}', but node ` +
        `'${ref.nodeId}' did not run (skipped or pending), so it has no output to read. ` +
        "Declare 'if_skipped:' on the binding to supply a default for that branch, or " +
        `guard '${consumerId}' with a 'when:' condition.`
    );
  }
  // A failed producer never falls back to `if_skipped` (#2696): that default exists for
  // a branch that legitimately didn't run, not for a run that ran and produced a result
  // that can't be trusted (a loop_group's failure paths carry the last completed
  // iteration's real output text — non-empty, often valid JSON — which would otherwise
  // resolve here as if the group had succeeded). Routes through `assertProducerNotFailed`
  // in output-ref.ts (#2722, extending #2710's original guard to every whole-text reader
  // of nodeOutputs through one shared function).
  assertProducerNotFailed(
    producer,
    failed =>
      `Node '${consumerId}' binding '${name}' reads '${directive.from}', but node ` +
      `'${ref.nodeId}' failed (${failed.error}), so its output cannot be trusted. ` +
      "A binding never falls back to 'if_skipped' for a failed producer — fix the " +
      `failure, or guard '${consumerId}' with a 'when:' condition that excludes the ` +
      'failed branch.'
  );
  return wholeRefLogicalValue(producer, ref.nodeId, ref.field, directive.from.trim());
}

export interface RequiredOutputRefContext {
  consumerId: string;
  field: 'loop.until_bash' | 'loop_group.until_bash';
}

export function requiredOutputRefError(
  context: RequiredOutputRefContext,
  ref: string,
  detail: string
): Error {
  return new Error(
    `Node '${context.consumerId}' field '${context.field}' cannot resolve '${ref}': ${detail}`
  );
}

/**
 * The `$node_id.output[.field]` reference, resolved against `nodeOutputs`.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 * @param requiredContext - Makes unavailable whole-output refs fail with the owning
 *   decision surface named. Used by `until_bash`; other callers keep the legacy empty
 *   fallback. Field refs remain strict in either mode.
 */
export function nodeOutputRefToken(
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash: boolean,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): TemplateToken {
  return templateToken(CURRENT_OUTPUT_PATH_SOURCE, groups => {
    const [match, nodeId] = groups;
    // An optional group that did not match is undefined, whatever RegExpExecArray says.
    const field: string | undefined = groups[2];
    const nodeOutput = nodeOutputs.get(nodeId);
    if (!nodeOutput) {
      return missingNodeOutputRef(
        nodeOutputs,
        nodeId,
        field,
        match,
        escapedForBash,
        requiredContext
      );
    }
    if (!field) {
      return wholeNodeOutputRef(
        nodeOutput,
        nodeId,
        match,
        escapedForBash,
        artifactsDir,
        requiredContext
      );
    }
    return nodeOutputFieldRef(
      nodeOutput,
      nodeId,
      field,
      match,
      escapedForBash,
      artifactsDir,
      requiredContext
    );
  });
}

function missingNodeOutputRef(
  nodeOutputs: Map<string, NodeOutput>,
  nodeId: string,
  field: string | undefined,
  match: string,
  escapedForBash: boolean,
  requiredContext?: RequiredOutputRefContext
): string {
  // A `.field` ref that resolves to no output (for example, a programmatically
  // constructed definition that bypassed discovery, or a real producer whose
  // output is unavailable on this execution path) fails the consuming node loudly,
  // matching the strict
  // no-silent-drop posture for known-producer field access below. The whole-text
  // `$id.output` form stays lenient ('') by default as a long-documented surface.
  // `until_bash` opts into requiredContext because empty text would become an
  // input to a completion decision rather than merely missing display text.
  if (field) {
    const error = new OutputRefError(nodeId, field, 'unknown-node', {
      reference: match,
      candidates: similarNodeIds(nodeId, nodeOutputs.keys()),
    });
    throw requiredContext ? requiredOutputRefError(requiredContext, match, error.message) : error;
  }
  if (requiredContext) {
    const candidates = similarNodeIds(nodeId, nodeOutputs.keys());
    const hint =
      candidates.length > 0
        ? ` Did you mean: ${candidates.map(candidate => `'${candidate}'`).join(', ')}?`
        : '';
    throw requiredOutputRefError(
      requiredContext,
      match,
      `node '${nodeId}' has not produced output at this point.${hint} Fix the id, or ensure '${nodeId}' runs before this check.`
    );
  }
  getLog().warn({ nodeId, match }, 'dag_node_output_ref_unknown_node');
  return escapedForBash ? "''" : '';
}

function wholeNodeOutputRef(
  nodeOutput: NodeOutput,
  nodeId: string,
  match: string,
  escapedForBash: boolean,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): string {
  if (requiredContext && (nodeOutput.state === 'skipped' || nodeOutput.state === 'pending')) {
    throw requiredOutputRefError(
      requiredContext,
      match,
      `node '${nodeId}' did not run (skipped or pending), so it has no output to read. Fix the dependency or guard the consuming loop.`
    );
  }
  if (requiredContext && nodeOutput.state === 'failed') {
    throw requiredOutputRefError(
      requiredContext,
      match,
      `node '${nodeId}' failed (${nodeOutput.error}), so its output cannot be trusted. Fix the failure or guard the consuming loop.`
    );
  }
  // A failed producer's stale output is never spliced into a consumer's own
  // prompt/bash/command body (#2713) — matches resolveBindingDirective's #2710
  // guard for the same class of bug (a loop_group's failure paths leave real,
  // last-completed-iteration text behind). Routes through `assertProducerNotFailed`
  // in output-ref.ts (#2722), which every whole-text reader of nodeOutputs shares.
  assertProducerNotFailed(
    nodeOutput,
    failed =>
      `'$${nodeId}.output' references node '${nodeId}', but it failed ` +
      `(${failed.error}), so its output cannot be spliced into this node's ` +
      "prompt/script — a failed producer's stale output is never trusted. Fix the " +
      "failure, or guard this node with a 'when:' condition that excludes the " +
      'failed branch.'
  );
  return escapedForBash
    ? shellQuoteOrFile(nodeOutput.output, nodeId, undefined, artifactsDir)
    : nodeOutput.output;
}

function nodeOutputFieldRef(
  nodeOutput: NodeOutput,
  nodeId: string,
  field: string,
  match: string,
  escapedForBash: boolean,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): string {
  // No-silent-drop field access (resolveNodeOutputField): prefers the parsed
  // structuredOutput payload, falls back to parsing `output`, and THROWS an
  // OutputRefError for an unresolvable reference (field not in the producer's
  // declared schema, or a schemaless node whose output isn't JSON / lacks the
  // key). The throw propagates to runLayers' per-node catch → the
  // consuming node fails visibly instead of receiving a poisoned ''. The only
  // value that resolves to empty is an author-declared-optional field.
  let resolution: ReturnType<typeof resolveNodeOutputField>;
  try {
    resolution = resolveNodeOutputField(nodeOutput, nodeId, field, match);
  } catch (error) {
    if (requiredContext && error instanceof OutputRefError) {
      throw requiredOutputRefError(requiredContext, match, error.message);
    }
    throw error;
  }
  if (resolution.kind === 'empty') return escapedForBash ? "''" : '';
  const value = resolution.value;
  // numbers and booleans are shell-safe without quoting: JSON disallows
  // NaN/Infinity so String(number) is digits/sign/'.', and String(boolean) is
  // 'true'/'false' — no shell metacharacters.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Everything else takes the one value→text rule (strings raw; arrays/objects/
  // null as canonical JSON so downstream tools like jq get one JSON literal),
  // with the bash-escaping decision staying here at the call site.
  const text = canonicalValueText(value);
  return escapedForBash ? shellQuoteOrFile(text, nodeId, field, artifactsDir) : text;
}

/** What a node's template resolves against besides its workflow variables. */
export interface TemplateSources {
  nodeOutputs: Map<string, NodeOutput>;
  /** One per enclosing loop_group iteration, outermost first; empty outside a body. */
  loopBodyScopes: readonly LoopBodyScope[];
}

/**
 * How a template's resolved values are embedded: `prompt` raw; `shell` shell-quoted, for
 * bash bodies and `until_bash`; `script` raw, with user-controlled free text left to env
 * delivery (#2115).
 */
export type TextSurface = 'prompt' | 'shell' | 'script';

/**
 * The reference grammars a node's own template resolves in the same pass as its workflow
 * variables (#4046): every enclosing loop_group scope, outermost first, then `$node.output`.
 * Unsupported output paths are rejected on the template itself, never on a value
 * substituted into it.
 */
export function nodeTemplateReferences(
  template: string,
  sources: TemplateSources,
  surface: TextSurface = 'prompt',
  options: { artifactsDir?: string; requiredContext?: RequiredOutputRefContext } = {}
): TemplateReferences {
  assertSupportedOutputRefs(template);
  return {
    before: sources.loopBodyScopes.flatMap(scope => loopScopeTokens(scope, surface)),
    after: [
      nodeOutputRefToken(
        sources.nodeOutputs,
        surface === 'shell',
        options.artifactsDir,
        options.requiredContext
      ),
    ],
  };
}

/**
 * Substitute $node_id.output and $node_id.output.field references, and the enclosing
 * loop_group scopes' references, in text that carries no workflow variables (a gate
 * message, a cancel reason, a wait timestamp). See {@link nodeOutputRefToken}.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  loopBodyScopes: readonly LoopBodyScope[],
  escapedForBash = false,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): string {
  const { before, after } = nodeTemplateReferences(
    prompt,
    { nodeOutputs, loopBodyScopes },
    escapedForBash ? 'shell' : 'prompt',
    { artifactsDir, requiredContext }
  );
  return substituteTemplate(prompt, [...before, ...after]);
}

/**
 * Substitute an attention wait's message: node outputs, enclosing loop scopes and
 * `$INPUTS`, and no other workflow variable. The dry run renders the same field through
 * this function so its preview cannot drift from what the operator receives.
 */
export function substituteWaitMessage(
  text: string,
  sources: TemplateSources,
  inputs: Record<string, JsonValue> | undefined
): string {
  const { before, after } = nodeTemplateReferences(text, sources);
  return substituteTemplate(text, [...before, inputRefToken(inputs), ...after]);
}

/**
 * Resolve an attention wait's options when it pauses. A whole `$node.output.<field>`
 * reference is read here and must pass the same rules as literal options; the node fails,
 * naming the producer, rather than pausing with options nobody can answer.
 */
export function resolveAttentionOptions(
  nodeId: string,
  options: AttentionOption[] | string | undefined,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): AttentionOption[] | undefined {
  if (typeof options !== 'string') return options;
  const ref = parseWholeOutputRef(options);
  const producer = ref === undefined ? undefined : nodeOutputs.get(ref.nodeId);
  if (ref === undefined || producer === undefined) {
    throw new Error(
      `Wait node '${nodeId}' options '${options}' name no node that has produced output`
    );
  }
  const parsed = attentionOptionsSchema.safeParse(
    wholeRefLogicalValue(producer, ref.nodeId, ref.field, options.trim())
  );
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
      .join('; ');
    throw new Error(
      `Wait node '${nodeId}' options '${options}' from '${ref.nodeId}' are not a valid option list ` +
        `(an array of { id, label? } with unique kebab-case ids and at least one entry): ${problems}`
    );
  }
  return parsed.data;
}

/**
 * Resolve a node's AI-configuration text (`systemPrompt:`, `agents.*`), which goes
 * straight to the provider, exactly as a `prompt:` resolves (#2476). Inside a loop_group
 * body this reads the body's scoped `nodeOutputs` and loop scopes, matching every other
 * surface. `typedArtifactsFile` is the listing the node materialized before it resolves
 * its provider.
 */
export function aiConfigTextResolver(
  ctx: Pick<
    RunLayersContext,
    | 'workflowRun'
    | 'artifactsDir'
    | 'baseBranch'
    | 'docsDir'
    | 'issueContext'
    | 'stateDir'
    | 'nodeOutputs'
    | 'loopBodyScopes'
  >,
  typedArtifactsFile: string
): (text: string) => string {
  return text =>
    substituteWorkflowVariables(
      text,
      ctx.workflowRun.id,
      ctx.workflowRun.user_message,
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      {
        stateDir: ctx.stateDir,
        inputs: resolveRunInputs(ctx.workflowRun),
        typedArtifactsFile,
        references: nodeTemplateReferences(text, ctx),
      }
    ).prompt;
}
