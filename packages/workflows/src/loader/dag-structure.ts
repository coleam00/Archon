import type {
  AgentNode,
  DagNode,
  GateNode,
  IncludeDirective,
  WaitNode,
  WorkflowNode,
} from '../schemas';
import {
  canSuspend,
  isExecNode,
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  loopGroupSoleTerminalSink,
  isGateNode,
  isWaitNode,
  isWorkflowNode,
  isIncludeDirective,
  isComposeFanOutNode,
  isNodeContextResume,
} from '../schemas';
import { COMPOSE_FAN_OUT_STEP_MARKER } from '../fan-out-identity';
import { isBindingDirective } from '../schemas/dag-node';
import { WHEN_INPUTS_SCOPE } from '../when-atom';
import {
  EXECUTION_CHECKOUT_REF_SOURCE,
  OUTPUT_REF_SOURCE,
  parseWholeExecutionCheckoutRef,
  parseWholeOutputRef,
} from '../output-ref';
import { readComposedBindings } from '../compiled-command';
import { checkNodeReferences, type DagScope } from './dag-references';

type NodeCheck = (node: DagNode | IncludeDirective, scope: DagScope) => string | null;

interface BindingRead {
  readonly producerIds: readonly string[];
  readonly readsExecution: boolean;
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
 *
 * The checks run in a fixed order and the first error wins, so a graph with two problems
 * always reports the same one.
 */
export function validateDagStructure(
  nodes: readonly (DagNode | IncludeDirective)[],
  enclosingNodes?: ReadonlyMap<string, DagNode | IncludeDirective>,
  includeAliases?: ReadonlyMap<string, string>,
  eligibleResumeSources?: ReadonlyMap<string, DagNode | IncludeDirective>
): string | null {
  const nodesById = indexNodeIds(nodes, enclosingNodes);
  if (typeof nodesById === 'string') return nodesById;
  const dependsOnError = checkDependsOn(nodes, nodesById);
  if (dependsOnError !== null) return dependsOnError;
  const layers = topologicalLayers(nodes);
  if (typeof layers === 'string') return layers;
  const scope: DagScope = {
    nodes,
    nodesById,
    enclosingNodes,
    includeAliases,
    eligibleResumeSources,
    transitiveDepsOf: transitiveDepsLookup(nodes),
  };
  return (
    checkSharedContextLayers(layers, nodesById, enclosingNodes !== undefined) ??
    checkSuspensionOrdering(nodes, scope.transitiveDepsOf) ??
    firstError(scope, checkNodeReferences) ??
    firstError(scope, checkResumeAncestry) ??
    firstError(scope, checkFanOutItems) ??
    firstError(scope, checkBindings) ??
    firstError(scope, checkLoopGroupBody)
  );
}

function firstError(scope: DagScope, check: NodeCheck): string | null {
  for (const node of scope.nodes) {
    const error = check(node, scope);
    if (error !== null) return error;
  }
  return null;
}

/** Nodes by id, or the error for the first duplicate, shadowing or reserved id. */
function indexNodeIds(
  nodes: readonly (DagNode | IncludeDirective)[],
  enclosingNodes: ReadonlyMap<string, DagNode | IncludeDirective> | undefined
): Map<string, DagNode | IncludeDirective> | string {
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
  return nodesById;
}

function checkDependsOn(
  nodes: readonly (DagNode | IncludeDirective)[],
  nodesById: ReadonlyMap<string, DagNode | IncludeDirective>
): string | null {
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!nodesById.has(dep)) {
        return `Node '${node.id}' depends_on unknown node '${dep}'`;
      }
    }
  }
  return null;
}

function dependencyEdges(nodes: readonly (DagNode | IncludeDirective)[]): {
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
} {
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
  return { inDegree, dependents };
}

/** The ready sets of Kahn's algorithm in execution order, or the cycle error. */
function topologicalLayers(nodes: readonly (DagNode | IncludeDirective)[]): string[][] | string {
  const { inDegree, dependents } = dependencyEdges(nodes);
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
  return layers;
}

/**
 * Scalar `shared` inherits one ambient sequential cursor. A multi-node ready set is
 * the executor's exact definition of a parallel layer; it clears that cursor before
 * evaluating `when:` or dispatching either sibling. Reject the otherwise silent no-op
 * here, while the graph is still being loaded. Explicit named resume owns deliberate
 * parallel ancestry (#2099/#2643).
 */
