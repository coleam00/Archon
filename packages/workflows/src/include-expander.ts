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
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  DagNode,
  DagNodeBase,
  IncludeDirective,
  WorkflowBase,
  WorkflowRequirement,
} from './schemas';
import {
  isIncludeDirective,
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  isGateNode,
  isHaltNode,
  isExecNode,
  isWorkflowNode,
  isWaitNode,
  isPersistableNode,
  isNodeContextResume,
  isBindingDirective,
  isComposeFanOutNode,
  INPUT_NAME_SOURCE,
} from './schemas';
import { canonicalValueText, parseWholeInputsRef, type JsonValue } from './output-ref';
import { createLogger } from '@archon/paths';
import { validateDagStructure, validateWorkflowOutcomeDeclaration } from './loader';
import { resolveDeclaredInputs } from './workflow-inputs';
import { resolveWorkflowName } from './router';
import { parseWhenAtom, whenAtoms } from './when-atom';
import {
  COMPILED_LOOP_COMMAND,
  COMPOSED_NODE,
  isIncludeCommandReadError,
  readComposedMeta,
  type ComposedBlockBoundary,
  type ComposedNodeMeta,
  type CompiledLoopCommand,
  type IncludeCommandContent,
  type LoopWithCompiledCommand,
  type NodeWithComposedMeta,
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

export interface ComposedSuspensionPath {
  id: string;
  reason: string;
}

/**
 * Find every path in a static include/workflow closure that can pause an instance.
 * Composed fan-out currently owns one parent cursor, not one cursor per item, so both
 * load-time validation and the execution-time source-drift preflight use this proof.
 * Durable interactive instances are tracked separately in #2810.
 */
export function collectComposedSuspensionPaths(
  root: WorkflowDefinition,
  definitions: readonly WorkflowDefinition[]
): ComposedSuspensionPath[] {
  const byName = new Map(definitions.map(definition => [definition.name, definition]));
  const visited = new Set<string>();
  const found: ComposedSuspensionPath[] = [];

  const visitDefinition = (definition: WorkflowDefinition): void => {
    if (visited.has(definition.name)) return;
    visited.add(definition.name);
    if (definition.interactive === true) {
      found.push({ id: definition.name, reason: 'interactive workflow' });
    }
    visitNodes(definition.nodes);
  };

  const visitTarget = (name: string, ownerId: string, kind: 'include' | 'workflow'): void => {
    let target: WorkflowDefinition | undefined;
    try {
      target = kind === 'workflow' ? resolveWorkflowName(name, definitions) : byName.get(name);
    } catch (_err) {
      found.push({ id: ownerId, reason: `${kind} target '${name}' is ambiguous` });
      return;
    }
    if (target === undefined) {
      found.push({ id: ownerId, reason: `${kind} target '${name}' cannot be resolved` });
      return;
    }
    visitDefinition(target);
  };

  const visitNodes = (nodes: readonly (DagNode | IncludeDirective)[]): void => {
    for (const candidate of nodes) {
      if (isIncludeDirective(candidate)) {
        visitTarget(candidate.include, candidate.id, 'include');
        continue;
      }
      if (isGateNode(candidate)) {
        found.push({ id: candidate.id, reason: 'approval gate' });
      } else if (isWaitNode(candidate)) {
        found.push({ id: candidate.id, reason: 'durable wait' });
      } else if (isLoopNode(candidate) && candidate.loop.interactive === true) {
        found.push({ id: candidate.id, reason: 'interactive loop' });
      } else if (isLoopGroupNode(candidate)) {
        if (candidate.loop_group.interactive === true) {
          found.push({ id: candidate.id, reason: 'interactive loop group' });
        }
        visitNodes(candidate.loop_group.nodes);
      }

      if (isComposeFanOutNode(candidate)) {
        visitTarget(candidate.include, candidate.id, 'include');
      } else if (isWorkflowNode(candidate)) {
        visitTarget(candidate.workflow, candidate.id, 'workflow');
      }
    }
  };

  visitDefinition(root);
  return found;
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
 * Cross-iteration body refs use the same executable node ids, under a distinct prefix.
 * When a reusable block is inlined into a loop_group body, its authored sibling ids must
 * follow the same namespace rewrite as current-iteration `$id.output` refs.
 */
const LOOP_PREV_OUTPUT_REF_PATTERN = /\$LOOP_PREV\.([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;

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
 * `with:` key validator uses (INPUT_NAME_SOURCE, homed in output-ref.ts and re-exported
 * by schemas/dag-node.ts) so a key that validates can never fail to match here — see the
 * re-export's comment for why the drift between the two is silent in one direction.
 */
const INPUTS_REF = new RegExp(String.raw`\$INPUTS\.(${INPUT_NAME_SOURCE})`, 'g');

function applyOutputRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(OUTPUT_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$${renamed}.output`;
  });
}

function applyLoopPrevOutputRefRename(text: string, rename: (id: string) => string): string {
  return text.replace(LOOP_PREV_OUTPUT_REF_PATTERN, (match, id: string) => {
    const renamed = rename(id);
    return renamed === id ? match : `$LOOP_PREV.${renamed}.output`;
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

// ---------------------------------------------------------------------------
// Composed-node metadata (#1764)
// ---------------------------------------------------------------------------

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
  const cloneBoundaries = (
    boundaries: ComposedBlockBoundary[] | undefined
  ): ComposedBlockBoundary[] | undefined => boundaries?.map(boundary => structuredClone(boundary));
  if (existing === undefined) {
    target[COMPOSED_NODE] = {
      ...patch,
      ...(patch.boundaries !== undefined ? { boundaries: cloneBoundaries(patch.boundaries) } : {}),
    };
  } else {
    if (patch.blockEntry === true) existing.blockEntry = true;
    if (patch.boundaries !== undefined) {
      existing.boundaries = [
        ...(cloneBoundaries(patch.boundaries) ?? []),
        ...(existing.boundaries ?? []),
      ];
    }
  }
  // A loop_group body node was authored in the same file and reads the same inputs, so
  // it carries the same record — minus `blockEntry`, which is a position in the OUTER
  // graph and means nothing inside a body. A body node is likewise never the entry of an
  // enclosing outer-graph include, though it still inherits that boundary.
  if (isLoopGroupNode(node)) {
    const inherited: ComposedNodeMeta = {
      origin: patch.origin,
      ...(patch.inputs !== undefined ? { inputs: patch.inputs } : {}),
      ...(patch.boundaries !== undefined
        ? {
            boundaries: patch.boundaries.map(boundary => {
              const clone = structuredClone(boundary);
              if (!clone.isEntry) return clone;
              return {
                dependsOn: clone.dependsOn,
                entryTriggerRules: clone.entryTriggerRules,
                ...(clone.when !== undefined ? { when: clone.when } : {}),
                isEntry: false,
              };
            }),
          }
        : {}),
    };
    for (const body of node.loop_group.nodes) {
      if (!isIncludeDirective(body)) markComposedNode(body, inherited);
    }
  }
}

/**
 * Workflow-level fields that describe how a workflow's OWN NODES execute, paired with
 * the node-level field each lands on. Every one has a node-level equivalent the DAG
 * executor reads FIRST (`node.X ?? workflowLevelOptions.X`), so writing the value onto
 * the node is equivalent to the workflow-level path — which is what lets the
 * workflow-level layer be REMOVED afterwards (see `collapseWorkflowScope`).
 *
 * Absent on purpose:
 *   - Run-owned fields (`interactive`, `worktree`, `container`, `evidence_policy`,
 *     `mutates_checkout`) — decisions belonging to whoever started the run, not to the
 *     file that happens to hold a node. These stay workflow-level and are warned about
 *     when a composed workflow declares them.
 *   - `webSearchMode` — node-affecting in spirit but the ONE workflow-level field with
 *     no node-level counterpart (#2556 settled that it keeps none), so there is nowhere
 *     to write it. It is a real hole in the invariant, stated in the drop-warning and in
 *     the authoring guide rather than papered over with a node-level field.
 */
const NODE_AFFECTING_WORKFLOW_FIELDS: readonly (readonly [
  wfKey: keyof WorkflowBase,
  nodeKey: keyof DagNodeBase,
])[] = [
  ['provider', 'provider'],
  ['model', 'model'],
  ['effort', 'effort'],
  ['thinking', 'thinking'],
  ['fallbackModel', 'fallbackModel'],
  ['betas', 'betas'],
  ['sandbox', 'sandbox'],
  // The workflow-level default is plural; the node-level field is singular.
  ['persist_sessions', 'persist_session'],
];

/**
 * `model:` travels only to nodes that will run on the workflow's OWN provider.
 *
 * The executor applies a workflow-level model as `node.model ?? (provider ===
 * workflowProvider ? workflowModel : <that provider's configured default>)`, so a node
 * switching provider never inherits the other provider's model string. Copying the model
 * onto such a node unconditionally would hand `gpt-5.6-sol` to Claude — a behaviour change
 * dressed up as a no-op.
 *
 * When the workflow declares no `provider:`, its effective provider is decided at RUN time
 * — by `config.assistant`, or by the provider a tier/`@alias` `model:` resolves to under
 * the acting user's own prefs. Load time can see none of that, so a node that names a
 * provider explicitly is treated as naming a DIFFERENT one. That is the fail-safe
 * direction (never hand one provider's model string to another), and it is a real, if
 * narrow, divergence from the pre-collapse chain:
 *
 *   workflow: { model: large }            # tier resolves to codex at run time
 *   node:     { provider: codex }         # names that same provider explicitly
 *
 * The old chain compared the node against the RESOLVED workflow provider, matched, and
 * passed the tier's model down. The collapse cannot, so this node falls back to codex's
 * configured default model instead. Resolving tiers here is not the fix — it would freeze
 * per-user model preferences at discovery time, which is worse. Move the `model:` onto the
 * node if you need it there. Zero nodes across the 58 workflows in this repo hit it.
 */
function workflowModelTravelsTo(scope: Record<string, unknown>, node: DagNode): boolean {
  const nodeProvider = (node as unknown as Record<string, unknown>).provider;
  return nodeProvider === undefined || nodeProvider === scope.provider;
}

/**
 * Write a workflow's own node-affecting config onto its own nodes, where absent.
 *
 * `insideLoopGroup` marks the recursion into a `loop_group` body. A body is NOT simply a
 * nested node list: the executor builds it its own context with `workflowPersistSessions:
 * false` (dag-executor.ts), so a workflow-level `persist_sessions: true` has never reached
 * a body node. Pushing it there would make the collapse *grant* cross-run session
 * persistence a body never had — and `nodeUsesPersistedScope` reads the node value first,
 * so the executor's deliberate `false` would be overridden rather than consulted.
 */
function pushWorkflowScopeOntoNodes(
  scope: Record<string, unknown>,
  nodes: (DagNode | IncludeDirective)[],
  insideLoopGroup = false
): void {
  for (const node of nodes) {
    // An include directive carries no execution surface of its own — its target's
    // nodes are collapsed against THEIR file, and inlining happens after this pass.
    if (!isIncludeDirective(node)) {
      const target = node as unknown as Record<string, unknown>;
      for (const [wfKey, nodeKey] of NODE_AFFECTING_WORKFLOW_FIELDS) {
        const value = scope[wfKey];
        if (value === undefined) continue;
        if (target[nodeKey] !== undefined) continue; // the node's own value always wins
        if (nodeKey === 'model' && !workflowModelTravelsTo(scope, node)) continue;
        // `persist_session` only means something on a node that takes an AI turn and can
        // resume one, and never inside a loop_group body (see the docblock above).
        if (nodeKey === 'persist_session' && (insideLoopGroup || !isPersistableNode(node))) {
          continue;
        }
        target[nodeKey] = value;
      }
    }
    if (!isIncludeDirective(node) && isLoopGroupNode(node)) {
      pushWorkflowScopeOntoNodes(scope, node.loop_group.nodes, true);
    }
  }
}

/**
 * Collapse a workflow's node-affecting scope onto its own nodes and REMOVE that scope
 * from the definition — the load-time transform behind "a workflow runs as authored"
 * (#1764).
 *
 * The removal is the load-bearing half, not a tidy-up. Push-down alone leaves a node
 * that declares nothing free to fall back to `workflowLevelOptions`, which after
 * inlining belongs to whichever file composed it — so a block declaring no provider at
 * all (the `archon-review-block` shape) still runs on the parent's. With the layer gone
 * such a node resolves from config, tier presets and user prefs at run time, exactly as
 * it would standalone.
 *
 * Runs on EVERY workflow, not only composed ones: a workflow must not behave differently
 * depending on whether it happens to contain an `include:`. That is why the old
 * byte-for-byte fast path for include-free workflows had to go.
 */
function collapseWorkflowScope(raw: WorkflowDefinition): WorkflowDefinition {
  const collapsed: WorkflowDefinition = { ...raw, nodes: raw.nodes.map(cloneNodeForInclude) };
  const scope = collapsed as unknown as Record<string, unknown>;
  pushWorkflowScopeOntoNodes(scope, collapsed.nodes);
  // Deleted rather than set to `undefined` so the collapsed definition has the shape a
  // workflow that never declared these would have — it is spread into the expanded result
  // and serialized by the workflows API, and a present-but-undefined key survives both.
  // (The drop-warning is indifferent: it already filters `!== undefined`.) The key set is
  // this module's own const tuple list, never caller input.
  for (const [wfKey] of NODE_AFFECTING_WORKFLOW_FIELDS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete scope[wfKey];
  }
  return collapsed;
}

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
 *   - Code/expression (bash / script / wait.until / wait.event / loop.until_bash /
 *     loop_group.until_bash / cancel / workflow.input / workflow.fan_out.items) — canonical
 *     `.output` refs are LIVE (never documentation) → rewritten verbatim.
 *
 * Public runtime node-ref surfaces stay aligned across this rewrite, the loader's
 * validateDagStructure scan, and the substituteNodeOutputRefs call sites in
 * dag-executor.ts. Included loop-command bodies are validated separately during command
 * materialization, then their compiled prompts pass through this rewrite.
 *
 * applyInputsMacro walks the same field set. It used to be a deliberate SUPERSET — adding
 * systemPrompt and agents, which took include inputs but no runtime substitution — and that
 * asymmetry is what made a workflow using `$INPUTS.<name>` in a `systemPrompt:` resolve when
 * composed and stay literal when run standalone (#2476). Those fields receive runtime
 * substitution since #1764, so they are ordinary node-ref surfaces and are walked here too.
 */
function rewriteNodeOutputRefs(
  node: DagNode,
  renameOutputRef: (id: string) => string,
  expandDependency: (id: string) => string[],
  renameLoopPrevRef: (id: string) => string
): void {
  const code = (text: string): string =>
    applyLoopPrevOutputRefRename(applyOutputRefRename(text, renameOutputRef), renameLoopPrevRef);
  const whenExpr = (text: string): string => applyWhenRefRename(text, renameOutputRef);

  if (node.when !== undefined) node.when = whenExpr(node.when);
  if (isNodeContextResume(node.context)) {
    node.context.resume = renameOutputRef(node.context.resume);
  }

  // The composed-input stamp holds caller-supplied VALUES, which are live code/expression
  // ref surfaces exactly like `workflow.with` above it — a value naming a node of the
  // level now being inlined has to follow that node's rename. Walked outside the mode
  // chain because any node type can carry a stamp. Only strings can carry refs (#2637);
  // typed values pass through untouched.
  const stamped = readComposedMeta(node)?.inputs;
  if (stamped !== undefined) {
    for (const [key, value] of Object.entries(stamped)) {
      if (typeof value === 'string') stamped[key] = code(value);
    }
  }
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    boundary.dependsOn = boundary.dependsOn.flatMap(expandDependency);
    if (boundary.when !== undefined) boundary.when = whenExpr(boundary.when);
  }

  // Node-level AI configuration is a runtime ref surface too (#2476/#1764): the executor
  // substitutes `$node.output` into these before the provider sees them, so an included
  // block's refs must be namespaced here or they point at the pre-flatten id.
  if (node.systemPrompt !== undefined) node.systemPrompt = code(node.systemPrompt);
  if (node.agents !== undefined) {
    for (const agent of Object.values(node.agents)) {
      agent.prompt = code(agent.prompt);
      agent.description = code(agent.description);
    }
  }

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
    for (const body of node.loop_group.nodes) {
      if (!isIncludeDirective(body)) {
        rewriteNodeOutputRefs(body, renameOutputRef, expandDependency, renameLoopPrevRef);
      }
    }
  } else if (isGateNode(node)) {
    node.message = code(node.message);
    for (const decision of node.decisions) {
      if (decision.rework !== undefined) decision.rework.prompt = code(decision.rework.prompt);
    }
  } else if (isExecNode(node)) {
    node.script = code(node.script);
  } else if (isWaitNode(node)) {
    if (node.wait.until !== undefined) node.wait.until = code(node.wait.until);
    if (node.wait.event !== undefined) node.wait.event = code(node.wait.event);
  } else if (isWorkflowNode(node)) {
    // workflow.input, workflow.with values and workflow.fan_out.items are live
    // code/expression ref surfaces (data strings), so refs inside an included block's
    // `workflow:` node namespace verbatim. Non-string with values carry no refs (#2637).
    if (node.input !== undefined) node.input = code(node.input);
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) {
        if (typeof value === 'string') node.with[key] = code(value);
      }
    }
    if (node.fan_out !== undefined) node.fan_out.items = code(node.fan_out.items);
  } else if (isComposeFanOutNode(node)) {
    // A deferred composition fan-out (#2512) carries the same live ref surfaces as a
    // `workflow:` node — its `with:` values and `fan_out.items` resolve at run time.
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) {
        if (typeof value === 'string') node.with[key] = code(value);
      }
    }
    if (node.fan_out !== undefined) node.fan_out.items = code(node.fan_out.items);
  } else if (isHaltNode(node)) {
    node.reason = code(node.reason);
  } else if (isAgentNode(node) && node.source.kind === 'inline') {
    node.source.prompt = code(node.source.prompt);
  }

  // Node-local bindings (#2637) — an agent's command-sourced `with:` and an exec node's
  // `with:` string values, plus directive `from` refs, are live ref surfaces (KEEP IN
  // SYNC item 2), so an included block's bindings follow its nodes' namespace rename.
  // Outside the mode chain above because a command-sourced agent node has no other
  // inline text surface of its own.
  const nodeWith = isExecNode(node)
    ? node.with
    : isAgentNode(node) && node.source.kind === 'command'
      ? node.source.with
      : undefined;
  if (nodeWith !== undefined) {
    for (const [key, value] of Object.entries(nodeWith)) {
      if (typeof value === 'string') nodeWith[key] = code(value);
      else if (isBindingDirective(value)) value.from = code(value.from);
    }
  }
}

/**
 * Apply an include node's input mapping to every inline text surface in the cloned node.
 * Unlike output-ref rewriting, substitutions also apply inside Markdown code spans because
 * `$INPUTS` has no documentation-only meaning. An inserted value may itself be a
 * `$node.output` reference; it deliberately remains unresolved for the executor's existing
 * runtime substitution pass.
 *
 * This walks the same field set as rewriteNodeOutputRefs. It was deliberately a SUPERSET
 * until #1764 — it added systemPrompt and agents.*, which took include inputs but had no
 * runtime substitution pass — and that asymmetry is exactly what made a workflow using
 * `$INPUTS.<name>` in a `systemPrompt:` resolve when composed and stay literal standalone
 * (#2476). Those fields are ordinary runtime surfaces now, so the two sets agree.
 *
 * The asymmetry in FAILURE MODE remains, and is why a missed surface matters more here:
 *
 *   - a surface rewriteNodeOutputRefs misses is only a NAMESPACING miss; the executor's
 *     substituteNodeOutputRefs pass still resolves the ref at run time.
 *   - a surface this function misses is permanent. The literal `$INPUTS.<name>` reaches
 *     the model as text, and because the field was never visited the name never reaches
 *     `missing` either — so a caller who forgot to supply it gets no load error.
 *
 * Every model-facing string field must be walked for include inputs. A future field that
 * takes include inputs but is NOT a runtime node-ref surface would reopen the #2476 gap;
 * it belongs in one of these two functions, not silently in this one alone.
 */
function applyInputsMacro(
  node: DagNode,
  args: Record<string, JsonValue>,
  missing: Set<string>,
  includeNode: IncludeDirective
): void {
  const substitute = (text: string): string =>
    text.replace(INPUTS_REF, (match, name: string) => {
      // `Object.hasOwn` rather than a plain `args[name]` lookup: a bare index read reaches
      // Object.prototype, so an unsupplied `$INPUTS.toString` / `$INPUTS.constructor`
      // would resolve to an inherited member and splice a native function body into the
      // prompt instead of being reported as a missing input. Anything not supplied as an
      // OWN key is missing, and missing always fails the load — never a silent passthrough.
      if (!Object.hasOwn(args, name)) {
        missing.add(name);
        return match;
      }
      // Canonical text (#2637): a typed input splices as its one deterministic
      // representation (strings raw, everything else canonical JSON text).
      return canonicalValueText(args[name]);
    });

  // Value-position substitution (#2637): in a `with:` map value, a string that is
  // EXACTLY `$INPUTS.<name>` forwards the LOGICAL input value (a boolean stays a
  // boolean through nested composition); any other string splices text as usual, and
  // non-strings carry no macro at all.
  const substituteValue = (value: JsonValue): JsonValue => {
    if (typeof value !== 'string') return value;
    const name = parseWholeInputsRef(value);
    if (name !== undefined) {
      if (Object.hasOwn(args, name)) return args[name];
      missing.add(name);
      return value;
    }
    return substitute(value);
  };

  const substituteWhen = (when: string): string => {
    const expanded = substitute(when);
    const wasParseable = whenAtoms(when).every(atom => parseWhenAtom(atom) !== null);
    const isParseable = whenAtoms(expanded).every(atom => parseWhenAtom(atom) !== null);
    if (expanded !== when && wasParseable && !isParseable) {
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input substitution made included node '${node.id}' field 'when' unparseable: "${when}" became "${expanded}". Put '$INPUTS.<name>' on the right-hand side of a comparison whose left-hand side is a node-output reference.`
      );
    }
    return expanded;
  };

  if (node.when !== undefined) node.when = substituteWhen(node.when);

  // An inherited stamp's values may reference THIS level's inputs — `with: { plan:
  // '$INPUTS.topic' }` one file down. Without this walk the stamp keeps the literal
  // `$INPUTS.topic` and the composed script receives the token instead of the value.
  // Value-position semantics (#2637): a whole-`$INPUTS.<name>` stamp forwards the
  // logical value; typed stamps pass through.
  const stamped = readComposedMeta(node)?.inputs;
  if (stamped !== undefined) {
    for (const [key, value] of Object.entries(stamped)) stamped[key] = substituteValue(value);
  }
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    if (boundary.when !== undefined) boundary.when = substituteWhen(boundary.when);
  }

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
    for (const body of node.loop_group.nodes) {
      if (!isIncludeDirective(body)) applyInputsMacro(body, args, missing, includeNode);
    }
  } else if (isGateNode(node)) {
    node.message = substitute(node.message);
    for (const decision of node.decisions) {
      if (decision.rework !== undefined)
        decision.rework.prompt = substitute(decision.rework.prompt);
    }
  } else if (isExecNode(node)) {
    node.script = substitute(node.script);
  } else if (isWaitNode(node)) {
    if (node.wait.until !== undefined) node.wait.until = substitute(node.wait.until);
    if (node.wait.event !== undefined) node.wait.event = substitute(node.wait.event);
  } else if (isWorkflowNode(node)) {
    // `input:` is the child's $ARGUMENTS — a TEXT channel by construction, so a typed
    // input splices as canonical text there; `with:` values are typed positions.
    if (node.input !== undefined) node.input = substitute(node.input);
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) {
        node.with[key] = substituteValue(value);
      }
    }
    if (node.fan_out !== undefined) node.fan_out.items = substitute(node.fan_out.items);
  } else if (isComposeFanOutNode(node)) {
    // Same $INPUTS surfaces as a `workflow:` node (#2512): the deferred fan-out binds
    // its block inputs exactly where the static directive does — typed positions in
    // `with:`, text substitution in `fan_out.items`.
    if (node.with !== undefined) {
      for (const [key, value] of Object.entries(node.with)) {
        node.with[key] = substituteValue(value);
      }
    }
    if (node.fan_out !== undefined) node.fan_out.items = substitute(node.fan_out.items);
  } else if (isHaltNode(node)) {
    node.reason = substitute(node.reason);
  } else if (isAgentNode(node) && node.source.kind === 'inline') {
    node.source.prompt = substitute(node.source.prompt);
  }

  // Node-local bindings (#2637): an agent's command-sourced `with:` and an exec node's
  // `with:` value positions accept block inputs like every other with map; a
  // directive's `from` is a node ref (never an input), while a string `if_skipped`
  // default may carry the macro.
  //
  // Re-validate what substitution could have broken (the same pass substituteWhen
  // runs for `when:` grammar): the schema promises that on a command-sourced agent or
  // exec node an object `with:` value is a load error unless it is a binding
  // directive, and only substitution can put an object here after that check ran — a
  // caller forwarding an object through a whole-`$INPUTS.<name>` value. Letting it
  // through would turn the promised load error into a mid-run node failure after
  // every upstream node has already spent its cost; and treating a directive-SHAPED
  // caller object as a live directive would let data inject reference semantics the
  // block never wrote.
  const nodeWith = isExecNode(node)
    ? node.with
    : isAgentNode(node) && node.source.kind === 'command'
      ? node.source.with
      : undefined;
  if (nodeWith !== undefined) {
    for (const [key, value] of Object.entries(nodeWith)) {
      if (isBindingDirective(value)) {
        if (typeof value.if_skipped === 'string') {
          value.if_skipped = substituteValue(value.if_skipped);
        }
      } else {
        const substituted = substituteValue(value);
        if (
          substituted !== null &&
          typeof substituted === 'object' &&
          !Array.isArray(substituted)
        ) {
          throw new IncludeExpansionError(
            `Node '${includeNode.id}': input substitution supplied an OBJECT to binding '${key}' of included node '${node.id}' (value '${canonicalValueText(value)}'). Command/script binding values must be strings, numbers, booleans, null, or arrays; a binding directive must be authored in the block itself, never forwarded through an input.`
          );
        }
        nodeWith[key] = substituted;
      }
    }
  }
}

export interface ExpandedInclude {
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
  includeNode: IncludeDirective,
  child: WorkflowDefinition
): Record<string, JsonValue> {
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

/** structuredClone intentionally drops symbol keys; retain every engine-private
 * per-node payload (compiled loop commands, the composition record) while cloning a
 * reusable child for another include level. A payload missed here works at one nesting
 * level and silently vanishes at two. */
function cloneNodeForInclude<T extends DagNode | IncludeDirective>(node: T): T {
  const clone = structuredClone(node);
  const preserveEngineMetadata = (
    source: DagNode | IncludeDirective,
    target: DagNode | IncludeDirective
  ): void => {
    if (isIncludeDirective(source) || isIncludeDirective(target)) return;
    const meta = readComposedMeta(source);
    if (meta !== undefined) {
      (target as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = structuredClone(meta);
    }
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
        if (targetChild !== undefined) preserveEngineMetadata(sourceChild, targetChild);
      }
    }
  };
  preserveEngineMetadata(node, clone);
  return clone;
}

/**
 * Inline one include node's fully-expanded child into namespaced parent nodes.
 * Never mutates the child's nodes (each node is deep-cloned first), so a building block
 * shared by two parents is namespaced independently.
 */
function inlineInclude(
  includeNode: IncludeDirective,
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
  // `child` is the result of `expandOne`, which fully expands its own includes before
  // returning (the function's own documented invariant: "Output workflows contain
  // ZERO include nodes") — so `child.nodes` never actually holds an `IncludeDirective`
  // here, even though `WorkflowDefinition.nodes`'s type admits one for the general
  // pre-expansion case (#2486; splitting an authored-vs-resolved `WorkflowDefinition`
  // type is #2487's job, not this one's).
  const childNodes = child.nodes as DagNode[];
  const prefix = `${includeNode.id}__`;
  const childTopLevelIds = new Set(childNodes.map(n => n.id));
  const rename = (id: string): string => (childTopLevelIds.has(id) ? prefix + id : id);

  // Sinks: child top-level nodes that nothing else in the child depends on (definition order).
  const childDeps = new Set(childNodes.flatMap(n => n.depends_on ?? []));
  const sinkOriginalIds = childNodes.filter(n => !childDeps.has(n.id)).map(n => n.id);

  const parentDeps = includeNode.depends_on ?? [];
  const entryTriggerRules = childNodes
    .filter(node => (node.depends_on ?? []).length === 0)
    .map(node => node.trigger_rule ?? includeNode.trigger_rule ?? 'all_success');
  const [firstEntryTriggerRule, ...remainingEntryTriggerRules] = entryTriggerRules;
  if (firstEntryTriggerRule === undefined) {
    throw new IncludeExpansionError(
      `Node '${includeNode.id}': included workflow '${child.name}' has no entry node`
    );
  }
  const hasActivationBoundary = parentDeps.length > 0 || includeNode.when !== undefined;
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
    const boundary: ComposedBlockBoundary = wasEntry
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

    // Rewrite child-internal refs before inserting caller values. This ordering is
    // load-bearing: a caller ref such as `$gather.output` must remain parent-scoped even
    // when the included block also has a node named `gather`.
    rewriteNodeOutputRefs(clone, rename, id => [rename(id)], rename);
    applyInputsMacro(clone, resolvedInputs, missingInputs, includeNode);
    // Stamped AFTER both passes, for the same reason the caller's values are inserted
    // after the rename: these are the CALLER's strings, so they stay parent-scoped here
    // and are walked by the next level out, not by this one. Each node gets its own copy
    // so one node's rewrite cannot reach another's.
    markComposedNode(clone, {
      origin: child.name,
      ...(Object.keys(resolvedInputs).length > 0 ? { inputs: { ...resolvedInputs } } : {}),
      ...(wasEntry ? { blockEntry: true as const } : {}),
      ...(hasActivationBoundary
        ? {
            boundaries: [boundary],
          }
        : {}),
    });
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
 * Instantiate one already-resolved block through the ordinary include primitive.
 * Deferred-width composition resolves and validates the block closure once at load,
 * then calls this narrow operation for each runtime item without rediscovering or
 * recompiling the workflow graph.
 */
export function instantiateResolvedInclude(
  includeNode: IncludeDirective,
  child: WorkflowDefinition,
  commandContents: ReadonlyMap<string, IncludeCommandContent> = new Map()
): ExpandedInclude {
  return inlineInclude(includeNode, child, commandContents);
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
  // Run-owned like `returns`: an included file's authored outcome is not
  // propagated to its composer, while the top-level workflow keeps its own
  // declaration through flattening.
  'outcome_field',
  'inputs',
  // #1764: unioned into the composing workflow's own requirement set, not dropped.
  'requires',
]);

/** Isolation/concurrency-safety fields — a silent drop of these is the most dangerous. */
const SAFETY_WORKFLOW_KEYS: ReadonlySet<string> = new Set(['mutates_checkout']);
const COMPOSE_FAN_OUT_CONSUMED_WORKFLOW_KEYS: ReadonlySet<string> = new Set(['mutates_checkout']);

/**
 * What remains of the included file's workflow-level configuration after the collapse is
 * RUN-owned: isolation, interactivity, evidence policy, concurrency safety. Those are
 * decisions belonging to whoever started the run, so a composed workflow cannot carry
 * them — emit a one-line load-time WARN so the author who wrote them gets a signal.
 *
 * The set is DERIVED from the child's own defined keys rather than hand-maintained, so a
 * future workflow-level field is covered automatically: it either travels (by joining
 * NODE_AFFECTING_WORKFLOW_FIELDS, which deletes it before this runs), is consumed by
 * inlining (NON_DROPPED_WORKFLOW_KEYS), or shows up here.
 *
 * One case this does NOT report, by construction: PARTIAL travel. A travelling field is
 * deleted whether or not it reached every node — `workflowModelTravelsTo` skips a node
 * that switches provider, and `persist_session` skips a non-AI node or a loop_group body.
 * Those skips are deliberate and behaviour-preserving (each mirrors a condition the
 * executor already applied), so there is nothing new to warn about; but do not read this
 * warning as proof that a field reached everything.
 *
 * `webSearchMode` is the one field that is neither run-owned nor able to travel — it has
 * no node-level counterpart to land on (#2556) — so it is named explicitly rather than
 * left to read as a run-level decision it is not.
 */
function warnDroppedWorkflowLevelFields(
  includeNode: IncludeDirective,
  child: WorkflowDefinition,
  consumedFields?: ReadonlySet<string>
): void {
  const childRecord = child as Record<string, unknown>;
  const droppedFields = Object.keys(child)
    .filter(
      key =>
        !NON_DROPPED_WORKFLOW_KEYS.has(key) &&
        consumedFields?.has(key) !== true &&
        childRecord[key] !== undefined
    )
    .sort();
  if (droppedFields.length === 0) return;

  const safetyDropped = droppedFields.filter(f => SAFETY_WORKFLOW_KEYS.has(f));

  getLog().warn(
    {
      include: includeNode.id,
      target: child.name,
      droppedFields,
      ...(child.webSearchMode !== undefined
        ? {
            webSearchModeNote:
              'webSearchMode: has no per-node form, so it cannot travel with a composed workflow — set it on the TOP-LEVEL workflow if the block relies on it (it then applies to every node in the run)',
          }
        : {}),
      ...(safetyDropped.length > 0
        ? {
            safetyNote: `${safetyDropped.join(' and ')} affect isolation/concurrency safety and belong to the RUN — set them on the TOP-LEVEL workflow if the block relies on them`,
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
  includeNode: IncludeDirective,
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

  if (isAgentNode(node) && node.source.kind === 'command') {
    const compiled = compile(node.source.name);
    if (compiled.error !== undefined) throw new IncludeExpansionError(compiled.error);
    // `with:` on a command node is already inert past this point at runtime today —
    // `executeNodeInternal`'s binding resolution gates on the node still carrying a
    // `command` reference (dag-executor.ts), which a materialized node no longer
    // does — so dropping it here is behavior-preserving, not a regression.
    return { ...node, source: { kind: 'inline', prompt: compiled.prompt } };
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
    // A loop_group body is expanded (include-free) by the same recursive invariant
    // as the top-level `childNodes` this function is ultimately called against.
    const bodyNodes = node.loop_group.nodes as DagNode[];
    const bodyIds = new Set(bodyNodes.map(body => body.id));
    const bodyEnclosingIds = new Set([...enclosingIds, ...currentIds]);
    return {
      ...node,
      loop_group: {
        ...node.loop_group,
        nodes: bodyNodes.map(body =>
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

  interface ExpandedNodeList {
    nodes: DagNode[];
    includedRequirements: WorkflowRequirement[];
    renameIncludeRef: (id: string) => string;
  }

  /**
   * Expand one statically scoped node list. The workflow's top-level DAG and every
   * loop_group body each own an independent include-id namespace: dependencies and
   * `$include.output` refs bind only to directives in that list.
   */
  function expandNodeList(
    nodes: (DagNode | IncludeDirective)[],
    workflowName: string,
    stack: string[]
  ): ExpandedNodeList {
    const expandedNodes: DagNode[] = [];
    const includesById = new Map<string, ExpandedInclude>();
    const includedRequirements: WorkflowRequirement[] = [];

    for (const node of nodes) {
      // Runtime width stays deferred, while the complete body contract is proven now.
      if (isComposeFanOutNode(node)) {
        // Width is runtime data, but the body remains ordinary static composition.
        // Expanding it here validates its complete include closure and carries its
        // requirements onto the parent before any upstream node can spend.
        let child: WorkflowDefinition;
        try {
          child = expandOne(node.include, [...stack, workflowName]);
        } catch (e) {
          if (e instanceof IncludeExpansionError) {
            throw new IncludeExpansionError(`Node '${node.id}': ${e.message}`);
          }
          throw e;
        }
        const suspensionPaths = collectComposedSuspensionPaths(
          rawByName.get(node.include) ?? child,
          [...rawByName.values()]
        );
        if (suspensionPaths.length > 0) {
          const details = suspensionPaths.map(path => `'${path.id}' (${path.reason})`).join(', ');
          throw new IncludeExpansionError(
            `Node '${node.id}': composed fan-out block '${node.include}' contains unsupported suspension-capable path${suspensionPaths.length === 1 ? '' : 's'} ${details}. Composed fan-out is currently limited to deterministic, non-interactive bodies because the parent has no durable per-item pause cursor. Put gates and waits before or after the fan-out, use governed child runs, or follow #2810 for interactive instance support.`
          );
        }
        warnDroppedWorkflowLevelFields(
          { id: node.id, kind: 'include', include: node.include },
          child,
          COMPOSE_FAN_OUT_CONSUMED_WORKFLOW_KEYS
        );
        // Exercise the exact ordinary-include instantiation once at load time. Width is
        // still deferred, but the block's input contract and packaged command resources
        // are static and must fail before upstream nodes can spend.
        instantiateResolvedInclude(
          {
            id: node.id,
            kind: 'include',
            include: node.include,
            ...(node.with !== undefined
              ? { with: { ...node.with, [node.fan_out.as]: null } }
              : {
                  with: { [node.fan_out.as]: null },
                }),
          },
          child,
          commandContents ?? new Map()
        );
        includedRequirements.push(...(child.requires ?? []));
        expandedNodes.push(node);
        continue;
      }

      if (isIncludeDirective(node)) {
        let child: WorkflowDefinition;
        try {
          child = expandOne(node.include, [...stack, workflowName]);
        } catch (e) {
          if (e instanceof IncludeExpansionError) {
            throw new IncludeExpansionError(`Node '${node.id}': ${e.message}`);
          }
          throw e;
        }
        warnDroppedWorkflowLevelFields(node, child);
        includedRequirements.push(...(child.requires ?? []));
        const inlined = instantiateResolvedInclude(node, child, commandContents ?? new Map());
        includesById.set(node.id, inlined);
        expandedNodes.push(...inlined.namespaced);
        continue;
      }

      if (isLoopGroupNode(node)) {
        const body = expandNodeList(node.loop_group.nodes, workflowName, stack);
        includedRequirements.push(...body.includedRequirements);
        expandedNodes.push({
          ...node,
          loop_group: {
            ...node.loop_group,
            // The completion script runs against THIS body's output map. Rebind an
            // authored `$include.output` to the included workflow's declared return,
            // just as refs on ordinary sibling body nodes are rebound below.
            ...(node.loop_group.until_bash !== undefined
              ? {
                  until_bash: applyOutputRefRename(
                    node.loop_group.until_bash,
                    body.renameIncludeRef
                  ),
                }
              : {}),
            nodes: body.nodes,
          },
        });
        continue;
      }

      // Already a private clone — `collapseWorkflowScope` cloned every node before
      // writing this workflow's config onto it, so the second pass below can mutate
      // it without reaching the raw parsed definition discovery still holds.
      expandedNodes.push(node);
    }

    // Rewrite only aliases owned by this list. `rewriteNodeOutputRefs` deliberately
    // recurses into nested loop_group bodies because their text may read enclosing
    // outputs, while their sealed depends_on edges remain local to their own list.
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

    return { nodes: expandedNodes, includedRequirements, renameIncludeRef };
  }

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
    const expanded = expandNodeList(collapsed.nodes, name, stack);
    const requires: WorkflowRequirement[] = [
      ...(collapsed.requires ?? []),
      ...expanded.includedRequirements,
    ];

    // Re-validate the fully-flattened DAG. Catches a namespaced id colliding with a
    // hand-written node, cycles introduced by edge rewiring, unknown deps, and the
    // equivalent failures inside every recursively expanded loop_group body.
    //
    // Deliberately NOT re-running the workflow-class placement check here (#2707 step
    // 2): a reusable block can legitimately author a native gate without declaring its
    // own `interactive: true` — it is only ever a load error for the workflow ACTUALLY
    // being loaded standalone (`parseWorkflow`'s own single-file check already covers
    // that), not for every name `expandWorkflowIncludes` happens to also process as a
    // `rawByName` entry. A composed gate's drivability stays exactly what it was before
    // this PR — an invocation-time question `assertComposedGateDriveable` answers
    // against the workflow actually being dispatched, because load time cannot tell
    // which discovered workflow will own a given run (see that function's doc comment;
    // `expandWorkflowIncludes — composed approval gates are stamped, not rejected
    // (#1764)` pins this down with a "non-interactive INTERMEDIATE block still expands"
    // case).
    const structureError = validateDagStructure(expanded.nodes);
    if (structureError) {
      throw new IncludeExpansionError(structureError);
    }

    const dedupedRequires = [...new Set(requires)];
    const result: WorkflowDefinition = {
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
    const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(result);
    if (outcomeDeclarationError !== null) {
      throw new IncludeExpansionError(outcomeDeclarationError);
    }
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
