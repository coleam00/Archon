/**
 * Load-time workflow inlining (`include:`) — the deterministic expansion engine.
 *
 * After discovery has assembled the full name→workflow map (bundled < global <
 * project precedence already applied), this module walks every workflow and
 * replaces each `include: <target>` node with the target workflow's nodes,
 * inlined as a flattened, namespaced sub-DAG:
 *
 *   - each included node `n` becomes a top-level node with id `<includeId>__<n.id>`
 *   - the included nodes' internal `depends_on` and `$id.output` refs are rewired
 *     to the namespaced ids
 *   - the include node's own `depends_on`/`when`/`trigger_rule` attach to the
 *     sub-DAG's ENTRY nodes (those with no internal upstream)
 *   - other parent nodes that referenced the include id resolve `depends_on: [I]`
 *     to the sub-DAG's SINKS and `$I.output` to its PRIMARY sink. The primary sink is
 *     the block's declared `returns:` node when it sets one (#2470) — which may be a
 *     NON-sink node — otherwise the first sink in definition order. `returns:` moves
 *     ONLY the primary sink; `depends_on: [I]` still waits on every sink. (loop_group's
 *     own first-sink terminal rule is deliberately unchanged.)
 *
 * Targets are resolved recursively (a target may itself `include:` others),
 * depth-capped and cycle-detected. Because expansion runs BEFORE any
 * WorkflowDefinition reaches the executor, the executor receives a flat DAG with no
 * include nodes. Included command-backed loops additionally carry symbol-keyed compiled
 * prompt/error metadata so a resumed run can prefer its persisted prompt snapshot even
 * when the source command has disappeared. Every execution path re-discovers → re-expands
 * deterministically, so resume matches the persisted namespaced step names byte-for-byte.
 *
 * Delimiter note: the namespace joiner is `__` (double underscore), NOT `.`. The
 * output-ref substitution regex forbids dots in a node id, so a dotted id would
 * silently break every rewritten `$id.output` reference. `__` is inside the legal
 * id character class, so `$review__scope.output` substitutes correctly.
 *
 * This module owns the recursion over workflows and node lists. The phases it applies live
 * in `include/`: inlining one include (`inline.ts`), the `$INPUTS` macro (`inputs-macro.ts`),
 * output-ref rewriting (`output-refs.ts`), compiling block command bodies
 * (`command-prompts.ts`), collapsing workflow-level node config (`workflow-scope.ts`), and
 * the composed fan-out suspension proof (`suspension.ts`).
 */
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  DagNode,
  IncludeDirective,
  WorkflowRequirement,
  ResolvedWorkflow,
  ComposeFanOutNode,
  LoopGroupNode,
} from './schemas';
import { findWorkflowLoadError } from './schemas/workflow';
import { isIncludeDirective, isLoopGroupNode, isComposeFanOutNode } from './schemas';
import { validateDagStructure } from './loader/dag-structure';
import {
  validateLoopGroupProseCompletion,
  validateRunBudgetShape,
  validateWorkflowOutcomeDeclaration,
} from './loader/contracts';
import { resolveWorkflow } from './graph-plan';
import type { IncludeCommandContent } from './compiled-command';
import { IncludeExpansionError } from './include/expansion-error';
import { instantiateResolvedInclude, type ExpandedInclude } from './include/inline';
import {
  applyOutputRefRename,
  attachIncludeOutputAliases,
  rewriteNodeOutputRefs,
} from './include/output-refs';
import { collectComposedSuspensionPaths } from './include/suspension';
import { collapseWorkflowScope, warnDroppedWorkflowLevelFields } from './include/workflow-scope';

/**
 * Maximum include-nesting depth — chains up to this many include levels are allowed; a
 * deeper chain is a load error (guards against accidental deep/runaway recursion). Depth 1
 * (an includer → a building block) is the common case; the cap leaves generous room. The
 * depth check below uses `>` (not `>=`) so exactly INCLUDE_MAX_DEPTH levels are permitted,
 * matching the "up to 3 levels deep" contract in the workflow language reference.
 */
export const INCLUDE_MAX_DEPTH = 3;

/** One `expandWorkflowIncludes` call: its inputs and the workflows expanded so far. */
interface IncludeExpansion {
  rawByName: Map<string, WorkflowDefinition>;
  commandContents: ReadonlyMap<string, IncludeCommandContent>;
  loadErrors: readonly WorkflowLoadError[];
  memo: Map<string, ResolvedWorkflow>;
}

interface ExpandedNodeList {
  nodes: DagNode[];
  includedRequirements: WorkflowRequirement[];
  renameIncludeRef: (id: string) => string;
  /** Rewritten `$<alias>.output` producer id → the include alias the author wrote. */
  includeAliases: Map<string, string>;
}

