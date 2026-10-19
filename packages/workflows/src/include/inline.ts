import type { DagNode, IncludeDirective, ResolvedWorkflow } from '../schemas';
import { isIncludeDirective, isLoopGroupNode } from '../schemas';
import type { JsonValue } from '../output-ref';
import { validateDagStructure } from '../loader/dag-structure';
import {
  COMPOSED_NODE,
  cloneNodeWithEngineMetadata,
  type ComposedBlockBoundary,
  type ComposedNodeMeta,
  type IncludeCommandContent,
  type NodeWithComposedMeta,
} from '../compiled-command';
import { materializeBlockCommandPrompts } from './command-prompts';
import { IncludeExpansionError } from './expansion-error';
import { applyInputsMacro, resolveIncludeInputs } from './inputs-macro';
import { rewriteNodeOutputRefs } from './output-refs';

export interface ExpandedInclude {
  /** The child's nodes, deep-cloned, id-namespaced, edges + refs rewired. */
  namespaced: DagNode[];
  /** Namespaced ids of the child's sink nodes (no dependents within the child). */
  sinks: string[];
  /** First sink in child definition order — the include's `$id.output` terminal. */
  primarySink: string;
}

/**
 * Record where a node was authored, and what it was authored with. WRITE-ONCE per
 * field: the innermost workflow that inlined this node already said the true thing,
 * and an outer level re-stating it would replace one file's answer with another's.
 * `blockEntry` is the exception — it is idempotently true, and a node can legitimately
 * be the entry of two nested blocks at once. `boundaries` is cumulative: each outer
 * include prepends its own activation predicate without replacing the inner ones.
 */
function markComposedNode(node: DagNode, patch: ComposedNodeMeta): void {
  const target = node as DagNode & NodeWithComposedMeta;
  const existing = target[COMPOSED_NODE];
  if (existing === undefined) {
    target[COMPOSED_NODE] = {
      ...patch,
      ...(patch.boundaries !== undefined ? { boundaries: cloneBoundaries(patch.boundaries) } : {}),
    };
  } else {
    if (patch.blockEntry === true) existing.blockEntry = true;
    if (patch.boundaries !== undefined) {
      existing.boundaries = [...cloneBoundaries(patch.boundaries), ...(existing.boundaries ?? [])];
    }
  }
  // A loop_group body node was authored in the same file and reads the same inputs, so
  // it carries the same record — minus `blockEntry`, which is a position in the OUTER
  // graph and means nothing inside a body. A body node is likewise never the entry of an
  // enclosing outer-graph include, though it still inherits that boundary.
  if (isLoopGroupNode(node)) {
    const inherited = bodyComposedMeta(patch);
    for (const body of node.loop_group.nodes) {
      if (!isIncludeDirective(body)) markComposedNode(body, inherited);
    }
  }
}

function cloneBoundaries(boundaries: ComposedBlockBoundary[]): ComposedBlockBoundary[] {
  return boundaries.map(boundary => structuredClone(boundary));
}

/** The record a loop_group body node inherits from its group's. */
function bodyComposedMeta(patch: ComposedNodeMeta): ComposedNodeMeta {
  return {
    origin: patch.origin,
    ...(patch.inputs !== undefined ? { inputs: patch.inputs } : {}),
    ...(patch.boundaries !== undefined ? { boundaries: patch.boundaries.map(bodyBoundary) } : {}),
  };
}

function bodyBoundary(boundary: ComposedBlockBoundary): ComposedBlockBoundary {
  const clone = structuredClone(boundary);
  if (!clone.isEntry) return clone;
  return {
    dependsOn: clone.dependsOn,
    entryTriggerRules: clone.entryTriggerRules,
    ...(clone.when !== undefined ? { when: clone.when } : {}),
    isEntry: false,
  };
}

/** What every node of one include instance is inlined with. */
interface InlineScope {
  includeNode: IncludeDirective;
  child: ResolvedWorkflow;
  commandContents: ReadonlyMap<string, IncludeCommandContent>;
  prefix: string;
  childTopLevelIds: ReadonlySet<string>;
  rename: (id: string) => string;
  parentDeps: string[];
  entryTriggerRules: ComposedBlockBoundary['entryTriggerRules'];
  hasActivationBoundary: boolean;
  resolvedInputs: Record<string, JsonValue>;
  missingInputs: Set<string>;
}