function checkSharedContextLayers(
  layers: readonly string[][],
  nodesById: ReadonlyMap<string, DagNode | IncludeDirective>,
  insideLoopGroup: boolean
): string | null {
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
    if (insideLoopGroup) {
      return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel loop_group body. Scalar 'shared' only inherits the ambient session in sequential layers. Serialize the body nodes with 'depends_on' or use fresh context; use context: { resume: <pre-loop-node-id> } for a private owner session`;
    }
    return `Node '${sharedNode.id}' uses scalar context: 'shared' in a structurally parallel layer. Scalar 'shared' only inherits the ambient session in sequential layers. Use 'context: { resume: <upstream-node-id> }' to fork an exact upstream session, or serialize the nodes with 'depends_on'`;
  }
  return null;
}

function transitiveDepsLookup(
  nodes: readonly (DagNode | IncludeDirective)[]
): (nodeId: string) => Set<string> {
  const directDeps = new Map<string, string[]>(nodes.map(n => [n.id, n.depends_on ?? []]));
  return (nodeId: string): Set<string> => {
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
}

function hasDurableWait(node: DagNode | IncludeDirective): boolean {
  if (isIncludeDirective(node)) return false;
  if (isWaitNode(node)) return true;
  return isLoopGroupNode(node) && node.loop_group.nodes.some(hasDurableWait);
}

function checkSuspensionOrdering(
  nodes: readonly (DagNode | IncludeDirective)[],
  transitiveDepsOf: (nodeId: string) => Set<string>
): string | null {
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
  return null;
}

/**
 * A same-scope source must be transitively upstream within the scope; an enclosing source
 * is proven at group entry, separately from output visibility.
 */
function checkResumeAncestry(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  if (isIncludeDirective(node)) return null;
  if (!isNodeContextResume(node.context)) return null;
  const { nodesById, enclosingNodes, eligibleResumeSources } = scope;
  const sourceId = node.context.resume;
  const source = nodesById.get(sourceId) ?? eligibleResumeSources?.get(sourceId);
  if (source === undefined && enclosingNodes?.has(sourceId)) {
    return `Node '${node.id}' context.resume source '${sourceId}' is not an upstream dependency of the loop_group`;
  }
  if (source === undefined) {
    return `Node '${node.id}' context.resume references unknown node '${sourceId}'`;
  }
  if (isIncludeDirective(source) || !(isAgentNode(source) || isLoopNode(source))) {
    return `Node '${node.id}' context.resume source '${sourceId}' is not a session-producing command, prompt, or loop node`;
  }
  if (nodesById.has(sourceId) && !scope.transitiveDepsOf(node.id).has(sourceId)) {
    return `Node '${node.id}' context.resume source '${sourceId}' is not an upstream dependency`;
  }
  return null;
}

/**
 * fan_out.items (slice 2, PR-C) must reference the output of a node that is a
 * TRANSITIVE dependency of the fan-out node — so the item array is guaranteed
 * produced before the node expands. A same-layer or downstream producer would race
 * (the ref resolves to nothing → the node fails closed at run time); catch it at
 * load time with an actionable message instead. A literal `items` with no `$…output`
 * ref is left to the runtime fail-closed check (it must still parse to an array).
 */
function checkFanOutItems(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  if (
    isIncludeDirective(node) ||
    !(isWorkflowNode(node) || isComposeFanOutNode(node)) ||
    !node.fan_out
  )
    return null;
  const refMatch = new RegExp(OUTPUT_REF_SOURCE).exec(node.fan_out.items);
  const producerId = refMatch?.[1];
  if (producerId === undefined) return null; // no ref surface — runtime fail-closed owns it
  if (!scope.transitiveDepsOf(node.id).has(producerId)) {
    return `Node '${node.id}' fan_out.items references '$${producerId}.output', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its item array is produced first`;
  }
  return null;
}

/**
 * Node-local bindings (#2637) must read UPSTREAM producers, mirroring fan_out.items:
 * depends_on is what guarantees a bound producer is terminal before the consumer
 * runs, so binding resolution needs no new scheduling. Only same-scope producers are
 * enforced — a loop_group body node may read the enclosing scope, whose outputs are
 * settled before the group starts (existing body-ref semantics).
 *
 * A composed command node is scanned through the payload its bindings moved to when
 * expansion compiled its body (#2964). This run over the FLATTENED graph is the only
 * one that can see a caller ref forwarded into a binding through `with:` — the child
 * was proven before that value was inserted, so a ref naming a parent node outside the
 * block's dependencies would otherwise reach the executor and fail the node mid-run.
 */
function checkBindings(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  // Capture before narrowing: the include guard below would otherwise filter a
  // compose_fan_out node out of the binding check entirely.
  const composeFanOut = isComposeFanOutNode(node) ? node : undefined;
  if (isIncludeDirective(node)) return null;
  if (isWorkflowNode(node)) return workflowNodeBindingError(node);
  const nodeWith = isExecNode(node)
    ? node.with
    : isAgentNode(node)
      ? agentNodeBindings(node)
      : composeFanOut?.with;
  if (nodeWith === undefined) return null;
  for (const [name, value] of Object.entries(nodeWith)) {
    const error = bindingOrderError(node, name, value, scope);
    if (error !== null) return error;
  }
  return null;
}

function agentNodeBindings(node: AgentNode) {
  return node.source.kind === 'command' ? node.source.with : readComposedBindings(node);
}

function bindingOrderError(
  node: DagNode | IncludeDirective,
  name: string,
  value: unknown,
  scope: DagScope
): string | null {
  const read = bindingProducerIds(node, name, value, scope);
  if (typeof read === 'string') return read;
  for (const producerId of read.producerIds) {
    if (!scope.nodesById.has(producerId)) continue; // enclosing scope, or already rejected above
    if (!scope.transitiveDepsOf(node.id).has(producerId)) {
      return `Node '${node.id}' binding 'with.${name}' references '$${producerId}.${read.readsExecution ? 'execution.checkoutStart' : 'output'}', which is not an upstream dependency — add '${producerId}' to '${node.id}'.depends_on so its value is produced first`;
    }
  }
  return null;
}

/**
 * A child run's inputs resolve through the launch path, which has no execution
 * records to read; forwarding the reference would hand the child a literal string.
 */
function workflowNodeBindingError(node: WorkflowNode): string | null {
  const misuse = Object.entries(node.with ?? {}).find(
    ([, value]) =>
      typeof value === 'string' && new RegExp(EXECUTION_CHECKOUT_REF_SOURCE).test(value)
  );
  if (misuse) {
    return `Node '${node.id}' binding 'with.${misuse[0]}' reads '$<node>.execution.checkoutStart', which a workflow: node cannot pass to its child run; only a command or script node's binding can read it`;
  }
  return null;
}

