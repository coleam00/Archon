import type { DagNode, IncludeDirective } from '../schemas';
import {
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  definedOutputPaths,
  isWaitNode,
  isIncludeDirective,
} from '../schemas';
import { attentionOptionSchema } from '../schemas/wait-node';
import { isAnnotationOnlyOutputSchema } from '../structured-output';
import {
  findUnsupportedNestedWhenRef,
  assertSupportedWhenOutputRefs,
  parseWhenExpression,
  splitOutsideQuotes,
  WHEN_INPUTS_SCOPE,
  type WhenAtom,
} from '../when-atom';
import {
  assertDeclaredOutputPath,
  declaredOutputSchemasFromSchema,
  assertSupportedOutputRefs,
  outputRefText,
  CURRENT_OUTPUT_PATH_SOURCE,
  PRIOR_OUTPUT_PATH_SOURCE,
  OUTPUT_REF_SOURCE,
  parseWholeOutputRef,
} from '../output-ref';
import { visitNodeTemplateSlots, type TemplateSurface } from '../template-walker';
import { z } from 'zod';

// OUTPUT_REF_SOURCE (output-ref.ts) is the one shape of a `$nodeId.output` reference, shared
// with the binding-value whole-ref parser and the schema's directive validation. Every scanner
// builds its own RegExp from it, because a `g` regex carries mutable `lastIndex` and sharing a
// single instance across call sites is how that turns into skipped matches.

/** `when:` also accepts `$nodeId.field` as shorthand for `$nodeId.output.field`. */
const WHEN_REF_SOURCE = String.raw`\$([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)`;

/**
 * Why a producer's WHOLE output cannot be compared to a literal in a `when:` (#2566),
 * or `null` when it can.
 *
 * Comparing a model's entire reply to an exact string is false the moment it writes a
 * sentence instead of a token — and the node is then skipped with no error. Both AI
 * producer kinds below are rejected, but for DIFFERENT reasons, so each gets its own
 * remedy. Each claim was verified by parsing a node through `dagNodeSchema`, not read off
 * the field lists:
 *
 *   'schema-capable' — `prompt:` / `command:` / `loop:`: `output_format` survives the
 *                      transform, and on a valid structured turn the executor REPLACES
 *                      the node's output text with the validated JSON document. So
 *                      declaring one is both the fix (compare a field) and the opt-out
 *                      (the whole output is then a document the author controls, not
 *                      prose). `loop:` joined this group in #2563 — it runs its own
 *                      sendQuery, so the schema reaches the provider and each iteration's
 *                      payload is validated against it. Before that it was its own kind,
 *                      because the field was dropped at parse and declaring one was a
 *                      no-op; that is no longer true and the separate kind is gone.
 *   'loop-group'     — `loop_group:`: `output_format` survives the transform here too,
 *                      but the group never calls the provider itself — its completion
 *                      returns `output: lastIterationOutput` with no `structuredOutput`
 *                      and no `declaredOutputPaths`, so the whole-output channel is still the
 *                      last iteration's raw text. Declaring a schema cannot make
 *                      `$group.output` a JSON document. This is the one asymmetry left.
 *
 * Everything else keeps whole-output comparison: `bash:`/`script:` stdout is
 * author-controlled and exact by construction, an attention answer is what the answerer
 * typed, and a `workflow:` sub-run's output is the callee's business.
 *
 * `command:` is grouped with `prompt:` even though #2566 names only three node types: a
 * command file is an inline prompt that lives in another file, so excluding it would
 * leave the same hazard reachable by moving the prompt.
 */
function freeFormAiProducerKind(node: DagNode): 'schema-capable' | 'loop-group' | null {
  // A `loop:` node is schema-capable since #2563: it makes its own sendQuery, so a
  // declared `output_format` reaches the provider and its output becomes the
  // validated JSON — exactly like a prompt/command node. It therefore gets the same
  // verdict and the same remedy, and there is no longer a separate 'loop' kind. (A
  // `loop_group:` still has none of that: it never calls the provider itself.)
  if (isLoopGroupNode(node)) return 'loop-group';
  if (!isLoopNode(node) && !isAgentNode(node)) return null;
  return node.output_format === undefined ? 'schema-capable' : null;
}

/** The remedy clause for each rejected producer kind (see freeFormAiProducerKind). */
const GATE_ON_A_SHELL_NODE =
  "compute the decision in a 'bash:'/'script:' node (or an 'until_bash' check) and gate on that node's output instead";