/** One node list mid-expansion. */
interface NodeListExpansion {
  expandedNodes: DagNode[];
  includesById: Map<string, ExpandedInclude>;
  includedRequirements: WorkflowRequirement[];
  includeAliases: Map<string, string>;
}

/**
 * Expand every workflow's `include:` nodes into flattened, namespaced sub-DAGs.
 *
 * Input is keyed by workflow NAME (higher-scope files have already overridden lower
 * ones by filename in discovery). Output workflows contain ZERO include nodes.
 * Errors are per-workflow: a workflow that fails to expand (unknown target, cycle,
 * depth, id collision, invalid flattened structure, command-file cross-ref) is dropped
 * from the output and an error is recorded — other workflows still expand.
 *
 * `commandContents` maps command NAME → file content, null when no candidate resolves, or a
 * path-bearing error when a higher-precedence scope cannot be inspected or a matched file
 * cannot be read. Discovery pre-resolves every include-target command with
 * execution-equivalent precedence and never falls through after either error. A caller that
 * omits the map may still expand workflows without commands. Included command nodes fail
 * composition; included loop commands fail before a fresh AI turn but remain discoverable
 * so an already-paused loop can resume from its persisted read-once snapshot.
 */
export function expandWorkflowIncludes(
  rawByName: Map<string, WorkflowDefinition>,
  commandContents?: ReadonlyMap<string, IncludeCommandContent>,
  loadErrors: readonly WorkflowLoadError[] = []
): {
  workflows: Map<string, ResolvedWorkflow>;
  errors: WorkflowLoadError[];
} {
  const expansion: IncludeExpansion = {
    rawByName,
    commandContents: commandContents ?? new Map(),
    loadErrors,
    memo: new Map(),
  };
  const failed = new Set<string>();
  const errors: WorkflowLoadError[] = [];

  for (const name of rawByName.keys()) {
    if (expansion.memo.has(name)) continue; // already expanded as a dependency of an earlier workflow
    const error = expandRoot(expansion, name);
    if (error === undefined) continue;
    failed.add(name);
    errors.push(error);
  }

  const workflows = new Map<string, ResolvedWorkflow>();
  for (const name of rawByName.keys()) {
    if (failed.has(name)) continue;
    const expanded = expansion.memo.get(name);
    if (expanded) workflows.set(name, expanded);
  }
  return { workflows, errors };
}

/** Expand one top-level workflow; an expansion failure drops it, and only it. */
function expandRoot(expansion: IncludeExpansion, name: string): WorkflowLoadError | undefined {
  try {
    expandOne(expansion, name, []);
    return undefined;
  } catch (e) {
    if (!(e instanceof IncludeExpansionError)) throw e;
    return {
      filename: name,
      error: e.message,
      errorType: e.errorType,
      ...(e.cause !== undefined ? { cause: e.cause } : {}),
    };
  }
}

