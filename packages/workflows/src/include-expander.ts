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
  isWorkflowNode,
} from './schemas';
import { createLogger } from '@archon/paths';
import { validateDagStructure } from './loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.include-expander');
  return cachedLog;
}

/**
 * Maximum include-nesting depth — chains up to this many include levels are allowed; a
 * deeper chain is a load error (guards against accidental deep/runaway recursion). Depth 1
 * (an includer → a building block) is the common case; the cap leaves generous room. The
 * depth check below uses `>` (not `>=`) so exactly INCLUDE_MAX_DEPTH levels are permitted,
 * matching the "up to 3 levels deep" contract in authoring-workflows.md.
 */
export const INCLUDE_MAX_DEPTH = 3;

/**
 * Output-ref pattern — mirrors the loader's `outputRefPattern` and the executor's
 * substitution regex. Matches `$<id>.output`; any `.field` suffix that follows is
 * left untouched (only the node-id segment is rewritten). Used for the eight text
 * surfaces that go through substituteNodeOutputRefs (prompt/bash/script/... ), which
 * only accept the canonical `.output[.field]` form.
 */
const OUTPUT_REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;

/**
 * `when:`-only ref pattern. The condition grammar (condition-evaluator.ts) additionally
 * accepts the SHORTHAND `$id.field` form (equivalent to `$id.output.field`) alongside
 * `$id.output` / `$id.output.field`. So in a `when:` a bare `$id` followed by `.` and a
 * field name is a node reference whose id must be renamed too — OUTPUT_REF_PATTERN (which
 * requires the literal `.output`) would miss `$verify.exit_code == '0'`. The lookahead
 * matches `$id` only when a `.<field>` follows, and rewrites just the id segment.
 */
const WHEN_REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)(?=\.[a-zA-Z_])/g;

/** Fenced (``` ```) and inline (` `` `) markdown code spans — documentation, not live refs. */
const CODE_SPAN_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

function applyOutputRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(OUTPUT_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}.output`;
  });
}

function applyWhenRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(WHEN_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}`;
  });
}

/**
 * Apply `fn` only to the text OUTSIDE markdown code spans, leaving fenced/inline code
 * verbatim. Used for prose fields (prompt/loop.prompt/approval.message) where a
 * `$other.output` inside a fenced example is documentation for the LLM, not a live ref —
 * mirroring the loader's fence-stripping in validateDagStructure so validation and
 * rewriting agree.
 */
function rewriteOutsideCode(text: string, fn: (chunk: string) => string): string {
  let result = '';
  let last = 0;
  CODE_SPAN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_SPAN_PATTERN.exec(text)) !== null) {
    result += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return result + fn(text.slice(last));
}

/** Escape a node id for use inside a dynamically-built RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Internal signal for a per-workflow expansion failure (resilient: drop one, keep the rest). */
class IncludeExpansionError extends Error {}

/**
 * Rewrite node-output references in a node's text-bearing fields via `rename`.
 * Mutates the (already-cloned) node in place. Recurses into loop_group bodies so a
 * body node's reference to an enclosing (namespaced) node is rewritten too.
 * `command` is a command NAME, never a ref, and is intentionally not rewritten.
 *
 * Three field classes, each with the right ref grammar:
 *   - `when:` — dual grammar (`$id.output[.field]` AND shorthand `$id.field`), never
 *     markdown → `applyWhenRefRename`. Missing the shorthand would leave e.g.
 *     `$verify.exit_code` pointing at a renamed sibling (silent fail-closed skip).
 *   - Prose (prompt / loop.prompt / approval.message) — canonical `.output` refs, but may
 *     embed fenced/inline code examples that must NOT be rewritten → fence-aware.
 *   - Code/expression (bash / script / loop.until_bash / loop_group.until_bash / cancel /
 *     workflow.input / workflow.fan_out.items) — canonical `.output` refs are LIVE (never
 *     documentation) → rewritten verbatim.
 *
 * KEEP IN SYNC (three ref-surface enumerations must agree): this rewrite, the loader's
 * validateDagStructure scan, and the substituteNodeOutputRefs call sites in dag-executor.ts.
 * Adding a substituted field to one means updating all three.
 */
function rewriteNodeOutputRefs(node: DagNode, rename: (id: string) => string): void {
  const code = (text: string): string => applyOutputRefRename(text, rename);
  const prose = (text: string): string =>
    rewriteOutsideCode(text, chunk => applyOutputRefRename(chunk, rename));
  const whenExpr = (text: string): string => applyWhenRefRename(text, rename);

  if (node.when !== undefined) node.when = whenExpr(node.when);

  if (isLoopNode(node)) {
    // A command-backed loop has no inline prompt; its `command` is a NAME, not a ref
    // (same rule as `command:` nodes above), so there is nothing to rewrite.
    if (node.loop.prompt !== undefined) node.loop.prompt = prose(node.loop.prompt);
    if (node.loop.until_bash !== undefined) node.loop.until_bash = code(node.loop.until_bash);
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined) {
      node.loop_group.until_bash = code(node.loop_group.until_bash);
    }
    for (const body of node.loop_group.nodes) rewriteNodeOutputRefs(body, rename);
  } else if (isApprovalNode(node)) {
    node.approval.message = prose(node.approval.message);
  } else if (isBashNode(node)) {
    node.bash = code(node.bash);
  } else if (isScriptNode(node)) {
    node.script = code(node.script);
  } else if (isWorkflowNode(node)) {
    // workflow.input and workflow.fan_out.items are live code/expression ref surfaces
    // (data strings), so refs inside an included block's `workflow:` node namespace
    // verbatim.
    if (node.input !== undefined) node.input = code(node.input);
    if (node.fan_out !== undefined) node.fan_out.items = code(node.fan_out.items);
  } else if (isCancelNode(node)) {
    node.cancel = code(node.cancel);
  } else if ('prompt' in node && typeof node.prompt === 'string') {
    node.prompt = prose(node.prompt);
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
      // Entry node: the include node's upstream deps + gate attach here.
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
 * Workflow-level keys that are NOT dropped-config and must be excluded from the warning.
 *   - name/description: the block's identity, never inheritable config.
 *   - nodes: not dropped — they ARE what gets inlined.
 *   - tags: cosmetic UI keyword-inference metadata with no runtime effect, so dropping it
 *     is behaviorally inert; reporting it would be noise.
 */
const NON_DROPPED_WORKFLOW_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'nodes',
  'tags',
]);

