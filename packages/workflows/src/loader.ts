import { missingProviderMessage } from '@archon/provider-contract';
/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type { ProviderRegistry } from '@archon/provider-contract';
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  DagNode,
  GateNode,
  IncludeDirective,
  WaitNode,
} from './schemas';
import {
  isExecNode,
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  definedOutputPaths,
  loopGroupSoleTerminalSink,
  isGateNode,
  isWaitNode,
  isWorkflowNode,
  isIncludeDirective,
  isComposeFanOutNode,
  nodeUsesPersistedScope,
  persistedSessionHandling,
  isNodeContextResume,
} from './schemas';
import { COMPOSE_FAN_OUT_STEP_MARKER } from './fan-out-identity';

import {
  attentionOptionSchema,
  KNOWN_DAG_NODE_KEYS,
  effortLevelSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './schemas/dag-node';
import {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowRunBudgetSchema,
  workflowDeprecationSchema,
  workflowInputSpecSchema,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
} from './schemas/workflow';
import type {
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowRunBudget,
  WorkflowDeprecation,
  WorkflowInputSpec,
} from './schemas/workflow';
import { INPUT_NAME_PATTERN, inputEnvKey } from './schemas/dag-node';
import {
  findUnsupportedNestedWhenRef,
  assertSupportedWhenOutputRefs,
  parseWhenExpression,
  splitOutsideQuotes,
  WHEN_INPUTS_SCOPE,
} from './when-atom';
import {
  assertDeclaredOutputPath,
  assertSupportedOutputRefs,
  outputRefText,
  CURRENT_OUTPUT_PATH_SOURCE,
  PRIOR_OUTPUT_PATH_SOURCE,
  EXECUTION_CHECKOUT_REF_SOURCE,
  OUTPUT_REF_SOURCE,
  parseWholeExecutionCheckoutRef,
  parseWholeOutputRef,
} from './output-ref';
import { isBindingDirective } from './schemas/dag-node';
import { readComposedBindings } from './compiled-command';
import { visitNodeTemplateSlots, type TemplateSurface } from './template-walker';
import { validateInlineExecInputs } from './exec-input-validation';
import { z } from 'zod';
import { getLog } from './loader/log';
import {
  validateLoopGroupProseCompletion,
  validateNodeOutputFormats,
  validateRunBudgetShape,
  validateWorkflowOutcomeDeclaration,
} from './loader/contracts';
import {
  collectConditionalJoinWarnings,
  collectLegacyPauseWarnings,
  collectUnknownConfigKeys,
  pushUnknownKeyWarning,
} from './loader/parse-warnings';
import { parseDagNode } from './loader/node-parse';

/**
 * Parse an optional, schema-validated workflow field with warn-and-drop
 * semantics: a present-but-invalid value is logged and dropped (returns
 * undefined) rather than rejecting the whole workflow, so a typo in one field
 * doesn't abort the discovery pass. Mirrors the policy used for `tags` /
 * `interactive`. `extra` merges into the warning payload (e.g. the list of
 * valid enum options).
 *
 * The return type is inferred from the schema (`z.output<S>`), so
 * preprocess-based schemas still resolve to their parsed output type rather
 * than their input type. zod v4 removed `ZodTypeDef` as the middle type parameter, so the
 * old `z.ZodType<T, z.ZodTypeDef, unknown>` form no longer compiles.
 */
function parseOptionalField<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  filename: string,
  event: string,
  extra?: Record<string, unknown>
): z.output<S> | undefined {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  if (raw !== undefined) {
    getLog().warn({ filename, value: raw, ...extra }, event);
  }
  return undefined;
}

/**
 * Parse workflow YAML with Bun's parser. Every reader of a workflow file goes through here.
 * CRLF is normalized first: Bun keeps the line break of a multi-line quoted scalar in a CRLF
 * file where the YAML spec (and LF input) folds it to a space.
 */
export function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content.replaceAll('\r\n', '\n'));
}

// OUTPUT_REF_SOURCE — the one shape of a `$nodeId.output` reference — moved to
// output-ref.ts (#2637) so the binding-value whole-ref parser, the schema's directive
// validation, and these scanners share ONE grammar. Both scanners below still build
// their own RegExp from it — a `g`-flagged one for the multi-match dangling-ref sweep
// and a plain one for `fan_out.items` — because a `g` regex carries mutable
// `lastIndex` and sharing a single instance across call sites is how that turns into
// skipped matches.

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
  let schema: unknown = producer.output_format;
  if (schema === undefined) return undefined;
  for (const key of ref.field.split('.')) {
    const properties: unknown = isRecord(schema) ? schema.properties : undefined;
    schema = isRecord(properties) ? properties[key] : undefined;
  }
  const items: unknown = isRecord(schema) && schema.type === 'array' ? schema.items : undefined;
  const itemProperties: unknown = isRecord(items) ? items.properties : undefined;
  const itemRequired: unknown = isRecord(items) ? items.required : undefined;
  const { properties: optionProperties = {}, required: optionRequired = [] } =
    ATTENTION_OPTION_JSON_SCHEMA;
  const fits =
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
    );
  if (fits) return undefined;
  const expected = Object.entries(optionProperties)
    .map(([key, property]) => {
      const type = isRecord(property) ? String(property.type) : 'unknown';
      return optionRequired.includes(key) ? `${key}: ${type}` : `${key}?: ${type}`;
    })
    .join('; ');
  return `'${options}' must be an array of objects declaring only { ${expected} } in '${ref.nodeId}'s output_format`;
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

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * every runtime-substituted node-output reference points to a known node in its
 * current or enclosing loop scope, and no `when:` compares a free-form AI output to
 * a literal.
 * Returns error message or null if valid.
 *
 * Exported so the include-expander can re-run the same structural checks on the
 * fully-flattened, namespaced node list after inlining (duplicate-id collisions,
 * cycles introduced by rewired edges, unknown deps).
 *
 * `enclosingNodes` carries the enclosing loop scope's nodes BY ID rather than just
 * their ids, because a `loop_group` body's `when:` may reference an outer producer and
 * the free-form-AI check needs that producer's type and `output_format`.
 *
 * `includeAliases` maps a flattened producer id back to the include alias the author
 * referenced, so an output-contract error names `$alias.output.x` as written.
 */