function expandOne(expansion: IncludeExpansion, name: string, stack: string[]): ResolvedWorkflow {
  // Cycle + depth are checked BEFORE the memo so a node memoized via a shallow path
  // can never mask a too-deep or cyclic reference reaching it via a longer path.
  if (stack.includes(name)) {
    throw new IncludeExpansionError(`include cycle detected: ${[...stack, name].join(' -> ')}`);
  }
  if (stack.length > INCLUDE_MAX_DEPTH) {
    throw new IncludeExpansionError(
      `include depth limit exceeded (max ${String(INCLUDE_MAX_DEPTH)} levels): ${[...stack, name].join(' -> ')}`
    );
  }

  const cached = expansion.memo.get(name);
  if (cached) return cached;

  const raw = expansion.rawByName.get(name);
  // Top-level names always exist (they come from rawByName.keys()); this only
  // fires when the name was reached as an unresolvable include TARGET.
  if (!raw) throw missingTargetError(expansion.loadErrors, name);

  // Collapse this workflow's own node-affecting scope onto its own nodes BEFORE
  // anything is inlined, so each node carries what its AUTHOR declared and the
  // workflow-level layer is gone by the time a parent's could reach it. This replaces
  // the old byte-for-byte fast path for include-free workflows — every workflow is
  // cloned now, deliberately: the alternative is a workflow that behaves differently
  // depending on whether it happens to contain an `include:`.
  const collapsed = collapseWorkflowScope(raw);
  // Capability requirements union UPWARD (#1764): a composed workflow's `requires:` is
  // a fact about what its nodes need, not a choice the composing run makes. Dropping it
  // turned a clean pre-cost refusal into a mid-run failure inside a block the parent
  // cannot inspect. A union can only make a run refuse EARLIER.
  const expanded = expandNodeList(expansion, collapsed.nodes, name, stack);
  const requires: WorkflowRequirement[] = [
    ...(collapsed.requires ?? []),
    ...expanded.includedRequirements,
  ];

  // Re-validate the fully-flattened DAG. Catches a namespaced id colliding with a
  // hand-written node, cycles introduced by edge rewiring, unknown deps, and the
  // equivalent failures inside every recursively expanded loop_group body.
  const structureError =
    validateDagStructure(expanded.nodes, undefined, expanded.includeAliases) ||
    validateLoopGroupProseCompletion(expanded.nodes);
  if (structureError) {
    throw new IncludeExpansionError(structureError);
  }

  const dedupedRequires = [...new Set(requires)];
  const authoredResult: WorkflowDefinition = {
    ...collapsed,
    nodes: expanded.nodes,
    // `returns:` may name an include directive that no longer exists after flattening.
    // Rebind it to the same primary sink used for `$includeId.output`; ordinary node ids
    // pass through unchanged. Without this, a nested reusable workflow can finish with a
    // dangling return id even though every node-level reference was rewritten correctly.
    ...(collapsed.returns !== undefined
      ? { returns: expanded.renameIncludeRef(collapsed.returns) }
      : {}),
    ...(dedupedRequires.length > 0 ? { requires: dedupedRequires } : {}),
  };
  const contractError =
    validateWorkflowOutcomeDeclaration(authoredResult) ?? validateRunBudgetShape(authoredResult);
  if (contractError !== null) {
    throw new IncludeExpansionError(contractError);
  }
  const result = resolveWorkflow(authoredResult);
  expansion.memo.set(name, result);
  return result;
}

/**
 * An unresolvable include target. An unreadable declaration has no known workflow name.
 * Until every declaration is readable, a missing include cannot be distinguished from that
 * read failure.
 */
function missingTargetError(
  loadErrors: readonly WorkflowLoadError[],
  name: string
): IncludeExpansionError {
  const named = findWorkflowLoadError(loadErrors, name);
  const unreadable =
    named ??
    loadErrors.find(
      error =>
        error.workflowName === undefined &&
        error.errorType === 'read_error' &&
        error.cause !== undefined
    );
  const missing = `include target '${name}' not found`;
  return new IncludeExpansionError(
    named?.error ??
      (unreadable === undefined
        ? missing
        : `${missing}; it may be declared in an unreadable source (${unreadable.filename}: ${unreadable.error})`),
    unreadable?.errorType,
    { cause: unreadable?.cause }
  );
}

/**
 * Expand one statically scoped node list. The workflow's top-level DAG and every
 * loop_group body each own an independent include-id namespace: dependencies and
 * `$include.output` refs bind only to directives in that list.
 */
function expandNodeList(
  expansion: IncludeExpansion,
  nodes: (DagNode | IncludeDirective)[],
  workflowName: string,
  stack: string[]
): ExpandedNodeList {
  const list: NodeListExpansion = {
    expandedNodes: [],
    includesById: new Map(),
    includedRequirements: [],
    includeAliases: new Map(),
  };

  for (const node of nodes) {
    if (isComposeFanOutNode(node)) {
      expandComposeFanOut(expansion, list, node, [...stack, workflowName]);
    } else if (isIncludeDirective(node)) {
      expandIncludeDirective(expansion, list, node, [...stack, workflowName]);
    } else if (isLoopGroupNode(node)) {
      expandLoopGroupBody(expansion, list, node, workflowName, stack);
    } else {
      // Already a private clone — `collapseWorkflowScope` cloned every node before
      // writing this workflow's config onto it, so the second pass below can mutate
      // it without reaching the raw parsed definition discovery still holds.
      list.expandedNodes.push(node);
    }
  }
  return bindIncludeRefs(list);
}

/** Expand an include target, naming the node that reached it in any expansion error. */
function expandTarget(
  expansion: IncludeExpansion,
  node: { id: string; include: string },
  stack: string[]
): ResolvedWorkflow {
  try {
    return expandOne(expansion, node.include, stack);
  } catch (e) {
    if (e instanceof IncludeExpansionError) {
      throw new IncludeExpansionError(`Node '${node.id}': ${e.message}`, e.errorType, {
        cause: e,
      });
    }
    throw e;
  }
}

/**
 * Runtime width stays deferred, while the complete body contract is proven now. Width is
 * runtime data, but the body remains ordinary static composition. Expanding it here
 * validates its complete include closure and carries its requirements onto the parent
 * before any upstream node can spend.
 */
