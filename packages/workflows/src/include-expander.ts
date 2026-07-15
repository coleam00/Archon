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
 *     to the sub-DAG's SINKS and `$I.output` to its PRIMARY sink (first sink in
 *     definition order — the same terminal-selection rule loop_group uses)
 *
 * Targets are resolved recursively (a target may itself `include:` others),
 * depth-capped and cycle-detected. Because expansion runs BEFORE any
 * WorkflowDefinition reaches the executor, the inlined nodes are indistinguishable
 * from hand-written nodes — there is zero new runtime machinery. Every execution
 * path re-discovers → re-expands deterministically, so resume matches the persisted
 * namespaced step names byte-for-byte.
 *
 * Delimiter note: the namespace joiner is `__` (double underscore), NOT `.`. The
 * output-ref substitution regex forbids dots in a node id, so a dotted id would
 * silently break every rewritten `$id.output` reference. `__` is inside the legal
 * id character class, so `$review__scope.output` substitutes correctly.
 */
import type { WorkflowDefinition, WorkflowLoadError, DagNode, IncludeNode } from './schemas';
import {
  isIncludeNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isBashNode,
  isScriptNode,
} from './schemas';
import { validateDagStructure } from './loader';

/**
 * Maximum include-nesting depth. A chain of includes deeper than this is rejected
 * as a load error (guards against accidental deep/runaway recursion). Depth 1
 * (an includer → a building block) is the common case; the cap leaves generous room.
 */
export const INCLUDE_MAX_DEPTH = 3;

/**
 * Output-ref pattern — mirrors the loader's `outputRefPattern` and the executor's
 * substitution regex. Matches `$<id>.output`; any `.field` suffix that follows is
 * left untouched (only the node-id segment is rewritten).
 */
const OUTPUT_REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;

/** Internal signal for a per-workflow expansion failure (resilient: drop one, keep the rest). */
class IncludeExpansionError extends Error {}

/**
 * Rewrite `$id.output` references in a node's text-bearing fields via `rename`.
 * Mutates the (already-cloned) node in place. Recurses into loop_group bodies so a
 * body node's reference to an enclosing (namespaced) node is rewritten too.
 * `command` is a command NAME, never a ref, and is intentionally not rewritten.
 */
function rewriteNodeOutputRefs(node: DagNode, rename: (id: string) => string): void {
  const sub = (text: string): string =>
    text.replace(OUTPUT_REF_PATTERN, (match, id: string) => {
      const renamed = rename(id);
      return renamed === id ? match : `$${renamed}.output`;
    });

  if (node.when !== undefined) node.when = sub(node.when);

  if (isLoopNode(node)) {
    node.loop.prompt = sub(node.loop.prompt);
    if (node.loop.until_bash !== undefined) node.loop.until_bash = sub(node.loop.until_bash);
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined) {
      node.loop_group.until_bash = sub(node.loop_group.until_bash);
    }
    for (const body of node.loop_group.nodes) rewriteNodeOutputRefs(body, rename);
  } else if (isApprovalNode(node)) {
    node.approval.message = sub(node.approval.message);
  } else if (isBashNode(node)) {
    node.bash = sub(node.bash);
  } else if (isScriptNode(node)) {
    node.script = sub(node.script);
  } else if (isCancelNode(node)) {
    node.cancel = sub(node.cancel);
  } else if ('prompt' in node && typeof node.prompt === 'string') {
    node.prompt = sub(node.prompt);
  }
}

interface ExpandedInclude {
  /** The child's nodes, deep-cloned, id-namespaced, edges + refs rewired. */
  namespaced: DagNode[];
  /** Namespaced ids of the child's sink nodes (no dependents within the child). */
  sinks: string[];
  /** First sink in child definition order — the include's `$id.output` terminal. */
  primarySink: string;
}

/**
 * Inline one include node's fully-expanded child into namespaced parent nodes.
 * Never mutates `childNodes` (each node is deep-cloned first), so a building block
 * shared by two parents is namespaced independently.
 */
function inlineInclude(includeNode: IncludeNode, childNodes: DagNode[]): ExpandedInclude {
  const prefix = `${includeNode.id}__`;
  const childTopLevelIds = new Set(childNodes.map(n => n.id));
  const rename = (id: string): string => (childTopLevelIds.has(id) ? prefix + id : id);

  // Sinks: child top-level nodes that nothing else in the child depends on (definition order).
  const childDeps = new Set(childNodes.flatMap(n => n.depends_on ?? []));
  const sinkOriginalIds = childNodes.filter(n => !childDeps.has(n.id)).map(n => n.id);

  const parentDeps = includeNode.depends_on ?? [];

  const namespaced = childNodes.map(cn => {
    const clone = structuredClone(cn);
    const wasEntry = (cn.depends_on ?? []).length === 0;

    // Rewrite internal $id.output refs (child-top-level ids → namespaced) BEFORE renaming ids.
    rewriteNodeOutputRefs(clone, rename);
    clone.id = prefix + cn.id;

    if (wasEntry) {
      // Entry node: the include node's upstream deps + gate attach here. The gate
      // (when/trigger_rule) copies onto each entry unless the entry declares its own.
      if (parentDeps.length > 0) clone.depends_on = [...parentDeps];
      if (includeNode.when !== undefined && clone.when === undefined) {
        clone.when = includeNode.when;
      }
      if (includeNode.trigger_rule !== undefined && clone.trigger_rule === undefined) {
        clone.trigger_rule = includeNode.trigger_rule;
      }
    } else {
      clone.depends_on = (cn.depends_on ?? []).map(rename);
    }

    return clone;
  });

  return {
    namespaced,
    sinks: sinkOriginalIds.map(id => prefix + id),
    // A valid non-empty DAG always has ≥1 sink; sinkOriginalIds[0] is defined.
    primarySink: prefix + (sinkOriginalIds[0] ?? ''),
  };
}