/**
 * Inline one include node's fully-expanded child into namespaced parent nodes.
 * Never mutates the child's nodes (each node is deep-cloned first), so a building block
 * shared by two parents is namespaced independently.
 */
function inlineInclude(
  includeNode: IncludeDirective,
  child: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent>
): ExpandedInclude {
  // Prove the child's lexical boundary before its nodes share the parent's flat id/output
  // maps. Discovery already parsed each file independently; this repeat is intentional so
  // direct/programmatic callers of the pure expander cannot bypass the same invariant.
  const childStructureError = validateDagStructure(child.nodes);
  if (childStructureError !== null) {
    throw new IncludeExpansionError(
      `Node '${includeNode.id}': included workflow '${child.name}' is not hermetic: ${childStructureError}`
    );
  }
  const scope = inlineScope(includeNode, child, commandContents);
  const namespaced = child.nodes.map(cn => inlineChildNode(scope, cn));

  if (scope.missingInputs.size > 0) {
    const names = [...scope.missingInputs].sort().map(name => `$INPUTS.${name}`);
    throw new IncludeExpansionError(
      `Node '${includeNode.id}': included block '${includeNode.include}' references missing input${names.length === 1 ? '' : 's'} ${names.join(', ')}. Pass ${names.length === 1 ? 'it' : 'them'} through 'with:'.`
    );
  }

  const sinkOriginalIds = child.plan.sinks;
  return {
    namespaced,
    sinks: sinkOriginalIds.map(id => scope.prefix + id),
    // `$blk.output` resolves to the block's declared `returns:` node when set (#2470) —
    // even a NON-sink node — otherwise the first sink in definition order. `returns:`
    // was validated at load to name a top-level child node, so `prefix + returns` is a
    // real namespaced id. Only `primarySink` moves; `sinks` (and thus `depends_on:[blk]`)
    // still covers every terminal node.
    // A valid non-empty DAG always has ≥1 sink; sinkOriginalIds[0] is defined.
    primarySink: scope.prefix + (child.returns ?? sinkOriginalIds[0] ?? ''),
  };
}

function inlineScope(
  includeNode: IncludeDirective,
  child: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent>
): InlineScope {
  const prefix = `${includeNode.id}__`;
  const childTopLevelIds = new Set(child.nodes.map(n => n.id));
  const parentDeps = includeNode.depends_on ?? [];
  const [firstEntryTriggerRule, ...remainingEntryTriggerRules] = child.nodes
    .filter(node => (node.depends_on ?? []).length === 0)
    .map(node => node.trigger_rule ?? includeNode.trigger_rule ?? 'all_success');
  if (firstEntryTriggerRule === undefined) {
    throw new IncludeExpansionError(
      `Node '${includeNode.id}': included workflow '${child.name}' has no entry node`
    );
  }
  return {
    includeNode,
    child,
    commandContents,
    prefix,
    childTopLevelIds,
    rename: id => (childTopLevelIds.has(id) ? prefix + id : id),
    parentDeps,
    entryTriggerRules: [firstEntryTriggerRule, ...remainingEntryTriggerRules],
    hasActivationBoundary: parentDeps.length > 0 || includeNode.when !== undefined,
    resolvedInputs: resolveIncludeInputs(includeNode, child),
    missingInputs: new Set<string>(),
  };
}

function inlineChildNode(scope: InlineScope, cn: DagNode): DagNode {
  const { includeNode, rename } = scope;
  const clone = materializeBlockCommandPrompts(
    cloneNodeWithEngineMetadata(cn),
    includeNode,
    scope.child,
    scope.commandContents,
    scope.childTopLevelIds,
    new Set<string>(),
    cn.id
  );
  const wasEntry = (cn.depends_on ?? []).length === 0;

  // Rewrite child-internal refs before inserting caller values. This ordering is
  // load-bearing: a caller ref such as `$gather.output` must remain parent-scoped even
  // when the included block also has a node named `gather`.
  rewriteNodeOutputRefs(clone, rename, id => [rename(id)], rename);
  applyInputsMacro(clone, scope.resolvedInputs, scope.missingInputs, includeNode);
  // Stamped AFTER both passes, for the same reason the caller's values are inserted
  // after the rename: these are the CALLER's strings, so they stay parent-scoped here
  // and are walked by the next level out, not by this one. Each node gets its own copy
  // so one node's rewrite cannot reach another's.
  markComposedNode(clone, composedMeta(scope, cn, wasEntry));
  clone.id = scope.prefix + cn.id;

  if (wasEntry) attachIncludeGate(scope, clone, cn);
  else clone.depends_on = (cn.depends_on ?? []).map(rename);
  return clone;
}