export function validateDagStructure(
  nodes: readonly (DagNode | IncludeDirective)[],
  enclosingNodes?: ReadonlyMap<string, DagNode | IncludeDirective>,
  includeAliases?: ReadonlyMap<string, string>,
  eligibleResumeSources?: ReadonlyMap<string, DagNode | IncludeDirective>
): string | null {
  // Check ID uniqueness
  const nodesById = new Map<string, DagNode | IncludeDirective>();
  for (const node of nodes) {
    if (nodesById.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    // A loop_group body node must not reuse an enclosing DAG's node id: the executor
    // seeds each iteration's scoped output map with the outer outputs, so a colliding
    // body node would silently shadow the outer node for $id.output refs.
    if (enclosingNodes?.has(node.id)) {
      return `Node id '${node.id}' shadows a node id in the enclosing DAG`;
    }
    if (node.id.includes(COMPOSE_FAN_OUT_STEP_MARKER)) {
      return `Node id '${node.id}' contains reserved engine namespace '${COMPOSE_FAN_OUT_STEP_MARKER}'`;
    }
    nodesById.set(node.id, node);
  }

  // Check depends_on references
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!nodesById.has(dep)) {
        return `Node '${node.id}' depends_on unknown node '${dep}'`;
      }
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  let ready = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  const layers: string[][] = [];
  let visited = 0;

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const nodeId of ready) {
      visited++;
      for (const dep of dependents.get(nodeId) ?? []) {
        const newDegree = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) nextIds.push(dep);
      }
    }
    ready = nextIds;
  }

  if (visited < nodes.length) {
    const cycleNodes = nodes.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
    return `Cycle detected among nodes: ${cycleNodes.join(', ')}`;
  }

  // Scalar `shared` inherits one ambient sequential cursor. A multi-node ready set is
  // the executor's exact definition of a parallel layer; it clears that cursor before
  // evaluating `when:` or dispatching either sibling. Reject the otherwise silent no-op
  // here, while the graph is still being loaded. Explicit named resume owns deliberate
  // parallel ancestry (#2099/#2643).
  for (const layer of layers) {
    if (layer.length < 2) continue;
    const sharedNode = layer
      .map(nodeId => nodesById.get(nodeId))
      .find(
        (node): node is DagNode =>
          node !== undefined &&
          !isIncludeDirective(node) &&
          isAgentNode(node) &&
          node.context === 'shared'
      );
    if (sharedNode === undefined) continue;
    if (enclosingNodes !== undefined) {
      return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel loop_group body. Scalar 'shared' only inherits the ambient session in sequential layers. Serialize the body nodes with 'depends_on' or use fresh context; use context: { resume: <pre-loop-node-id> } for a private owner session`;
    }
    return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel layer. Scalar 'shared' only inherits the ambient session in sequential layers. Use 'context: { resume: <upstream-node-id> }' to fork an exact upstream session, or serialize the nodes with 'depends_on'`;
  }

  const directDeps = new Map<string, string[]>(nodes.map(n => [n.id, n.depends_on ?? []]));
  const transitiveDepsOf = (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(directDeps.get(nodeId) ?? [])];
    while (stack.length > 0) {
      const dep = stack.pop();
      if (dep === undefined || seen.has(dep)) continue;
      seen.add(dep);
      stack.push(...(directDeps.get(dep) ?? []));
    }
    return seen;
  };

  const hasDurableWait = (node: DagNode | IncludeDirective): boolean => {
    if (isIncludeDirective(node)) return false;
    if (isWaitNode(node)) return true;
    return isLoopGroupNode(node) && node.loop_group.nodes.some(hasDurableWait);
  };
  const canSuspend = (node: DagNode | IncludeDirective): boolean => {
    if (isIncludeDirective(node)) return false;
    if (isGateNode(node) || isWaitNode(node) || isWorkflowNode(node)) return true;
    if (isLoopNode(node) && node.loop.interactive) return true;
    return (
      isLoopGroupNode(node) &&
      (node.loop_group.interactive === true || node.loop_group.nodes.some(canSuspend))
    );
  };
  const suspensionNodes = nodes.filter(canSuspend);
  for (let index = 0; index < suspensionNodes.length; index++) {
    const left = suspensionNodes[index];
    if (left === undefined) continue;
    for (const right of suspensionNodes.slice(index + 1)) {
      const ordered =
        transitiveDepsOf(left.id).has(right.id) || transitiveDepsOf(right.id).has(left.id);
      if (!ordered && (hasDurableWait(left) || hasDurableWait(right))) {
        return `Suspending nodes '${left.id}' and '${right.id}' can run concurrently; add a dependency so only one suspension owns the run cursor at a time`;
      }
    }
  }

  // template-walker.ts owns every engine template/reference field. Runtime substitution
  // is syntax-agnostic, so this scan checks each text slot verbatim.
  const outputRefPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
  const whenRefPattern = new RegExp(WHEN_REF_SOURCE, 'g');
  for (const node of nodes) {
    const sources: {
      field: string;
      text: string;
      surface: TemplateSurface;
      bodyNodes?: readonly (DagNode | IncludeDirective)[];
    }[] = [];
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
    for (const source of sources) {
      try {
        if (source.surface === 'condition') assertSupportedWhenOutputRefs(source.text);
        else assertSupportedOutputRefs(source.text);
      } catch (error) {
        return `Node '${node.id}' field '${source.field}': ${error instanceof Error ? error.message : String(error)}`;
      }
      if (source.surface === 'condition') {
        const unsupported = findUnsupportedNestedWhenRef(source.text);
        if (unsupported)
          return `Node '${node.id}' field '${source.field}' contains nested shorthand '${unsupported.reference}'; use canonical '.output' spelling.`;
      }
      const refs: { nodeId: string; field?: string; reference: string; prior: boolean }[] = [];
      if (source.surface === 'condition') {
        const expression = parseWhenExpression(source.text, enclosingNodes !== undefined);
        if (expression === null) {
          return unsupportedConditionSyntax(node.id, source.field, source.text);
        }
        for (const atom of expression.flat()) {
          if (atom.ref.kind === 'input') continue;
          const { nodeId, field } = atom.ref;
          const prior = atom.ref.kind === 'loop_prev';
          refs.push({
            nodeId,
            field,
            prior,
            reference: outputRefText(nodeId, field, prior ? 'prior' : 'current'),
          });
        }
      } else {
        for (const [pattern, prior] of [
          [CURRENT_OUTPUT_PATH_SOURCE, false],
          [PRIOR_OUTPUT_PATH_SOURCE, true],
        ] as const) {
          for (const match of source.text.matchAll(new RegExp(pattern, 'g'))) {
            refs.push({ nodeId: match[1], field: match[2], reference: match[0], prior });
          }
        }
      }
      for (const ref of refs) {
        if (ref.nodeId === WHEN_INPUTS_SCOPE || ref.field === undefined) continue;
        const producer = ref.prior
          ? (source.bodyNodes ?? (enclosingNodes ? nodes : undefined))?.find(
              candidate => candidate.id === ref.nodeId
            )
          : (nodesById.get(ref.nodeId) ??
            enclosingNodes?.get(ref.nodeId) ??
            source.bodyNodes?.find(candidate => candidate.id === ref.nodeId));
        if (!producer || isIncludeDirective(producer)) continue;
        const paths = definedOutputPaths(producer);
        if (paths === undefined) continue;
        // `$LOOP_PREV` refs are never rewritten to an include's sink, so only a current
        // ref can carry an alias.
        const alias = ref.prior ? undefined : includeAliases?.get(ref.nodeId);
        try {
          if (alias === undefined) {
            assertDeclaredOutputPath(paths, ref.nodeId, ref.field, ref.reference);
          } else {
            assertDeclaredOutputPath(paths, alias, ref.field, outputRefText(alias, ref.field));
          }
        } catch (error) {
          return `Node '${node.id}' field '${source.field}': ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
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
            return `Node '${node.id}' field '${source.field}' references unknown node '$${refNodeId}.output'. Expected a node in the loop_group body or current/enclosing DAG scope`;
          }
          return `Node '${node.id}' field '${source.field}' references unknown node '$${refNodeId}.output'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }
    }

    if (!isIncludeDirective(node) && isWaitNode(node)) {
      const waitSources: (readonly [string, string])[] = [];
      if (node.wait.until !== undefined) waitSources.push(['wait.until', node.wait.until]);
      if (node.wait.event !== undefined) waitSources.push(['wait.event', node.wait.event]);
      if (node.wait.attention !== undefined)
        waitSources.push(['wait.attention', node.wait.attention]);
      for (const [key, label] of Object.entries(node.wait.labels ?? {}))
        waitSources.push([`wait.labels.${key}`, label]);
      if (typeof node.wait.options === 'string') {
        waitSources.push(['wait.options', node.wait.options]);
        const shapeError = referencedOptionsShapeError(
          node.wait.options,
          id => nodesById.get(id) ?? enclosingNodes?.get(id)
        );
        if (shapeError !== undefined)
          return `Node '${node.id}' field 'wait.options': ${shapeError}`;
      }
      for (const [field, text] of waitSources) {
        outputRefPattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = outputRefPattern.exec(text)) !== null) {
          const producerId = m[1];
          if (
            producerId === undefined ||
            producerId === WHEN_INPUTS_SCOPE ||
            enclosingNodes?.has(producerId)
          ) {
            continue;
          }
          if (!transitiveDepsOf(node.id).has(producerId)) {
            return `Node '${node.id}' field '${field}' references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so the wait condition is produced first`;
          }
        }
      }
    }

    if (node.when !== undefined) {
      const expression = parseWhenExpression(node.when, enclosingNodes !== undefined);
      if (expression === null) {
        return unsupportedConditionSyntax(node.id, 'when', node.when);
      }
      let m: RegExpExecArray | null;
      whenRefPattern.lastIndex = 0;
      while ((m = whenRefPattern.exec(node.when)) !== null) {
        const refNodeId = m[1];
        const field = m[2];
        // `$INPUTS.name` is an include-time macro at load and a run-time input scope in
        // a sub-run — either way it is not a node reference.
        if (refNodeId === WHEN_INPUTS_SCOPE) continue;
        if (refNodeId === 'LOOP_PREV' && enclosingNodes !== undefined) continue;
        if (
          refNodeId !== undefined &&
          !nodesById.has(refNodeId) &&
          !enclosingNodes?.has(refNodeId)
        ) {
          return `Node '${node.id}' field 'when' references unknown node '$${refNodeId}.${field ?? ''}'. In a composed workflow, pass caller data through declared 'inputs:' and caller 'with:' instead of referencing a caller node directly`;
        }
      }

      // #2566: reject a `when:` that compares a producer's WHOLE free-form AI output to
      // a literal. `actual === expected` on a model's entire reply is false as soon as
      // the model writes "This is a BUG." instead of "BUG" — and the node is then
      // skipped with no error, so the run reaches a terminal state looking successful
      // while having quietly done less than the author asked for. Caught here, before
      // any spend, with the fix in the message.
      //
      // The atom decomposition comes from the shared `when-atom` parser (the same one
      // the evaluator runs), because the coarse `whenRefPattern` sweep above captures
      // only the first path segment and so cannot tell `$n.output` from
      // `$n.output.field`.
      for (const atom of expression.flat()) {
        if (atom.ref.kind !== 'node' || atom.ref.field !== undefined) continue;
        const producerId = atom.ref.nodeId;
        const producer = nodesById.get(producerId) ?? enclosingNodes?.get(producerId);
        if (!producer || isIncludeDirective(producer)) continue;
        const kind = freeFormAiProducerKind(producer);
        if (kind === null) continue;
        const problem = `Node '${node.id}' field 'when' compares the whole output of AI node '${producerId}' to a literal ('${atom.expected}'). That output is free-form prose, so the comparison silently fails and '${node.id}' is skipped.`;
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
    }
  }

  // Body ancestry is proven at group entry, separately from output visibility.
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    if (!isNodeContextResume(node.context)) continue;
    const sourceId = node.context.resume;
    if (enclosingNodes !== undefined && nodesById.has(sourceId)) {
      return `Node '${node.id}' context.resume cannot name a source inside the same loop_group body`;
    }
    const source =
      enclosingNodes === undefined ? nodesById.get(sourceId) : eligibleResumeSources?.get(sourceId);
    if (source === undefined && enclosingNodes?.has(sourceId)) {
      return `Node '${node.id}' context.resume source '${sourceId}' is not an upstream dependency of the loop_group`;
    }
    if (source === undefined) {
      return `Node '${node.id}' context.resume references unknown node '${sourceId}'`;
    }
    if (isIncludeDirective(source) || !(isAgentNode(source) || isLoopNode(source))) {
      return `Node '${node.id}' context.resume source '${sourceId}' is not a session-producing command, prompt, or loop node`;
    }
    if (enclosingNodes === undefined && !transitiveDepsOf(node.id).has(sourceId)) {
      return `Node '${node.id}' context.resume source '${sourceId}' is not an upstream dependency`;
    }
  }

  // fan_out.items (slice 2, PR-C) must reference the output of a node that is a
  // TRANSITIVE dependency of the fan-out node — so the item array is guaranteed
  // produced before the node expands. A same-layer or downstream producer would race
  // (the ref resolves to nothing → the node fails closed at run time); catch it at
  // load time with an actionable message instead. A literal `items` with no `$…output`
  // ref is left to the runtime fail-closed check (it must still parse to an array).
  for (const node of nodes) {
    if (
      isIncludeDirective(node) ||
      !(isWorkflowNode(node) || isComposeFanOutNode(node)) ||
      !node.fan_out
    )
      continue;
    const refMatch = new RegExp(OUTPUT_REF_SOURCE).exec(node.fan_out.items);
    const producerId = refMatch?.[1];
    if (producerId === undefined) continue; // no ref surface — runtime fail-closed owns it
    if (!transitiveDepsOf(node.id).has(producerId)) {
      return `Node '${node.id}' fan_out.items references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its item array is produced first`;
    }
  }

  // Node-local bindings (#2637) must read UPSTREAM producers, mirroring fan_out.items:
  // depends_on is what guarantees a bound producer is terminal before the consumer
  // runs, so binding resolution needs no new scheduling. Only same-scope producers are
  // enforced — a loop_group body node may read the enclosing scope, whose outputs are
  // settled before the group starts (existing body-ref semantics).
  //
  // A composed command node is scanned through the payload its bindings moved to when
  // expansion compiled its body (#2964). This run over the FLATTENED graph is the only
  // one that can see a caller ref forwarded into a binding through `with:` — the child
  // was proven before that value was inserted, so a ref naming a parent node outside the
  // block's dependencies would otherwise reach the executor and fail the node mid-run.
  for (const node of nodes) {
    // Same capture-before-narrowing as the scan above: the include guard below would
    // otherwise filter a compose_fan_out node out of the binding check entirely.
    const composeFanOut = isComposeFanOutNode(node) ? node : undefined;
    if (isIncludeDirective(node)) continue;
    if (isWorkflowNode(node)) {
      // A child run's inputs resolve through the launch path, which has no execution
      // records to read; forwarding the reference would hand the child a literal string.
      const misuse = Object.entries(node.with ?? {}).find(
        ([, value]) =>
          typeof value === 'string' && new RegExp(EXECUTION_CHECKOUT_REF_SOURCE).test(value)
      );
      if (misuse) {
        return `Node '${node.id}' binding 'with.${misuse[0]}' reads '$<node>.execution.checkoutStart', which a workflow: node cannot pass to its child run; only a command or script node's binding can read it`;
      }
      continue;
    }
    const nodeWith = isExecNode(node)
      ? node.with
      : isAgentNode(node)
        ? node.source.kind === 'command'
          ? node.source.with
          : readComposedBindings(node)
        : composeFanOut
          ? composeFanOut.with
          : undefined;
    if (nodeWith === undefined) continue;
    for (const [name, value] of Object.entries(nodeWith)) {
      const producerIds: string[] = [];
      const readsExecution =
        typeof value === 'string' && new RegExp(EXECUTION_CHECKOUT_REF_SOURCE).test(value);
      if (typeof value === 'string' && readsExecution) {
        const producerId = parseWholeExecutionCheckoutRef(value);
        if (composeFanOut) {
          return `Node '${node.id}' binding 'with.${name}' reads '$<node>.execution.checkoutStart', which a composed fan-out cannot pass to its instances; only a command or script node's binding can read it`;
        }
        if (producerId === undefined) {
          return `Node '${node.id}' binding 'with.${name}' uses '$<node>.execution.checkoutStart' inside other text; it is only valid as the whole value of a command or script node's binding`;
        }
        const producer = nodesById.get(producerId) ?? enclosingNodes?.get(producerId);
        if (producer === undefined) {
          return `Node '${node.id}' binding 'with.${name}' reads '$${producerId}.execution.checkoutStart', but no node '${producerId}' exists in this workflow`;
        }
        if (
          !isIncludeDirective(producer) &&
          !isAgentNode(producer) &&
          !isExecNode(producer) &&
          !isLoopNode(producer)
        ) {
          return `Node '${node.id}' binding 'with.${name}' reads '$${producerId}.execution.checkoutStart', but '${producerId}' is a ${producer.kind} node, which does not execute against the checkout and records no checkout start`;
        }
        producerIds.push(producerId);
      } else if (typeof value === 'string') {
        const refPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
        let refMatch: RegExpExecArray | null;
        while ((refMatch = refPattern.exec(value)) !== null) {
          if (refMatch[1] !== WHEN_INPUTS_SCOPE) producerIds.push(refMatch[1]);
        }
      } else if (isBindingDirective(value)) {
        const ref = parseWholeOutputRef(value.from);
        if (ref !== undefined) producerIds.push(ref.nodeId);
      }
      for (const producerId of producerIds) {
        if (!nodesById.has(producerId)) continue; // enclosing scope, or already rejected above
        if (!transitiveDepsOf(node.id).has(producerId)) {
          return `Node '${node.id}' binding 'with.${name}' references '$${producerId}.${readsExecution ? 'execution.checkoutStart' : 'output'}', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its value is produced first`;
        }
      }
    }
  }

  // Recursively validate loop_group bodies as scoped sub-DAGs. A loop_group body is
  // sealed for GRAPH edges: its depends_on edges resolve within the body (not the
  // outer DAG), and the body is itself a DAG (unique ids, no cycles). $nodeId.output
  // refs are wider — the accumulated enclosing-scope ids are passed down so body
  // prompts may reference outer nodes (mirrors the executor seeding the scoped output
  // map with outer outputs). Nested loop_groups recurse naturally, accumulating scope.
  // Outer-DAG cycle/depends_on checks above operate on the flattened top-level node
  // list and treat each loop_group as one outer node.
  for (const node of nodes) {
    if (!isIncludeDirective(node) && isLoopGroupNode(node)) {
      // `workflow:` (sub-run) inside a loop_group body is rejected (bounds the
      // interaction surface — see the plan's NOT Building). This wholesale rejection
      // also covers a fan-out (`fan_out:`) workflow node in a loop_group body (slice 2,
      // PR-C): a fan-out is a `workflow:` node, so nesting it per-iteration is likewise
      // out of scope.
      const workflowInBody = node.loop_group.nodes.find(
        n => !isIncludeDirective(n) && isWorkflowNode(n)
      );
      if (workflowInBody) {
        return `loop_group '${node.id}' body: 'workflow' (sub-run) is not supported inside a loop_group body`;
      }
      // A gate or wait pauses the enclosing loop only as the body's sole terminal sink
      // (#2707 step 3). Anywhere else its resume would replay or skip sibling work, and a
      // gate's answer would be silently ignored.
      const soleSink = loopGroupSoleTerminalSink(node.loop_group.nodes);
      const misplacedPause = node.loop_group.nodes.find(
        (n): n is GateNode | WaitNode =>
          !isIncludeDirective(n) && (isWaitNode(n) || isGateNode(n)) && n !== soleSink
      );
      if (misplacedPause) {
        const kind = misplacedPause.kind === 'gate' ? 'approval' : 'wait';
        return `loop_group '${node.id}' body: ${kind} node '${misplacedPause.id}' must be the body's sole terminal sink`;
      }
      const nestedWaitGroup = node.loop_group.nodes.find(
        n => !isIncludeDirective(n) && isLoopGroupNode(n) && hasDurableWait(n)
      );
      if (nestedWaitGroup) {
        return `loop_group '${node.id}' body: wait nodes nested below another loop_group are not supported`;
      }
      const scopeNodes = new Map<string, DagNode | IncludeDirective>([
        ...(enclosingNodes ?? []),
        ...nodesById,
      ]);
      const eligible = new Map(eligibleResumeSources);
      for (const id of transitiveDepsOf(node.id)) {
        const ancestor = nodesById.get(id);
        if (ancestor !== undefined) eligible.set(id, ancestor);
      }
      const bodyError = validateDagStructure(
        node.loop_group.nodes,
        scopeNodes,
        includeAliases,
        eligible
      );
      if (bodyError) {
        return `loop_group '${node.id}' body: ${bodyError}`;
      }
    }
  }

  return null; // valid
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null; warnings: string[] }
  | { workflow: null; error: WorkflowLoadError; warnings?: never };

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(
  content: string,
  filename: string,
  providers: ProviderRegistry,
  configuredEnvNames?: ReadonlySet<string>
): ParseResult {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
      return {
        workflow: null,
        error: {
          filename,
          error: 'YAML file is empty or does not contain an object',
          errorType: 'validation_error',
        },
      };
    }

    if (Object.hasOwn(raw, 'thinking')) {
      return {
        workflow: null,
        error: {
          filename,
          error: "'thinking:' has been removed; use 'effort:' instead",
          errorType: 'validation_error',
        },
      };
    }

    // A load failure reaches the author through the returned `error`, which discovery
    // collects for `workflow list`, `validate workflows`, `workflow run`, and the API.
    // Like parse warnings, the log line is debug so a broken file is not repeated on
    // every discovery (#3444).
    if (!raw.name || typeof raw.name !== 'string') {
      getLog().debug({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().debug({ filename }, 'workflow_missing_description');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing required field 'description'",
          errorType: 'validation_error',
        },
      };
    }

    const errors: string[] = [];

    // Reject legacy steps-based workflows
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    if (hasSteps) {
      errors.push(
        '`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively. Your bundled defaults are already updated — custom workflows need manual migration. See docs/sequential-dag-migration-guide.md for conversion patterns, or run: claude "Read docs/sequential-dag-migration-guide.md then convert .archon/workflows/<file> to nodes: format"'
      );
    }

    const hasNodes = Array.isArray(raw.nodes) && (raw.nodes as unknown[]).length > 0;

    if (errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: errors.join('; '),
          errorType: 'validation_error',
        },
      };
    }

    if (!hasNodes) {
      getLog().debug({ filename }, 'workflow_missing_nodes');
      return {
        workflow: null,
        error: {
          filename,
          error: "Workflow must have 'nodes:' configuration",
          errorType: 'validation_error',
        },
      };
    }

    // Parse DAG nodes using dagNodeSchema
    const validationErrors: string[] = [];
    const parseWarnings: string[] = [];
    const dagNodes = (raw.nodes as unknown[])
      .map((n: unknown, i: number) => parseDagNode(n, i, validationErrors, parseWarnings))
      .filter((n): n is DagNode | IncludeDirective => n !== null);

    if (dagNodes.length !== (raw.nodes as unknown[]).length) {
      getLog().debug({ filename, validationErrors }, 'dag_node_validation_failed');
      return {
        workflow: null,
        error: {
          filename,
          error: `DAG node validation failed: ${validationErrors.join('; ')}`,
          errorType: 'validation_error',
        },
      };
    }

    const structureError = validateDagStructure(dagNodes);
    if (structureError) {
      getLog().debug({ filename, structureError }, 'dag_structure_invalid');
      return {
        workflow: null,
        error: { filename, error: structureError, errorType: 'validation_error' },
      };
    }

    const outputFormatError = validateNodeOutputFormats(dagNodes);
    if (outputFormatError) {
      getLog().debug({ filename, outputFormatError }, 'output_format_rejected');
      return {
        workflow: null,
        error: { filename, error: outputFormatError, errorType: 'validation_error' },
      };
    }

    const proseCompletionError = validateLoopGroupProseCompletion(dagNodes);
    if (proseCompletionError) {
      getLog().debug({ filename, proseCompletionError }, 'loop_group_prose_completion_rejected');
      return {
        workflow: null,
        error: { filename, error: proseCompletionError, errorType: 'validation_error' },
      };
    }

    collectConditionalJoinWarnings(dagNodes, parseWarnings);
    collectLegacyPauseWarnings(dagNodes, raw.nodes as unknown[], parseWarnings);

    if (raw.interactive !== undefined) {
      const message =
        `Workflow '${raw.name}': workflow-level 'interactive:' is deprecated and has no effect. ` +
        'Any workflow can start in the foreground, in the background or from a trigger; a ' +
        'pause waits in the attention queue until it is answered. Remove the line.';
      parseWarnings.push(message);
      getLog().debug({ filename, warning: message }, 'workflow_interactive_deprecated');
    }

    // Parse workflow-level fields using WorkflowBaseSchema for validation
    // Note: modelReasoningEffort and webSearchMode use warn-and-ignore for invalid values
    // (consistent with original behavior) rather than schema-level rejection.
    const provider =
      typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;

    // Validate provider identity at load time, both at the workflow level and
    // per node. Model strings are NOT validated — they pass through to the SDK
    // at run time, which is the source of truth for what model names exist
    // (vendor SDKs ship new models faster than Archon can update).
    if (provider && !providers.get(provider)) {
      return {
        workflow: null,
        error: {
          filename,
          error: missingProviderMessage(providers, provider),
          errorType: 'validation_error',
        },
      };
    }
    for (const node of dagNodes) {
      if (isIncludeDirective(node)) continue;
      if (node.provider !== undefined && !providers.get(node.provider)) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}': ${missingProviderMessage(providers, node.provider)}`,
            errorType: 'validation_error',
          },
        };
      }
    }

    interface SessionNode {
      node: DagNode;
      provider: string | undefined;
    }
    const sessionConsumers: { consumer: SessionNode; sources: ReadonlyMap<string, SessionNode> }[] =
      [];
    const collectSessionNodes = (
      nodes: readonly (DagNode | IncludeDirective)[],
      inheritedProvider: string | undefined,
      enclosing = new Map<string, SessionNode>()
    ): void => {
      const scope = new Map(enclosing);
      for (const node of nodes) {
        if (!isIncludeDirective(node))
          scope.set(node.id, { node, provider: node.provider ?? inheritedProvider });
      }
      for (const node of nodes) {
        if (isIncludeDirective(node)) continue;
        const consumer = scope.get(node.id);
        if (consumer === undefined) continue;
        if (isNodeContextResume(node.context)) sessionConsumers.push({ consumer, sources: scope });
        if (isLoopGroupNode(node))
          collectSessionNodes(node.loop_group.nodes, consumer.provider, scope);
      }
    };
    collectSessionNodes(dagNodes, provider);
    for (const {
      consumer: { node, provider: consumerProvider },
      sources,
    } of sessionConsumers) {
      if (!isNodeContextResume(node.context)) continue;
      const sourceEntry = sources.get(node.context.resume);
      if (sourceEntry === undefined) continue;
      const source = sourceEntry.node;
      const sourceProvider = sourceEntry.provider;
      if (
        consumerProvider !== undefined &&
        sourceProvider !== undefined &&
        consumerProvider !== sourceProvider
      ) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}' context.resume source '${source.id}' uses provider '${sourceProvider}', but the consumer uses '${consumerProvider}'`,
            errorType: 'validation_error',
          },
        };
      }

      const knownProvider = consumerProvider ?? sourceProvider;
      const knownDescriptor =
        knownProvider === undefined ? undefined : providers.get(knownProvider);
      if (knownDescriptor) {
        const caps = knownDescriptor.capabilities;
        if (!caps.sessionResume || caps.sessionFork !== true) {
          return {
            workflow: null,
            error: {
              filename,
              error: `Node '${node.id}' context.resume requires immutable session forks, but provider '${knownProvider}' does not support sessionFork`,
              errorType: 'validation_error',
            },
          };
        }
      }
    }

    // persist_session capability gating: when the effective provider is known at
    // load time (explicit at node or workflow level), reject a provider without session
    // resume, and warn for one that cannot fork: the executor never continues its
    // persisted session, so each run of that node starts fresh. Both outcomes come from
    // `persistedSessionHandling`, the same answer the executor acts on. When the
    // provider is implicit (set via .archon/config.yaml defaults), the check defers to
    // runtime in agent dispatch (dag/nodes/agent/dispatch.ts).
    //
    // `nodeUsesPersistedScope` skips nodes that never use a persisted session (non-agent
    // nodes, context: 'fresh'), so workflow-level `persist_sessions: true` next to,
    // e.g., a bash node does not fail validation.
    const workflowPersistSessions = raw.persist_sessions === true;
    for (const node of dagNodes) {
      if (isIncludeDirective(node)) continue;
      if (!nodeUsesPersistedScope(node, workflowPersistSessions)) continue;

      const explicitProvider = ('provider' in node ? node.provider : undefined) ?? provider;
      const descriptor = explicitProvider ? providers.get(explicitProvider) : undefined;
      if (!descriptor) continue;
      const handling = persistedSessionHandling(descriptor.capabilities);
      if (handling === 'unsupported') {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}' has persist_session: true but provider '${explicitProvider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`,
            errorType: 'validation_error',
          },
        };
      }
      if (handling === 'fresh') {
        const message = `Node '${node.id}': provider '${explicitProvider}' cannot fork a session, so persist_session never continues an earlier run's session and every run starts fresh. Use a provider with sessionFork, or pass state between runs through artifacts.`;
        parseWarnings.push(message);
        getLog().debug(
          { id: node.id, provider: explicitProvider },
          'persist_session_not_continued'
        );
      }
    }

    // Validate modelReasoningEffort / webSearchMode — warn and ignore invalid values.
    const modelReasoningEffort = parseOptionalField(
      raw.modelReasoningEffort,
      modelReasoningEffortSchema,
      filename,
      'invalid_model_reasoning_effort',
      { valid: modelReasoningEffortSchema.options }
    );
    // Parsed here for validation only. The deprecation is RESOLVED far below,
    // next to `const effort = ...`, because translating needs `effort` too:
    // `modelReasoningEffort` becomes `effort` and is never carried forward.
    // Search `workflow_model_reasoning_effort_deprecated` for the other half.
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    // Warn (non-blocking) when signal_completes is set without interactive: the flag
    // only changes interactive-gate behavior — a non-interactive loop already
    // completes on the signal, so the author's intent is likely a missing
    // `interactive: true`. The workflow still loads.
    const hasSignalCompletesWithoutInteractive = (ns: (DagNode | IncludeDirective)[]): boolean =>
      ns.some(
        n =>
          !isIncludeDirective(n) &&
          ((isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
            (isLoopGroupNode(n) &&
              ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
                hasSignalCompletesWithoutInteractive(n.loop_group.nodes))))
      );
    if (hasSignalCompletesWithoutInteractive(dagNodes)) {
      getLog().warn({ filename }, 'signal_completes_without_interactive_ignored');
    }

    // Parse workflow-level worktree policy. Same warn-and-ignore pattern used
    // for `modelReasoningEffort` — invalid values are dropped
    // rather than rejected, so a typo in one workflow doesn't nuke the whole
    // discovery pass. Only `worktree.enabled` is recognised today.
    let worktreePolicy: { enabled?: boolean } | undefined;
    if (raw.worktree !== undefined) {
      if (
        typeof raw.worktree === 'object' &&
        raw.worktree !== null &&
        !Array.isArray(raw.worktree)
      ) {
        const rawEnabled = (raw.worktree as Record<string, unknown>).enabled;
        if (typeof rawEnabled === 'boolean') {
          worktreePolicy = { enabled: rawEnabled };
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_worktree_enabled_value_ignored');
        }
      } else {
        getLog().warn({ filename, value: raw.worktree }, 'invalid_worktree_block_ignored');
      }
    }

    // Parse workflow-level container policy (folder-project container backend).
    // Same warn-and-ignore pattern as `worktree`. `enabled` pins the container
    // backend on without `--container`; `write_back` ('approve' | 'auto') chooses
    // whether the finished run's overlay diff pauses for review or applies directly.
    let containerPolicy: { enabled?: boolean; write_back?: 'approve' | 'auto' } | undefined;
    if (raw.container !== undefined) {
      if (
        typeof raw.container === 'object' &&
        raw.container !== null &&
        !Array.isArray(raw.container)
      ) {
        const rawContainer = raw.container as Record<string, unknown>;
        const rawEnabled = rawContainer.enabled;
        const rawWriteBack = rawContainer.write_back;
        const policy: { enabled?: boolean; write_back?: 'approve' | 'auto' } = {};
        if (typeof rawEnabled === 'boolean') {
          policy.enabled = rawEnabled;
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_container_enabled_value_ignored');
        }
        if (rawWriteBack === 'approve' || rawWriteBack === 'auto') {
          policy.write_back = rawWriteBack;
        } else if (rawWriteBack !== undefined) {
          getLog().warn(
            { filename, value: rawWriteBack },
            'invalid_container_write_back_value_ignored'
          );
        }
        if (policy.enabled !== undefined || policy.write_back !== undefined) {
          containerPolicy = policy;
        }
      } else {
        getLog().warn({ filename, value: raw.container }, 'invalid_container_block_ignored');
      }
    }

    // Parse workflow-level evidence policy (#2230). Unlike the worktree/container
    // convenience policies, a malformed block REJECTS the workflow instead of
    // warn-and-ignore: silently dropping a declared terminal-success gate would
    // let a run complete ungated — not fail-safe. Same hard-reject posture as
    // unknown-provider and persist_session capability validation above.
    let evidencePolicy: WorkflowEvidencePolicy | undefined;
    if (raw.evidence_policy !== undefined) {
      const parsedEvidence = workflowEvidencePolicySchema.safeParse(raw.evidence_policy);
      if (!parsedEvidence.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              "Invalid evidence_policy: expected { required: boolean }. When required is true, the run is refused terminal 'completed' unless the conventional marker file $ARTIFACTS_DIR/evidence.json exists; its contents are not checked.",
            errorType: 'validation_error',
          },
        };
      }
      evidencePolicy = parsedEvidence.data;
    }

    // Parse workflow-level run budget (#2814). Malformed REJECTS, like
    // evidence_policy: a misspelt or invalid ceiling must not silently mean no
    // ceiling. The strict schema rejects unknown keys, so `budget` needs no
    // KNOWN_WORKFLOW_NESTED_KEYS entry.
    let budget: WorkflowRunBudget | undefined;
    if (raw.budget !== undefined) {
      const parsedBudget = workflowRunBudgetSchema.safeParse(raw.budget);
      if (!parsedBudget.success) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Invalid budget: expected { max_work_units?: positive integer, max_spend_usd?: positive number } declaring at least one ceiling (${parsedBudget.error.issues[0]?.message ?? 'invalid value'}).`,
            errorType: 'validation_error',
          },
        };
      }
      budget = parsedBudget.data;
    }

    // Parse workflow-level deprecation marker (#2781). Like evidence_policy, a
    // malformed block REJECTS the workflow instead of warn-and-ignore: silently
    // dropping it would ship a bundled default with no removal warning at all,
    // defeating the whole deprecation window.
    let deprecated: WorkflowDeprecation | undefined;
    if (raw.deprecated !== undefined) {
      const parsedDeprecation = workflowDeprecationSchema.safeParse(raw.deprecated);
      if (!parsedDeprecation.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              'Invalid deprecated: expected { message: string } — the sentence carried in the run-start deprecation notice (#2781).',
            errorType: 'validation_error',
          },
        };
      }
      deprecated = parsedDeprecation.data;
    }

    // Parse mutates_checkout — boolean, omitted means true (run the path-lock guard).
    // Invalid non-boolean values are dropped with a warning.
    // When false, the executor skips the path-lock guard and allows concurrent runs on the same checkout.
    let mutatesCheckout: boolean | undefined;
    if (raw.mutates_checkout !== undefined) {
      if (typeof raw.mutates_checkout === 'boolean') {
        mutatesCheckout = raw.mutates_checkout;
      } else {
        getLog().warn(
          { filename, value: raw.mutates_checkout },
          'invalid_mutates_checkout_value_ignored'
        );
      }
    }

    // Parse optional tags — type-narrow, trim, and dedupe so authors can't
    // ship ["GitLab", "GitLab ", "gitlab"] as three distinct values.
    // An explicit empty array is preserved (suppresses keyword inference in the
    // UI); an absent or invalid block leaves `tags` undefined (falls back to
    // inference). Same warn-and-ignore pattern as the worktree block above.
    let tags: string[] | undefined;
    if (Array.isArray(raw.tags)) {
      tags = [
        ...new Set(
          raw.tags
            .filter((t): t is string => typeof t === 'string')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        ),
      ];
    } else if (raw.tags !== undefined) {
      getLog().warn({ filename, value: raw.tags }, 'invalid_tags_block_ignored');
    }

    // Parse optional requires — the external-capability enum list (today only
    // `github`) that hard-blocks invocation when the originating user hasn't connected
    // that identity (see assertWorkflowRequirementsMet). Same warn-and-drop policy as
    // `tags`: invalid entries are dropped with a warning; an absent/empty list leaves
    // `requires` undefined. Without this block the field is silently discarded here and
    // the capability gate can never fire for a discovered workflow.
    let requires: WorkflowRequirement[] | undefined;
    if (Array.isArray(raw.requires)) {
      const valid: WorkflowRequirement[] = [];
      for (const entry of raw.requires) {
        const parsed = workflowRequirementSchema.safeParse(entry);
        if (parsed.success) valid.push(parsed.data);
        else getLog().warn({ filename, value: entry }, 'invalid_workflow_requires_entry_ignored');
      }
      const deduped = [...new Set(valid)];
      if (deduped.length > 0) requires = deduped;
    } else if (raw.requires !== undefined) {
      getLog().warn({ filename, value: raw.requires }, 'invalid_workflow_requires_block_ignored');
    }

    // Parse optional inputs — the declared signature (#2470). Per-key warn-and-drop:
    // an invalid spec, a non-identifier name (env mangling needs identifier names), or
    // a contradictory `required: true` + `default:` pair is dropped with a warning. The
    // surviving record is set only when non-empty. Absent/invalid block leaves `inputs`
    // undefined — a workflow with no declared inputs keeps Phase-1 behaviour untouched.
    let inputs: Record<string, WorkflowInputSpec> | undefined;
    const rawInputs = raw.inputs;
    if (rawInputs !== undefined) {
      if (
        typeof rawInputs === 'object' &&
        rawInputs !== null &&
        !Array.isArray(rawInputs) &&
        (Object.getPrototypeOf(rawInputs) === Object.prototype ||
          Object.getPrototypeOf(rawInputs) === null)
      ) {
        const valid: Record<string, WorkflowInputSpec> = {};
        for (const [name, spec] of Object.entries(rawInputs as Record<string, unknown>)) {
          if (!INPUT_NAME_PATTERN.test(name)) {
            getLog().warn({ filename, name }, 'invalid_workflow_input_name_ignored');
            continue;
          }
          const parsed = workflowInputSpecSchema.safeParse(spec);
          if (!parsed.success) {
            getLog().warn({ filename, name, value: spec }, 'invalid_workflow_input_spec_ignored');
            continue;
          }
          if (parsed.data.required === true && parsed.data.default !== undefined) {
            getLog().warn(
              { filename, name },
              'contradictory_workflow_input_required_with_default_ignored'
            );
            continue;
          }
          valid[name] = parsed.data;
        }
        // Reject env-key mangling collisions: two names that fold to the same
        // INPUTS_<UPPER_SNAKE> env key would silently clobber each other for
        // bash/script sub-run nodes (Task 17). Catch it here where all names are
        // visible; a colliding pair is a hard load error, not a warn-and-drop.
        const envKeyOwners = new Map<string, string>();
        for (const name of Object.keys(valid)) {
          const envKey = inputEnvKey(name);
          const existing = envKeyOwners.get(envKey);
          if (existing !== undefined) {
            return {
              workflow: null,
              error: {
                filename,
                error: `Workflow inputs '${existing}' and '${name}' both map to env var '${envKey}' — rename one so each input has a unique env key`,
                errorType: 'validation_error',
              },
            };
          }
          envKeyOwners.set(envKey, name);
        }
        if (Object.keys(valid).length > 0) inputs = valid;
      } else {
        getLog().warn({ filename, value: rawInputs }, 'invalid_workflow_inputs_block_ignored');
      }
    }

    // Parse optional returns — the node id whose output IS this workflow's result
    // (#2470). Accept a non-empty string; reject every other present value. Silently
    // dropping an invalid selector would change the workflow result by falling back to
    // positional sink selection. The referenced id
    // must name a top-level node — checked below once dagNodes is assembled.
    let returns: string | undefined;
    if (typeof raw.returns === 'string' && raw.returns.trim().length > 0) {
      returns = raw.returns.trim();
    } else if (raw.returns !== undefined) {
      getLog().debug({ filename, value: raw.returns }, 'invalid_workflow_returns_value_rejected');
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'returns': expected the non-empty id of a top-level node whose output is this workflow's result",
          errorType: 'validation_error',
        },
      };
    }
    // `returns` must name a top-level node id. Done here (not in validateDagStructure,
    // which takes nodes and is reused for loop_group bodies / the expander with no
    // `returns` in scope) now that dagNodes is computed.
    if (returns !== undefined && !dagNodes.some(n => n.id === returns)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Workflow declares returns: '${returns}' but no top-level node has that id`,
          errorType: 'validation_error',
        },
      };
    }

    // Authored run outcome (#2618). Unlike cosmetic or provider-default fields,
    // a malformed selector cannot be dropped: doing so would silently turn a
    // declared verdict into outcome=null. The node-schema relationship is
    // validated below on the assembled workflow (and again after include
    // expansion when `returns:` names an include alias).
    let outcomeField: string | undefined;
    if (typeof raw.outcome_field === 'string' && raw.outcome_field.trim().length > 0) {
      outcomeField = raw.outcome_field.trim();
    } else if (raw.outcome_field !== undefined) {
      getLog().debug(
        { filename, value: raw.outcome_field },
        'invalid_workflow_outcome_field_value_rejected'
      );
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'outcome_field': expected a non-empty required boolean property name relative to 'returns'",
          errorType: 'validation_error',
        },
      };
    }

    // Parse workflow-level fallback fields. Same warn-and-drop pattern as
    // `modelReasoningEffort` / `webSearchMode` above. These are declared on
    // `workflowBaseSchema` and consumed by the DAG executor's
    // `workflowLevelOptions` (the object literal at the top of
    // `executeDagWorkflow`, reading `workflow.effort` etc.) as defaults that
    // per-node options inherit when unset. Without this block, a workflow YAML
    // that sets e.g. `effort: high` at the root would be dropped here and the
    // executor would read undefined, so a node without its own `effort` would
    // never inherit the workflow-level default.
    const declaredEffort = parseOptionalField(
      raw.effort,
      effortLevelSchema,
      filename,
      'invalid_workflow_effort_value_ignored',
      { valid: effortLevelSchema.options }
    );

    // Deprecated by #2556: `modelReasoningEffort:` was a second, Codex-only
    // spelling of reasoning depth. It is TRANSLATED into `effort:` here rather
    // than carried onto the workflow, so nothing downstream ever sees it.
    //
    // Translating at load time (rather than honouring it at execution time) is
    // what makes the deprecation terminal instead of indefinite: `effort:` has a
    // node-level counterpart and `modelReasoningEffort:` does not, so any pass
    // that collapses workflow-level config onto nodes — #1764's Task 1 — can
    // handle the translated form and could never have handled the original.
    //
    // Every `modelReasoningEffort` value is a valid `effort` rung, so the
    // translation is total. When both are declared, `effort:` wins and the old
    // field is dropped: the loader cannot know which nodes resolve to Codex, so
    // preserving the old field's Codex-only precedence is not expressible here.
    const effort = declaredEffort ?? modelReasoningEffort;
    if (modelReasoningEffort !== undefined) {
      const message =
        declaredEffort === undefined
          ? `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and ` +
            `has been applied as 'effort: ${modelReasoningEffort}'. NOTE: 'effort:' applies to EVERY node ` +
            'in this workflow, including non-Codex ones, where the old Codex-only field applied to none. ' +
            "Set 'effort:' per node if only some nodes should reason that deeply."
          : `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and was ` +
            `IGNORED because this workflow also declares 'effort: ${declaredEffort}', which now applies on ` +
            "every provider including Codex. Delete the 'modelReasoningEffort:' line.";
      parseWarnings.push(message);
      // Carry the prose, not just the payload, so the warning is legible on both
      // channels: the log stream, and `parseWarnings` — which `executeWorkflow`
      // persists verbatim as a `workflow_parse_warnings` event (#2213).
      getLog().debug({ filename, warning: message }, 'workflow_model_reasoning_effort_deprecated');
    }
    const sandbox = parseOptionalField(
      raw.sandbox,
      sandboxSettingsSchema,
      filename,
      'invalid_workflow_sandbox_value_ignored'
    );

    // fallbackModel: non-empty trimmed string. Inline trim rather than
    // `safeParse` so a stray surrounding space is normalised rather than rejected.
    const fallbackModelTrimmed =
      typeof raw.fallbackModel === 'string' ? raw.fallbackModel.trim() : '';
    const fallbackModel = fallbackModelTrimmed.length > 0 ? fallbackModelTrimmed : undefined;
    if (raw.fallbackModel !== undefined && fallbackModel === undefined) {
      getLog().warn(
        { filename, value: raw.fallbackModel, expected: 'non-empty string' },
        'invalid_workflow_fallback_model_value_ignored'
      );
    }

    // betas: trim, drop empties, then validate the cleaned list through
    // `betasSchema` (non-empty array of non-empty strings). An empty result
    // drops the field entirely — the Claude SDK expects a populated beta header
    // or none at all. The schema's `.nonempty()` enforces non-emptiness at
    // runtime, so the cleaned list reaches the SDK validated without a cast.
    let betas: string[] | undefined;
    if (raw.betas !== undefined) {
      const cleaned = Array.isArray(raw.betas)
        ? raw.betas
            .filter((b): b is string => typeof b === 'string')
            .map(b => b.trim())
            .filter(b => b.length > 0)
        : [];
      const betasResult = betasSchema.safeParse(cleaned);
      if (betasResult.success) {
        betas = betasResult.data;
      } else {
        getLog().warn({ filename, value: raw.betas }, 'invalid_workflow_betas_value_ignored');
      }
    }

    // Detect unknown workflow-level keys, and unknown keys inside the nested
    // workflow-level configs (#2213)
    const workflowName = raw.name;
    const workflowLabel = `Workflow '${workflowName}'`;
    for (const key of Object.keys(raw)) {
      if (key === 'interactive') continue; // deprecated, warned above
      if (!KNOWN_WORKFLOW_KEYS.has(key)) {
        const hint = KNOWN_DAG_NODE_KEYS.has(key)
          ? ` ('${key}' is valid on individual nodes, not at workflow level.)`
          : '';
        pushUnknownKeyWarning(
          workflowName,
          workflowLabel,
          key,
          hint,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
        continue;
      }
      const nested = KNOWN_WORKFLOW_NESTED_KEYS.get(key);
      if (nested) {
        collectUnknownConfigKeys(
          raw[key],
          nested,
          workflowName,
          workflowLabel,
          `${key}.`,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
      }
    }

    const workflow: WorkflowDefinition = {
      name: raw.name,
      description: raw.description,
      provider,
      model,
      // `modelReasoningEffort` is deliberately absent — it was translated into
      // `effort` above, so nothing downstream ever sees the deprecated field.
      webSearchMode,
      ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      ...(betas !== undefined ? { betas } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(workflowPersistSessions ? { persist_sessions: true } : {}),
      nodes: dagNodes,
      ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
      ...(containerPolicy ? { container: containerPolicy } : {}),
      ...(evidencePolicy !== undefined ? { evidence_policy: evidencePolicy } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(requires !== undefined ? { requires } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(returns !== undefined ? { returns } : {}),
      ...(outcomeField !== undefined ? { outcome_field: outcomeField } : {}),
      ...(deprecated !== undefined ? { deprecated } : {}),
    };
    const execInputValidation = validateInlineExecInputs(workflow, configuredEnvNames);
    parseWarnings.push(...execInputValidation.warnings);
    if (execInputValidation.errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: execInputValidation.errors.join(' '),
          errorType: 'validation_error',
        },
      };
    }
    const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
    if (outcomeDeclarationError !== null) {
      return {
        workflow: null,
        error: {
          filename,
          error: outcomeDeclarationError,
          errorType: 'validation_error',
        },
      };
    }
    const runBudgetShapeError = validateRunBudgetShape(workflow);
    if (runBudgetShapeError !== null) {
      return {
        workflow: null,
        error: { filename, error: runBudgetShapeError, errorType: 'validation_error' },
      };
    }

    return {
      workflow,
      error: null,
      warnings: parseWarnings,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    // Debug for the same reason as the validation failures above: the returned
    // parse_error is what the author sees, and discovery re-parses on every command.
    getLog().debug(
      {
        err,
        filename,
        lineInfo: lineInfo || undefined,
        contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
      },
      'workflow_parse_failed'
    );
    return {
      workflow: null,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${err.message}`,
        errorType: 'parse_error',
      },
    };
  }
}