/**
 * Expand every workflow's `include:` nodes into flattened, namespaced sub-DAGs.
 *
 * Input is keyed by workflow NAME (higher-scope files have already overridden lower
 * ones by filename in discovery). Output workflows contain ZERO include nodes.
 * Errors are per-workflow: a workflow that fails to expand (unknown target, cycle,
 * depth, id collision, invalid flattened structure) is dropped from the output and
 * an error is recorded — other workflows still expand.
 */
export function expandWorkflowIncludes(rawByName: Map<string, WorkflowDefinition>): {
  workflows: Map<string, WorkflowDefinition>;
  errors: WorkflowLoadError[];
} {
  const memo = new Map<string, WorkflowDefinition>();
  const failed = new Set<string>();
  const errors: WorkflowLoadError[] = [];

  function expandOne(name: string, stack: string[]): WorkflowDefinition {
    // Cycle + depth are checked BEFORE the memo so a node memoized via a shallow path
    // can never mask a too-deep or cyclic reference reaching it via a longer path.
    if (stack.includes(name)) {
      throw new IncludeExpansionError(`include cycle detected: ${[...stack, name].join(' -> ')}`);
    }
    if (stack.length >= INCLUDE_MAX_DEPTH) {
      throw new IncludeExpansionError(
        `include depth limit exceeded (max ${String(INCLUDE_MAX_DEPTH)}): ${[...stack, name].join(' -> ')}`
      );
    }

    const cached = memo.get(name);
    if (cached) return cached;

    const raw = rawByName.get(name);
    if (!raw) {
      // Top-level names always exist (they come from rawByName.keys()); this only
      // fires when the name was reached as an unresolvable include TARGET.
      throw new IncludeExpansionError(`include target '${name}' not found`);
    }

    // Fast path: a workflow with no include nodes passes through byte-for-byte
    // (never cloned, never re-validated — it already passed structure validation at
    // parse time). Includers deep-clone its nodes when inlining, so this is safe.
    if (!raw.nodes.some(isIncludeNode)) {
      memo.set(name, raw);
      return raw;
    }

    const newNodes: DagNode[] = [];
    const sinksByIncludeId = new Map<string, string[]>();
    const primarySinkByIncludeId = new Map<string, string>();

    for (const node of raw.nodes) {
      if (isIncludeNode(node)) {
        let child: WorkflowDefinition;
        try {
          child = expandOne(node.include, [...stack, name]);
        } catch (e) {
          if (e instanceof IncludeExpansionError) {
            throw new IncludeExpansionError(`Node '${node.id}': ${e.message}`);
          }
          throw e;
        }
        const inlined = inlineInclude(node, child.nodes);
        sinksByIncludeId.set(node.id, inlined.sinks);
        primarySinkByIncludeId.set(node.id, inlined.primarySink);
        newNodes.push(...inlined.namespaced);
      } else {
        newNodes.push(structuredClone(node));
      }
    }

    // Second pass — rewrite references to include ids across every node:
    //   (a) depends_on entries equal to an include id → that include's sink list
    //   (b) $includeId.output → $<primarySink>.output
    const renameIncludeRef = (id: string): string => primarySinkByIncludeId.get(id) ?? id;
    for (const node of newNodes) {
      if (node.depends_on !== undefined) {
        node.depends_on = node.depends_on.flatMap(dep => sinksByIncludeId.get(dep) ?? [dep]);
      }
      rewriteNodeOutputRefs(node, renameIncludeRef);
    }

    // Re-validate the fully-flattened DAG. Catches a namespaced id colliding with a
    // hand-written node, cycles introduced by edge rewiring, and unknown deps.
    const structureError = validateDagStructure(newNodes);
    if (structureError) {
      throw new IncludeExpansionError(structureError);
    }

    const result: WorkflowDefinition = { ...raw, nodes: newNodes };
    memo.set(name, result);
    return result;
  }

  for (const name of rawByName.keys()) {
    if (memo.has(name)) continue; // already expanded as a dependency of an earlier workflow
    try {
      expandOne(name, []);
    } catch (e) {
      if (e instanceof IncludeExpansionError) {
        failed.add(name);
        errors.push({ filename: name, error: e.message, errorType: 'validation_error' });
      } else {
        throw e;
      }
    }
  }

  const workflows = new Map<string, WorkflowDefinition>();
  for (const name of rawByName.keys()) {
    if (failed.has(name)) continue;
    const expanded = memo.get(name);
    if (expanded) workflows.set(name, expanded);
  }
  return { workflows, errors };
}