function composedMeta(scope: InlineScope, cn: DagNode, wasEntry: boolean): ComposedNodeMeta {
  const { resolvedInputs } = scope;
  return {
    origin: scope.child.name,
    ...(Object.keys(resolvedInputs).length > 0 ? { inputs: { ...resolvedInputs } } : {}),
    ...(wasEntry ? { blockEntry: true as const } : {}),
    ...(scope.hasActivationBoundary ? { boundaries: [blockBoundary(scope, cn, wasEntry)] } : {}),
  };
}

function blockBoundary(scope: InlineScope, cn: DagNode, wasEntry: boolean): ComposedBlockBoundary {
  const { includeNode, parentDeps } = scope;
  const [firstEntryTriggerRule, ...remainingEntryTriggerRules] = scope.entryTriggerRules;
  return wasEntry
    ? {
        dependsOn: [...parentDeps],
        entryTriggerRules: [firstEntryTriggerRule, ...remainingEntryTriggerRules],
        ...(includeNode.when !== undefined ? { when: includeNode.when } : {}),
        isEntry: true,
        entryTriggerRule: cn.trigger_rule ?? includeNode.trigger_rule ?? 'all_success',
      }
    : {
        dependsOn: [...parentDeps],
        entryTriggerRules: [firstEntryTriggerRule, ...remainingEntryTriggerRules],
        ...(includeNode.when !== undefined ? { when: includeNode.when } : {}),
        isEntry: false,
      };
}

/** Entry node: the include node's upstream deps and gate attach here. */
function attachIncludeGate(scope: InlineScope, clone: DagNode, cn: DagNode): void {
  const { includeNode, parentDeps } = scope;
  if (parentDeps.length > 0) clone.depends_on = [...parentDeps];

  // The include node's `when:` gates the WHOLE block, so it must apply to every entry
  // node. When the entry already declares its own `when:`, combine them with `&&` so the
  // include gate is NOT silently discarded (which would let the parent gate be bypassed).
  // The `when:` grammar has no parentheses and `&&` binds tighter than `||`
  // (condition-evaluator.ts), so `A && B` only preserves `(A) && (B)` when NEITHER side
  // uses `||`. If either does, fail the expansion — a silently wrong precedence is worse
  // than a clear load error telling the author to restructure.
  if (includeNode.when !== undefined) {
    if (clone.when === undefined) {
      clone.when = includeNode.when;
    } else if (includeNode.when.includes('||') || clone.when.includes('||')) {
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': cannot combine the include's when ('${includeNode.when}') with entry node '${cn.id}' own when ('${clone.when}') because one side uses '||'. The when: grammar has no parentheses and '&&' binds tighter than '||', so combining would change precedence — put the gate only on the include node, or gate inside the block.`
      );
    } else {
      clone.when = `${includeNode.when} && ${clone.when}`;
    }
  }

  // trigger_rule is a join enum, not a boolean expression — it cannot be combined; the
  // entry node's own value wins when present, otherwise the include node's applies.
  if (includeNode.trigger_rule !== undefined && clone.trigger_rule === undefined) {
    clone.trigger_rule = includeNode.trigger_rule;
  }
}

/**
 * Instantiate one already-resolved block through the ordinary include primitive.
 * Deferred-width composition resolves and validates the block closure once at load,
 * then calls this narrow operation for each runtime item without rediscovering or
 * recompiling the workflow graph.
 */
export function instantiateResolvedInclude(
  includeNode: IncludeDirective,
  child: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent> = new Map()
): ExpandedInclude {
  return inlineInclude(includeNode, child, commandContents);
}
