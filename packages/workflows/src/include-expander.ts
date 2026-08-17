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
 */
import type { WorkflowDefinition, WorkflowLoadError, DagNode, IncludeNode } from './schemas';
import {
  isIncludeNode,
  isCommandNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isBashNode,
  isScriptNode,
  isWorkflowNode,
  INPUT_NAME_SOURCE,
} from './schemas';
import { createLogger } from '@archon/paths';
import { validateDagStructure } from './loader';
import { resolveDeclaredInputs } from './workflow-inputs';
import {
  COMPILED_LOOP_COMMAND,
  isIncludeCommandReadError,
  type CompiledLoopCommand,
  type IncludeCommandContent,
  type LoopWithCompiledCommand,
} from './compiled-command';

/**
 * Resolve the logger on every call rather than caching it at module scope.
 *
 * The deferral exists so test mocks can intercept `createLogger` — but a module-level
 * cache only delivers that for whichever mock happens to be installed at the FIRST
 * call. Bun's `mock.module` is process-wide and irreversible, so once another test
 * file in the same process warms the cache, a later `mock.module('@archon/paths')`
 * can no longer intercept these warns and log assertions silently come up empty
 * (#2458 — it cost three red tests in `loader.test.ts` whenever that file shared a
 * `bun test` process with `include-expander.test.ts`).
 *
 * Resolving per call costs one `rootLogger.child()` on a warn-only discovery path that
 * fires at most once per include node whose workflow-level fields are dropped. It is not
 * a hot loop.
 */
function getLog(): ReturnType<typeof createLogger> {
  return createLogger('workflow.include-expander');
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

/**
 * Load-time include parameter references. Built from the same identifier source the
 * `with:` key validator uses (INPUT_NAME_SOURCE in schemas/dag-node.ts) so a key that
 * validates can never fail to match here — see that constant for why the drift between
 * the two is silent in one direction.
 */
const INPUTS_REF = new RegExp(String.raw`\$INPUTS\.(${INPUT_NAME_SOURCE})`, 'g');

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
 *   - Prompt text (prompt / loop.prompt / approval fields) — canonical `.output` refs are
 *     live everywhere, including Markdown code spans, because runtime substitution is
 *     syntax-agnostic.
 *   - Code/expression (bash / script / loop.until_bash / loop_group.until_bash / cancel /
 *     workflow.input / workflow.fan_out.items) — canonical `.output` refs are LIVE (never
 *     documentation) → rewritten verbatim.
 *
 * Public runtime node-ref surfaces stay aligned across this rewrite, the loader's
 * validateDagStructure scan, and the substituteNodeOutputRefs call sites in
 * dag-executor.ts. Included loop-command bodies are validated separately during command
 * materialization, then their compiled prompts pass through this rewrite.
 *
 * applyInputsMacro is a SUPERSET of these node-ref surfaces, not a mirror: it additionally walks
 * systemPrompt and agents fields. Those fields accept include inputs but do not receive
 * node-output substitution at runtime, so they are not node-reference surfaces.
 */
function rewriteNodeOutputRefs(node: DagNode, rename: (id: string) => string): void {
  const code = (text: string): string => applyOutputRefRename(text, rename);
  const whenExpr = (text: string): string => applyWhenRefRename(text, rename);

  if (node.when !== undefined) node.when = whenExpr(node.when);

  if (isLoopNode(node)) {
    if (node.loop.prompt !== undefined) node.loop.prompt = code(node.loop.prompt);
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled?.prompt !== undefined) compiled.prompt = code(compiled.prompt);
    if (node.loop.until_bash !== undefined) node.loop.until_bash = code(node.loop.until_bash);
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined) {
      node.loop_group.until_bash = code(node.loop_group.until_bash);
    }
    for (const body of node.loop_group.nodes) rewriteNodeOutputRefs(body, rename);
  } else if (isApprovalNode(node)) {
    node.approval.message = code(node.approval.message);
    if (node.approval.on_reject !== undefined) {
      node.approval.on_reject.prompt = code(node.approval.on_reject.prompt);
    }
  } else if (isBashNode(node)) {
    node.bash = code(node.bash);
  } else if (isScriptNode(node)) {
    node.script = code(node.script);
  } else if (isWorkflowNode(node)) {
    // workflow.input, workflow.with values and workflow.fan_out.items are live
    // code/expression ref surfaces (data strings), so refs inside an included block's
    // `workflow:` node namespace verbatim.
    if (node.input !== undefined) node.input = code(node.input);
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) node.with[key] = code(value);
    }
    if (node.fan_out !== undefined) node.fan_out.items = code(node.fan_out.items);
  } else if (isCancelNode(node)) {
    node.cancel = code(node.cancel);
  } else if ('prompt' in node && typeof node.prompt === 'string') {
    node.prompt = code(node.prompt);
  }
}