/** `attentionOptionSchema` as JSON Schema: the shape a producer's options field must declare. */
const ATTENTION_OPTION_JSON_SCHEMA = z.toJSONSchema(attentionOptionSchema);

/**
 * Why a producer's `output_format` cannot yield attention options at `options`'s field,
 * or undefined when it can or declares no schema (the pause-time check then owns it).
 * The field must be an array whose items declare only `attentionOptionSchema`'s
 * properties, with the same types, and require what it requires.
 */
function referencedOptionsShapeError(
  options: string,
  producerOf: (id: string) => DagNode | IncludeDirective | undefined
): string | undefined {
  const ref = parseWholeOutputRef(options);
  if (ref?.field === undefined) return undefined;
  const producer = producerOf(ref.nodeId);
  if (producer === undefined || isIncludeDirective(producer)) return undefined;
  if (producer.output_format === undefined) return undefined;
  const path = ref.field.split('.');
  const declarations = (declaredOutputSchemasFromSchema(producer.output_format) ?? []).filter(
    declaration =>
      declaration.path.length === path.length &&
      declaration.path.every((segment, index) => segment === path[index])
  );
  const conjunctions = new Map<symbol, unknown[]>();
  for (const { schema, conjunction } of declarations) {
    const schemas = conjunctions.get(conjunction) ?? [];
    schemas.push(schema);
    conjunctions.set(conjunction, schemas);
  }
  const fits =
    conjunctions.size > 0 &&
    [...conjunctions.values()].every(
      schemas =>
        schemas.some(isAttentionOptionsSchema) &&
        schemas.every(
          schema => isAttentionOptionsSchema(schema) || isAnnotationOnlyOutputSchema(schema)
        )
    );
  if (fits) return undefined;
  const { properties: optionProperties = {}, required: optionRequired = [] } =
    ATTENTION_OPTION_JSON_SCHEMA;
  const expected = Object.entries(optionProperties)
    .map(([key, property]) => {
      const type = isRecord(property) ? String(property.type) : 'unknown';
      return optionRequired.includes(key) ? `${key}: ${type}` : `${key}?: ${type}`;
    })
    .join('; ');
  return `'${options}' must be an array of objects declaring only { ${expected} } in '${ref.nodeId}'s output_format`;
}