/** The producers a binding value reads, or the error for a misused checkout-start read. */
function bindingProducerIds(
  node: DagNode | IncludeDirective,
  name: string,
  value: unknown,
  scope: DagScope
): BindingRead | string {
  if (typeof value === 'string' && new RegExp(EXECUTION_CHECKOUT_REF_SOURCE).test(value)) {
    return checkoutStartRead(node, name, value, scope);
  }
  const producerIds: string[] = [];
  if (typeof value === 'string') {
    const refPattern = new RegExp(OUTPUT_REF_SOURCE, 'g');
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refPattern.exec(value)) !== null) {
      if (refMatch[1] !== WHEN_INPUTS_SCOPE) producerIds.push(refMatch[1]);
    }
  } else if (isBindingDirective(value)) {
    const ref = parseWholeOutputRef(value.from);
    if (ref !== undefined) producerIds.push(ref.nodeId);
  }
  return { producerIds, readsExecution: false };
}

/** The producer a whole-value `$<node>.execution.checkoutStart` binding reads, or its misuse error. */
function checkoutStartRead(
  node: DagNode | IncludeDirective,
  name: string,
  value: string,
  scope: DagScope
): BindingRead | string {
  const producerId = parseWholeExecutionCheckoutRef(value);
  if (isComposeFanOutNode(node)) {
    return `Node '${node.id}' binding 'with.${name}' reads '$<node>.execution.checkoutStart', which a composed fan-out cannot pass to its instances; only a command or script node's binding can read it`;
  }
  if (producerId === undefined) {
    return `Node '${node.id}' binding 'with.${name}' uses '$<node>.execution.checkoutStart' inside other text; it is only valid as the whole value of a command or script node's binding`;
  }
  const producer = scope.nodesById.get(producerId) ?? scope.enclosingNodes?.get(producerId);
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
  return { producerIds: [producerId], readsExecution: true };
}

/**
 * Recursively validate loop_group bodies as scoped sub-DAGs. A loop_group body is
 * sealed for GRAPH edges: its depends_on edges resolve within the body (not the
 * outer DAG), and the body is itself a DAG (unique ids, no cycles). $nodeId.output
 * refs are wider — the accumulated enclosing-scope ids are passed down so body
 * prompts may reference outer nodes (mirrors the executor seeding the scoped output
 * map with outer outputs). Nested loop_groups recurse naturally, accumulating scope.
 * Outer-DAG cycle/depends_on checks above operate on the flattened top-level node
 * list and treat each loop_group as one outer node.
 */
function checkLoopGroupBody(node: DagNode | IncludeDirective, scope: DagScope): string | null {
  if (isIncludeDirective(node) || !isLoopGroupNode(node)) return null;
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
  const { nodesById, enclosingNodes } = scope;
  const scopeNodes = new Map<string, DagNode | IncludeDirective>([
    ...(enclosingNodes ?? []),
    ...nodesById,
  ]);
  const eligible = new Map(scope.eligibleResumeSources);
  for (const id of scope.transitiveDepsOf(node.id)) {
    const ancestor = nodesById.get(id);
    if (ancestor !== undefined) eligible.set(id, ancestor);
  }
  const bodyError = validateDagStructure(
    node.loop_group.nodes,
    scopeNodes,
    scope.includeAliases,
    eligible
  );
  if (bodyError) {
    return `loop_group '${node.id}' body: ${bodyError}`;
  }
  return null;
}