/** Isolation/concurrency-safety fields — a silent drop of these is the most dangerous. */
const SAFETY_WORKFLOW_KEYS: ReadonlySet<string> = new Set(['mutates_checkout', 'sandbox']);

/**
 * The included file's workflow-level fields are dropped (only its `nodes:` are inlined) —
 * emit a one-line load-time WARN so authors get a signal, since a silently-dropped
 * `requires`/`provider`/`mutates_checkout`/`sandbox`/… can change behavior under a
 * different parent. The dropped set is DERIVED from the child's own defined keys (not a
 * hand-maintained list) so any future workflow-level field is covered automatically —
 * parseWorkflow emits provider/model/modelReasoningEffort/webSearchMode/interactive as
 * always-present keys, so undefined values are filtered out.
 */
function warnDroppedWorkflowLevelFields(includeNode: IncludeNode, child: WorkflowDefinition): void {
  const childRecord = child as Record<string, unknown>;
  const droppedFields = Object.keys(child)
    .filter(key => !NON_DROPPED_WORKFLOW_KEYS.has(key) && childRecord[key] !== undefined)
    .sort();
  if (droppedFields.length === 0) return;

  const safetyDropped = droppedFields.filter(f => SAFETY_WORKFLOW_KEYS.has(f));

  getLog().warn(
    {
      include: includeNode.id,
      target: child.name,
      droppedFields,
      ...(child.requires?.includes('github')
        ? {
            requiresNote:
              "requires:['github'] is dropped by inlining — declare it on the PARENT workflow if the block needs GitHub identity",
          }
        : {}),
      ...(safetyDropped.length > 0
        ? {
            safetyNote: `${safetyDropped.join(' and ')} affect isolation/concurrency safety — set them on the PARENT workflow if the block relies on them`,
          }
        : {}),
    },
    'include.workflow_level_fields_dropped'
  );
}

/**
 * A `command:` node's file content is read only at EXECUTION time, so the expander cannot
 * rewrite `$sibling.output` refs inside it the way it rewrites inline node text. If a
 * block's command file references a sibling node id that namespacing renames, the ref
 * would silently substitute to '' at run time. Scan resolved command content (markdown
 * fences stripped) for refs to any renamed id and FAIL the expansion on a hit; WARN when
 * the file can't be resolved for scanning. Skipped entirely when no `commandContents` is
 * supplied (e.g. unit tests that don't exercise command files).
 */
function scanBlockCommandRefs(
  includeNode: IncludeNode,
  child: WorkflowDefinition,
  commandContents: ReadonlyMap<string, string | null>
): void {
  const renamedIds = child.nodes.map(n => n.id); // every child top-level id gets a prefix
  for (const cn of child.nodes) {
    if (!('command' in cn && typeof cn.command === 'string')) continue;
    const content = commandContents.get(cn.command);
    if (content === undefined || content === null) {
      getLog().warn(
        { include: includeNode.id, target: child.name, command: cn.command, renamedIds },
        'include.command_file_unresolved_for_ref_scan'
      );
      continue;
    }
    const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const id of renamedIds) {
      // `$id.output` or the shorthand `$id.field` — either points at the pre-rename id.
      const refRe = new RegExp(`\\$${escapeRegExp(id)}(?=\\.[a-zA-Z_])`);
      if (refRe.test(stripped)) {
        throw new IncludeExpansionError(
          `Node '${includeNode.id}': command file '${cn.command}.md' in included block '${child.name}' references sibling node '$${id}', which include namespacing renames to '${includeNode.id}__${id}'. Command-file contents are read at execution time and cannot be rewritten — inline the prompt, or restructure so the command has no cross-node reference.`
        );
      }
    }
  }
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
 * `commandContents` maps command NAME → file content (or null when unresolvable). When
 * provided (discovery pre-resolves it for include-target command nodes) the expander
 * scans block command files for sibling refs that namespacing would break; omit it to
 * skip that scan.
 */
export function expandWorkflowIncludes(
  rawByName: Map<string, WorkflowDefinition>,
  commandContents?: ReadonlyMap<string, string | null>
): {
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
    if (stack.length > INCLUDE_MAX_DEPTH) {
      throw new IncludeExpansionError(
        `include depth limit exceeded (max ${String(INCLUDE_MAX_DEPTH)} levels): ${[...stack, name].join(' -> ')}`
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
        warnDroppedWorkflowLevelFields(node, child);
        if (commandContents) scanBlockCommandRefs(node, child, commandContents);
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
