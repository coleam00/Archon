import type { DagNode, GateNode, IncludeDirective, WaitNode } from '../schemas';
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
  isNodeContextResume,
} from '../schemas';
import { COMPOSE_FAN_OUT_STEP_MARKER } from '../fan-out-identity';
import { attentionOptionSchema, isBindingDirective } from '../schemas/dag-node';
import {
  findUnsupportedNestedWhenRef,
  assertSupportedWhenOutputRefs,
  parseWhenExpression,
  splitOutsideQuotes,
  WHEN_INPUTS_SCOPE,
} from '../when-atom';
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
} from '../output-ref';
import { readComposedBindings } from '../compiled-command';
import { visitNodeTemplateSlots, type TemplateSurface } from '../template-walker';
import { z } from 'zod';

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