/**
 * Apply an include node's input mapping to every inline text surface in the cloned node.
 * Unlike output-ref rewriting, substitutions also apply inside Markdown code spans because
 * `$INPUTS` has no documentation-only meaning. An inserted value may itself be a
 * `$node.output` reference; it deliberately remains unresolved for the executor's existing
 * runtime substitution pass.
 *
 * This walks a SUPERSET of rewriteNodeOutputRefs' field set, and the extra fields are the
 * point. `$INPUTS` has no runtime resolution pass anywhere in the engine — load-time
 * expansion is the ONLY path that resolves it. So the two functions have different
 * fallbacks for a surface they skip:
 *
 *   - a surface rewriteNodeOutputRefs misses is only a NAMESPACING miss; the executor's
 *     substituteNodeOutputRefs pass still resolves the ref at run time.
 *   - a surface this function misses is permanent. The literal `$INPUTS.<name>` reaches
 *     the model as text, and because the field was never visited the name never reaches
 *     `missing` either — so a caller who forgot to supply it gets no load error.
 *
 * That is why systemPrompt / agents.*.prompt / agents.*.description are walked here even
 * though they are not node-output reference surfaces. Every model-facing string field must
 * be walked for include inputs, whether or not runtime also resolves node outputs there.
 */
function applyInputsMacro(node: DagNode, args: Record<string, string>, missing: Set<string>): void {
  const substitute = (text: string): string =>
    text.replace(INPUTS_REF, (match, name: string) => {
      // `Object.hasOwn` rather than a plain `args[name]` lookup: a bare index read reaches
      // Object.prototype, so an unsupplied `$INPUTS.toString` / `$INPUTS.constructor`
      // would resolve to an inherited member and splice a native function body into the
      // prompt instead of being reported as a missing input. Anything not supplied as an
      // OWN key is missing, and missing always fails the load — never a silent passthrough.
      const value = Object.hasOwn(args, name) ? args[name] : undefined;
      if (value === undefined) {
        missing.add(name);
        return match;
      }
      return value;
    });

  if (node.when !== undefined) node.when = substitute(node.when);

  // Base AI-turn fields — valid on every AI node mode (command / prompt / loop_group), so
  // they are walked outside the mode chain, like `when:`. Both go straight to the provider
  // with no substitution of their own downstream.
  if (node.systemPrompt !== undefined) node.systemPrompt = substitute(node.systemPrompt);
  if (node.agents !== undefined) {
    for (const agent of Object.values(node.agents)) {
      agent.prompt = substitute(agent.prompt);
      agent.description = substitute(agent.description);
    }
  }

  if (isLoopNode(node)) {
    if (node.loop.prompt !== undefined) node.loop.prompt = substitute(node.loop.prompt);
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled?.prompt !== undefined) compiled.prompt = substitute(compiled.prompt);
    if (node.loop.until_bash !== undefined) {
      node.loop.until_bash = substitute(node.loop.until_bash);
    }
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined) {
      node.loop_group.until_bash = substitute(node.loop_group.until_bash);
    }
    for (const body of node.loop_group.nodes) applyInputsMacro(body, args, missing);
  } else if (isApprovalNode(node)) {
    node.approval.message = substitute(node.approval.message);
    if (node.approval.on_reject !== undefined) {
      node.approval.on_reject.prompt = substitute(node.approval.on_reject.prompt);
    }
  } else if (isBashNode(node)) {
    node.bash = substitute(node.bash);
  } else if (isScriptNode(node)) {
    node.script = substitute(node.script);
  } else if (isWorkflowNode(node)) {
    if (node.input !== undefined) node.input = substitute(node.input);
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) node.with[key] = substitute(value);
    }
    if (node.fan_out !== undefined) node.fan_out.items = substitute(node.fan_out.items);
  } else if (isCancelNode(node)) {
    node.cancel = substitute(node.cancel);
  } else if ('prompt' in node && typeof node.prompt === 'string') {
    node.prompt = substitute(node.prompt);
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
 * Resolve a caller's `with:` map against a block's declared `inputs:` (#2470).
 * Only active when the block declares `inputs:` — an undeclared block keeps Phase-1
 * behaviour byte-for-byte (the caller's `with:` passes through verbatim). When declared:
 * applies each input's `default` for an omitted name, errors on an unsupplied `required`
 * input, and errors on a caller `with:` key the block doesn't declare.
 */
function resolveIncludeInputs(
  includeNode: IncludeNode,
  child: WorkflowDefinition
): Record<string, string> {
  try {
    return resolveDeclaredInputs(
      includeNode.with ?? {},
      child.inputs,
      `Node '${includeNode.id}'`,
      `included block '${child.name}'`
    );
  } catch (err) {
    // Re-typed so the per-workflow expansion loop treats a contract violation as the
    // same resilient "drop one workflow, keep the rest" failure as every other
    // expansion error, rather than escaping as an unhandled throw.
    throw new IncludeExpansionError((err as Error).message);
  }
}

/** structuredClone intentionally drops symbol keys; retain the engine-private compiled
 * loop metadata while cloning a reusable child for another include level. */
function cloneNodeForInclude(node: DagNode): DagNode {
  const clone = structuredClone(node);
  const preserveCompiledLoops = (source: DagNode, target: DagNode): void => {
    if (isLoopNode(source) && isLoopNode(target)) {
      const compiled = (source.loop as typeof source.loop & LoopWithCompiledCommand)[
        COMPILED_LOOP_COMMAND
      ];
      if (compiled !== undefined) {
        (target.loop as typeof target.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND] =
          structuredClone(compiled);
      }
    }
    if (isLoopGroupNode(source) && isLoopGroupNode(target)) {
      for (const [index, sourceChild] of source.loop_group.nodes.entries()) {
        const targetChild = target.loop_group.nodes[index];
        if (targetChild !== undefined) preserveCompiledLoops(sourceChild, targetChild);
      }
    }
  };
  preserveCompiledLoops(node, clone);
  return clone;
}

/**
 * Inline one include node's fully-expanded child into namespaced parent nodes.
 * Never mutates the child's nodes (each node is deep-cloned first), so a building block
 * shared by two parents is namespaced independently.
 */
function inlineInclude(
  includeNode: IncludeNode,
  child: WorkflowDefinition,
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
  const childNodes = child.nodes;
  const prefix = `${includeNode.id}__`;
  const childTopLevelIds = new Set(childNodes.map(n => n.id));
  const rename = (id: string): string => (childTopLevelIds.has(id) ? prefix + id : id);

  // Sinks: child top-level nodes that nothing else in the child depends on (definition order).
  const childDeps = new Set(childNodes.flatMap(n => n.depends_on ?? []));
  const sinkOriginalIds = childNodes.filter(n => !childDeps.has(n.id)).map(n => n.id);

  const parentDeps = includeNode.depends_on ?? [];
  const missingInputs = new Set<string>();
  const resolvedInputs = resolveIncludeInputs(includeNode, child);

  const namespaced = childNodes.map(cn => {
    const clone = materializeBlockCommandPrompts(
      cloneNodeForInclude(cn),
      includeNode,
      child,
      commandContents,
      childTopLevelIds,
      new Set<string>(),
      cn.id
    );
    const wasEntry = (cn.depends_on ?? []).length === 0;

    // Rewrite child-internal refs before inserting caller values. This ordering is
    // load-bearing: a caller ref such as `$gather.output` must remain parent-scoped even
    // when the included block also has a node named `gather`.
    rewriteNodeOutputRefs(clone, rename);
    applyInputsMacro(clone, resolvedInputs, missingInputs);
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

  if (missingInputs.size > 0) {
    const names = [...missingInputs].sort().map(name => `$INPUTS.${name}`);
    throw new IncludeExpansionError(
      `Node '${includeNode.id}': included block '${includeNode.include}' references missing input${names.length === 1 ? '' : 's'} ${names.join(', ')}. Pass ${names.length === 1 ? 'it' : 'them'} through 'with:'.`
    );
  }

  return {
    namespaced,
    sinks: sinkOriginalIds.map(id => prefix + id),
    // `$blk.output` resolves to the block's declared `returns:` node when set (#2470) —
    // even a NON-sink node — otherwise the first sink in definition order. `returns:`
    // was validated at load to name a top-level child node, so `prefix + returns` is a
    // real namespaced id. Only `primarySink` moves; `sinks` (and thus `depends_on:[blk]`)
    // still covers every terminal node.
    // A valid non-empty DAG always has ≥1 sink; sinkOriginalIds[0] is defined.
    primarySink: prefix + (child.returns ?? sinkOriginalIds[0] ?? ''),
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
  // #2470: both are CONSUMED by inlining, not dropped — `returns` drives the block's
  // primarySink and `inputs` validates the caller's `with:`. Warning "dropped" would be
  // misleading.
  'returns',
  'inputs',
]);

/** Isolation/concurrency-safety fields — a silent drop of these is the most dangerous. */
const SAFETY_WORKFLOW_KEYS: ReadonlySet<string> = new Set(['mutates_checkout', 'sandbox']);

/**
 * The included file's workflow-level fields are dropped (only its `nodes:` are inlined) —
 * emit a one-line load-time WARN so authors get a signal, since a silently-dropped
 * `requires`/`provider`/`mutates_checkout`/`sandbox`/… can change behavior under a
 * different parent. The dropped set is DERIVED from the child's own defined keys (not a
 * hand-maintained list) so any future workflow-level field is covered automatically —
 * parseWorkflow emits provider/model/webSearchMode/interactive as
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
 * Compile an included workflow's named AI command bodies into the flat DAG. Composition
 * must prove the child's lexical boundary before parent nodes share one output map, so
 * every canonical ref in a resolved body must name a node in the command node's current or
 * enclosing workflow scope. Ordinary command nodes become prompt nodes. Loop commands keep
 * their authored identity plus symbol-keyed compiled prompt/error metadata so cold resume can
 * reach a persisted prompt snapshot even after source deletion. The ordinary namespacing and
 * `$INPUTS` passes transform compiled bodies without a second grammar.
 * Named script files are deliberately outside this function: their source is opaque. An
 * included block can bind inputs in the YAML `script:` selector, but the flattened include
 * does not add `INPUTS_*` environment variables inside the selected script program.
 */
function materializeBlockCommandPrompts(
  node: DagNode,
  includeNode: IncludeNode,
  child: WorkflowDefinition,
  commandContents: ReadonlyMap<string, IncludeCommandContent>,
  currentIds: ReadonlySet<string>,
  enclosingIds: ReadonlySet<string>,
  nodePath: string
): DagNode {
  const compile = (commandName: string): CompiledLoopCommand => {
    const content = commandContents.get(commandName);
    if (isIncludeCommandReadError(content)) {
      const failure =
        content.operation === 'inspect'
          ? `could not inspect higher-precedence command scope '${content.path}'`
          : `matched '${content.path}' but could not be read`;
      return {
        error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' ${failure}: ${content.message}. Archon will not fall through to a lower-precedence command when a higher-precedence scope cannot be inspected or its matched file cannot be read.`,
      };
    }
    if (content === undefined || content === null) {
      return {
        error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' uses command '${commandName}', but its body could not be resolved during composition through the package-owned, project/configured, user, or enabled bundled command scopes. Included commands must resolve before a fresh execution so their references and declared inputs can be compiled safely.`,
      };
    }
    if (content.trim().length === 0) {
      return {
        error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' is empty. Included commands must contain a non-whitespace prompt body.`,
      };
    }

    const outputRefPattern = new RegExp(OUTPUT_REF_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = outputRefPattern.exec(content)) !== null) {
      const referencedId = match[1];
      if (referencedId === 'INPUTS') continue;
      if (
        referencedId !== undefined &&
        !currentIds.has(referencedId) &&
        !enclosingIds.has(referencedId)
      ) {
        const offendingRef = match[0];
        return {
          error: `Node '${includeNode.id}': included workflow '${child.name}' node '${nodePath}' command '${commandName}' references '${offendingRef}' outside its workflow namespace. Declare it under '${child.name}' inputs:, pass the caller value through '${includeNode.id}' with:, and read it as '$INPUTS.<name>' instead.`,
        };
      }
    }
    return { prompt: content };
  };

  if (isCommandNode(node)) {
    const compiled = compile(node.command);
    if (compiled.error !== undefined) throw new IncludeExpansionError(compiled.error);
    const { command, ...base } = node;
    void command;
    return { ...base, prompt: compiled.prompt };
  }

  if (isLoopNode(node) && node.loop.command !== undefined) {
    const existing = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (existing !== undefined) return node;
    const loop = { ...node.loop } as typeof node.loop & LoopWithCompiledCommand;
    loop[COMPILED_LOOP_COMMAND] = compile(node.loop.command);
    return { ...node, loop };
  }

  if (isLoopGroupNode(node)) {
    const bodyIds = new Set(node.loop_group.nodes.map(body => body.id));
    const bodyEnclosingIds = new Set([...enclosingIds, ...currentIds]);
    return {
      ...node,
      loop_group: {
        ...node.loop_group,
        nodes: node.loop_group.nodes.map(body =>
          materializeBlockCommandPrompts(
            body,
            includeNode,
            child,
            commandContents,
            bodyIds,
            bodyEnclosingIds,
            `${nodePath} → ${body.id}`
          )
        ),
      },
    };
  }

  return node;
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
  commandContents?: ReadonlyMap<string, IncludeCommandContent>
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
        const inlined = inlineInclude(node, child, commandContents ?? new Map());
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

    const result: WorkflowDefinition = {
      ...raw,
      nodes: newNodes,
      // `returns:` may name an include directive that no longer exists after flattening.
      // Rebind it to the same primary sink used for `$includeId.output`; ordinary node ids
      // pass through unchanged. Without this, a nested reusable workflow can finish with a
      // dangling return id even though every node-level reference was rewritten correctly.
      ...(raw.returns !== undefined ? { returns: renameIncludeRef(raw.returns) } : {}),
    };
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