function isAttentionOptionsSchema(schema: unknown): boolean {
  const items: unknown = isRecord(schema) && schema.type === 'array' ? schema.items : undefined;
  const itemProperties: unknown = isRecord(items) ? items.properties : undefined;
  const itemRequired: unknown = isRecord(items) ? items.required : undefined;
  const { properties: optionProperties = {}, required: optionRequired = [] } =
    ATTENTION_OPTION_JSON_SCHEMA;
  return (
    isRecord(items) &&
    items.type === 'object' &&
    isRecord(itemProperties) &&
    Object.entries(itemProperties).every(([key, property]) => {
      const optionProperty = optionProperties[key];
      return (
        isRecord(property) && isRecord(optionProperty) && property.type === optionProperty.type
      );
    }) &&
    optionRequired.every(
      key => key in itemProperties && Array.isArray(itemRequired) && itemRequired.includes(key)
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The load error for a `when:` that `parseWhenExpression` rejects. The grouping hint is
 * added only when a parenthesis sits outside a quoted literal, so a typo like
 * `$a.output = 'x'` is not blamed on grouping.
 */
function unsupportedConditionSyntax(nodeId: string, field: string, text: string): string {
  const hasGrouping = ['(', ')'].some(paren => splitOutsideQuotes(text, paren).length > 1);
  const hint = hasGrouping ? 'Grouping parentheses are not supported; use' : 'Use';
  return `Node '${nodeId}' field '${field}' has unsupported condition syntax: "${text}". ${hint} comparisons joined by '&&'/'||' (AND binds tighter), or compute a decision in a script node`;
}

/** What every `validateDagStructure` check reads about the graph, built once per call. */
export interface DagScope {
  readonly nodes: readonly (DagNode | IncludeDirective)[];
  readonly nodesById: ReadonlyMap<string, DagNode | IncludeDirective>;
  readonly enclosingNodes: ReadonlyMap<string, DagNode | IncludeDirective> | undefined;
  readonly includeAliases: ReadonlyMap<string, string> | undefined;
  readonly eligibleResumeSources: ReadonlyMap<string, DagNode | IncludeDirective> | undefined;
  transitiveDepsOf(nodeId: string): Set<string>;
}

/** A runtime-substituted text slot whose node-output references are checked. */
interface TemplateReferenceSource {
  readonly field: string;
  readonly text: string;
  readonly surface: TemplateSurface;
  readonly bodyNodes?: readonly (DagNode | IncludeDirective)[];
}

/** A `$node.output.path` reference whose path is checked against the producer's declared outputs. */
interface OutputPathRef {
  readonly nodeId: string;
  readonly field?: string;
  readonly reference: string;
  readonly prior: boolean;
}

/**
 * Every runtime-substituted node-output reference of `node` points to a known node in its
 * current or enclosing loop scope, and no `when:` compares a free-form AI output to a literal.
 */
export function checkNodeReferences(
  node: DagNode | IncludeDirective,
  scope: DagScope
): string | null {
  return (
    checkTemplateReferences(node, scope) ??
    checkWaitReferences(node, scope) ??
    checkWhenCondition(node, scope)
  );
}

/**
 * template-walker.ts owns every engine template/reference field. Runtime substitution
 * is syntax-agnostic, so this scan checks each text slot verbatim.
 */
function templateReferenceSources(node: DagNode | IncludeDirective): TemplateReferenceSource[] {
  const sources: TemplateReferenceSource[] = [];
  if (!isIncludeDirective(node)) {
    visitNodeTemplateSlots(
      node,
      slot => {
        if (!slot.outputReference) return;
        sources.push({
          field: slot.path,
          text: slot.value,
          surface: slot.surface,
          ...(slot.path === 'loop_group.until_bash' && isLoopGroupNode(node)
            ? { bodyNodes: node.loop_group.nodes }
            : {}),
        });
      },
      { recursive: false }
    );
  }
  return sources;
}

function checkTemplateReferences(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  for (const source of templateReferenceSources(node)) {
    const error = checkTemplateReferenceSource(node.id, source, scope);
    if (error !== null) return error;
  }
  return null;
}

function checkTemplateReferenceSource(
  nodeId: string,
  source: TemplateReferenceSource,
  scope: DagScope
): string | null {
  const unsupported = unsupportedReferenceError(nodeId, source);
  if (unsupported !== null) return unsupported;
  const refs = outputPathRefs(nodeId, source, scope);
  if (typeof refs === 'string') return refs;
  return (
    declaredOutputPathError(nodeId, source, refs, scope) ??
    unknownTemplateNodeError(nodeId, source, scope)
  );
}

function unsupportedReferenceError(nodeId: string, source: TemplateReferenceSource): string | null {
  try {
    if (source.surface === 'condition') assertSupportedWhenOutputRefs(source.text);
    else assertSupportedOutputRefs(source.text);
  } catch (error) {
    return `Node '${nodeId}' field '${source.field}': ${error instanceof Error ? error.message : String(error)}`;
  }
  if (source.surface === 'condition') {
    const unsupported = findUnsupportedNestedWhenRef(source.text);
    if (unsupported)
      return `Node '${nodeId}' field '${source.field}' contains nested shorthand '${unsupported.reference}'; use canonical '.output' spelling.`;
  }
  return null;
}

/** The source's `$node.output.path` references, or the condition's syntax error. */
function outputPathRefs(
  nodeId: string,
  source: TemplateReferenceSource,
  scope: DagScope
): OutputPathRef[] | string {
  if (source.surface !== 'condition') return textOutputPathRefs(source.text);
  const expression = parseWhenExpression(source.text, scope.enclosingNodes !== undefined);
  if (expression === null) {
    return unsupportedConditionSyntax(nodeId, source.field, source.text);
  }
  const refs: OutputPathRef[] = [];
  for (const atom of expression.flat()) {
    if (atom.ref.kind === 'input') continue;
    const { nodeId: producerId, field } = atom.ref;
    const prior = atom.ref.kind === 'loop_prev';
    refs.push({
      nodeId: producerId,
      field,
      prior,
      reference: outputRefText(producerId, field, prior ? 'prior' : 'current'),
    });
  }
  return refs;
}

function textOutputPathRefs(text: string): OutputPathRef[] {
  const refs: OutputPathRef[] = [];
  for (const [pattern, prior] of [
    [CURRENT_OUTPUT_PATH_SOURCE, false],
    [PRIOR_OUTPUT_PATH_SOURCE, true],
  ] as const) {
    for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
      refs.push({ nodeId: match[1], field: match[2], reference: match[0], prior });
    }
  }
  return refs;
}

function outputPathProducer(
  ref: OutputPathRef,
  source: TemplateReferenceSource,
  scope: DagScope
): DagNode | IncludeDirective | undefined {
  const { nodes, nodesById, enclosingNodes } = scope;
  return ref.prior
    ? (source.bodyNodes ?? (enclosingNodes ? nodes : undefined))?.find(
        candidate => candidate.id === ref.nodeId
      )
    : (nodesById.get(ref.nodeId) ??
        enclosingNodes?.get(ref.nodeId) ??
        source.bodyNodes?.find(candidate => candidate.id === ref.nodeId));
}

function declaredOutputPathError(
  nodeId: string,
  source: TemplateReferenceSource,
  refs: readonly OutputPathRef[],
  scope: DagScope
): string | null {
  for (const ref of refs) {
    const error = declaredOutputPathRefError(nodeId, source, ref, scope);
    if (error !== null) return error;
  }
  return null;
}

function declaredOutputPathRefError(
  nodeId: string,
  source: TemplateReferenceSource,
  ref: OutputPathRef,
  scope: DagScope
): string | null {
  if (ref.nodeId === WHEN_INPUTS_SCOPE || ref.field === undefined) return null;
  const producer = outputPathProducer(ref, source, scope);
  if (!producer || isIncludeDirective(producer)) return null;
  const paths = definedOutputPaths(producer);
  if (paths === undefined) return null;
  // `$LOOP_PREV` refs are never rewritten to an include's sink, so only a current
  // ref can carry an alias.
  const alias = ref.prior ? undefined : scope.includeAliases?.get(ref.nodeId);
  try {
    if (alias === undefined) {
      assertDeclaredOutputPath(paths, ref.nodeId, ref.field, ref.reference);
    } else {
      assertDeclaredOutputPath(paths, alias, ref.field, outputRefText(alias, ref.field));
    }
  } catch (error) {
    return `Node '${nodeId}' field '${source.field}': ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

function unknownTemplateNodeError(
  nodeId: string,
  source: TemplateReferenceSource,
  scope: DagScope
): string | null {
  const { nodesById, enclosingNodes } = scope;
  const outputRefPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = outputRefPattern.exec(source.text)) !== null) {
    const refNodeId = m[1];
    // `$INPUTS.name` is an input macro. In particular, `$INPUTS.output` also
    // matches the canonical node-ref grammar, so the macro must take precedence.
    if (refNodeId === WHEN_INPUTS_SCOPE) continue;
    if (refNodeId === 'LOOP_PREV' && enclosingNodes !== undefined) continue;
    // Output refs (unlike depends_on) may also reach ENCLOSING-scope nodes: the
    // executor seeds a loop_group iteration's scoped output map with the outer
    // DAG's outputs, so `$outerNode.output` inside a body prompt is valid.
    if (
      refNodeId !== undefined &&
      !nodesById.has(refNodeId) &&
      !enclosingNodes?.has(refNodeId) &&
      !source.bodyNodes?.some(bodyNode => bodyNode.id === refNodeId)
    ) {
      if (source.bodyNodes !== undefined) {
        return `Node '${nodeId}' field '${source.field}' references unknown node '$${refNodeId}.output'. Expected a node in the loop_group body or current/enclosing DAG scope`;
      }
      return `Node '${nodeId}' field '${source.field}' references unknown node '$${refNodeId}.output'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
    }
  }
  return null;
}

function checkWaitReferences(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  if (isIncludeDirective(node) || !isWaitNode(node)) return null;
  const { nodesById, enclosingNodes } = scope;
  const waitSources: (readonly [string, string])[] = [];
  if (node.wait.until !== undefined) waitSources.push(['wait.until', node.wait.until]);
  if (node.wait.event !== undefined) waitSources.push(['wait.event', node.wait.event]);
  if (node.wait.attention !== undefined) waitSources.push(['wait.attention', node.wait.attention]);
  for (const [key, label] of Object.entries(node.wait.labels ?? {}))
    waitSources.push([`wait.labels.${key}`, label]);
  if (typeof node.wait.options === 'string') {
    waitSources.push(['wait.options', node.wait.options]);
    const shapeError = referencedOptionsShapeError(
      node.wait.options,
      id => nodesById.get(id) ?? enclosingNodes?.get(id)
    );
    if (shapeError !== undefined) return `Node '${node.id}' field 'wait.options': ${shapeError}`;
  }
  for (const [field, text] of waitSources) {
    const error = waitProducerError(node.id, field, text, scope);
    if (error !== null) return error;
  }
  return null;
}

function waitProducerError(
  nodeId: string,
  field: string,
  text: string,
  scope: DagScope
): string | null {
  const outputRefPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = outputRefPattern.exec(text)) !== null) {
    const producerId = m[1];
    if (
      producerId === undefined ||
      producerId === WHEN_INPUTS_SCOPE ||
      scope.enclosingNodes?.has(producerId)
    ) {
      continue;
    }
    if (!scope.transitiveDepsOf(nodeId).has(producerId)) {
      return `Node '${nodeId}' field '${field}' references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${nodeId}'.depends_on so the wait condition is produced first`;
    }
  }
  return null;
}