function expandComposeFanOut(
  expansion: IncludeExpansion,
  list: NodeListExpansion,
  node: ComposeFanOutNode,
  stack: string[]
): void {
  const child = expandTarget(expansion, node, stack);
  const suspensionPaths = collectComposedSuspensionPaths(
    expansion.rawByName.get(node.include) ?? child,
    [...expansion.rawByName.values()]
  );
  if (suspensionPaths.length > 0) {
    const details = suspensionPaths.map(path => `'${path.id}' (${path.reason})`).join(', ');
    throw new IncludeExpansionError(
      `Node '${node.id}': composed fan-out block '${node.include}' contains unsupported suspension-capable path${suspensionPaths.length === 1 ? '' : 's'} ${details}. Composed fan-out is currently limited to deterministic, non-interactive bodies because the parent has no durable per-item pause cursor. Put gates and waits before or after the fan-out, use governed child runs, or follow #2810 for interactive instance support.`
    );
  }
  warnDroppedWorkflowLevelFields({ id: node.id, kind: 'include', include: node.include }, child);
  // Exercise the exact ordinary-include instantiation once at load time. Width is
  // still deferred, but the block's input contract and packaged command resources
  // are static and must fail before upstream nodes can spend.
  instantiateResolvedInclude(
    {
      id: node.id,
      kind: 'include',
      include: node.include,
      with: { ...(node.with ?? {}), [node.fan_out.as]: null },
    },
    child,
    expansion.commandContents
  );
  list.includedRequirements.push(...(child.requires ?? []));
  list.expandedNodes.push(node);
}

function expandIncludeDirective(
  expansion: IncludeExpansion,
  list: NodeListExpansion,
  node: IncludeDirective,
  stack: string[]
): void {
  const child = expandTarget(expansion, node, stack);
  warnDroppedWorkflowLevelFields(node, child);
  list.includedRequirements.push(...(child.requires ?? []));
  const inlined = instantiateResolvedInclude(node, child, expansion.commandContents);
  list.includesById.set(node.id, inlined);
  list.includeAliases.set(inlined.primarySink, node.id);
  list.expandedNodes.push(...inlined.namespaced);
}

function expandLoopGroupBody(
  expansion: IncludeExpansion,
  list: NodeListExpansion,
  node: LoopGroupNode,
  workflowName: string,
  stack: string[]
): void {
  const body = expandNodeList(expansion, node.loop_group.nodes, workflowName, stack);
  list.includedRequirements.push(...body.includedRequirements);
  for (const [sink, alias] of body.includeAliases) list.includeAliases.set(sink, alias);
  list.expandedNodes.push({
    ...node,
    loop_group: {
      ...node.loop_group,
      // The completion script runs against THIS body's output map. Rebind an
      // authored `$include.output` to the included workflow's declared return,
      // just as refs on ordinary sibling body nodes are rebound below.
      ...(node.loop_group.until_bash !== undefined
        ? { until_bash: applyOutputRefRename(node.loop_group.until_bash, body.renameIncludeRef) }
        : {}),
      nodes: body.nodes,
    },
  });
}

/**
 * Rewrite only aliases owned by this list. `rewriteNodeOutputRefs` deliberately
 * recurses into nested loop_group bodies because their text may read enclosing
 * outputs, while their sealed depends_on edges remain local to their own list.
 */
function bindIncludeRefs(list: NodeListExpansion): ExpandedNodeList {
  const { expandedNodes, includesById } = list;
  const renameIncludeRef = (id: string): string => includesById.get(id)?.primarySink ?? id;
  const expandIncludeDependency = (id: string): string[] => includesById.get(id)?.sinks ?? [id];
  for (const node of expandedNodes) {
    if (node.depends_on !== undefined) {
      node.depends_on = node.depends_on.flatMap(expandIncludeDependency);
    }
    // `$include.output` is a current-iteration composition alias. It deliberately does
    // not create a parallel `$LOOP_PREV.<includeId>` grammar: previous-iteration refs
    // continue to name only the executable body ids produced by `inlineInclude()`.
    rewriteNodeOutputRefs(node, renameIncludeRef, expandIncludeDependency, id => id);
  }
  if (includesById.size > 0) {
    const aliases = Object.fromEntries(
      [...includesById].map(([id, inlined]) => [id, inlined.primarySink])
    );
    for (const node of expandedNodes) attachIncludeOutputAliases(node, aliases);
  }

  return {
    nodes: expandedNodes,
    includedRequirements: list.includedRequirements,
    renameIncludeRef,
    includeAliases: list.includeAliases,
  };
}