function checkWhenCondition(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  if (node.when === undefined) return null;
  const expression = parseWhenExpression(node.when, scope.enclosingNodes !== undefined);
  if (expression === null) {
    return unsupportedConditionSyntax(node.id, 'when', node.when);
  }
  return (
    unknownWhenReferenceError(node.id, node.when, scope) ??
    wholeOutputComparisonError(node.id, expression, scope)
  );
}

function unknownWhenReferenceError(nodeId: string, when: string, scope: DagScope): string | null {
  const { nodesById, enclosingNodes } = scope;
  const whenRefPattern = new RegExp(WHEN_REF_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = whenRefPattern.exec(when)) !== null) {
    const refNodeId = m[1];
    const field = m[2];
    // `$INPUTS.name` is an include-time macro at load and a run-time input scope in
    // a sub-run — either way it is not a node reference.
    if (refNodeId === WHEN_INPUTS_SCOPE) continue;
    if (refNodeId === 'LOOP_PREV' && enclosingNodes !== undefined) continue;
    if (refNodeId !== undefined && !nodesById.has(refNodeId) && !enclosingNodes?.has(refNodeId)) {
      return `Node '${nodeId}' field 'when' references unknown node '$${refNodeId}.${field ?? ''}'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
    }
  }
  return null;
}

/**
 * #2566: reject a `when:` that compares a producer's WHOLE free-form AI output to
 * a literal. `actual === expected` on a model's entire reply is false as soon as
 * the model writes "This is a BUG." instead of "BUG" — and the node is then
 * skipped with no error, so the run reaches a terminal state looking successful
 * while having quietly done less than the author asked for. Caught here, before
 * any spend, with the fix in the message.
 *
 * The atom decomposition comes from the shared `when-atom` parser (the same one
 * the evaluator runs), because the coarse `WHEN_REF_SOURCE` sweep in
 * `unknownWhenReferenceError` captures only the first path segment and so cannot tell
 * `$n.output` from `$n.output.field`.
 */
function wholeOutputComparisonError(
  nodeId: string,
  expression: readonly (readonly WhenAtom[])[],
  scope: DagScope
): string | null {
  for (const atom of expression.flat()) {
    if (atom.ref.kind !== 'node' || atom.ref.field !== undefined) continue;
    const producerId = atom.ref.nodeId;
    const producer = scope.nodesById.get(producerId) ?? scope.enclosingNodes?.get(producerId);
    if (!producer || isIncludeDirective(producer)) continue;
    const kind = freeFormAiProducerKind(producer);
    if (kind === null) continue;
    const problem = `Node '${nodeId}' field 'when' compares the whole output of AI node '${producerId}' to a literal ('${atom.expected}'). That output is free-form prose, so the comparison silently fails and '${nodeId}' is skipped.`;
    if (kind === 'schema-capable') {
      return `${problem} Declare 'output_format' on '${producerId}' and compare a field (e.g. "$${producerId}.output.status ${atom.operator} '${atom.expected}'"), or produce the value from a 'bash:'/'script:' node`;
    }
    if (kind === 'loop-group') {
      return `${problem} A 'loop_group:' node's output is the last iteration's raw text — unlike a 'prompt:' node, declaring 'output_format' does not replace it with the JSON document — so ${GATE_ON_A_SHELL_NODE}`;
    }
    // Exhaustive: a new producer kind must state its own reason rather than inherit
    // whichever branch happened to be last. Silently handing an author the wrong
    // remedy is the same class of failure this whole check exists to remove.
    return kind satisfies never;
  }
  return null;
}
