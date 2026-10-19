import { createLogger } from '@archon/paths';
import type {
  DagNode,
  DagNodeBase,
  IncludeDirective,
  ResolvedWorkflow,
  WorkflowBase,
  WorkflowDefinition,
} from '../schemas';
import { isIncludeDirective, isLoopGroupNode, isPersistableNode } from '../schemas';
import { cloneNodeWithEngineMetadata } from '../compiled-command';

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
 * Workflow-level fields that describe how a workflow's OWN NODES execute, paired with
 * the node-level field each lands on. Every one has a node-level equivalent the DAG
 * executor reads FIRST (`node.X ?? workflowLevelOptions.X`), so writing the value onto
 * the node is equivalent to the workflow-level path — which is what lets the
 * workflow-level layer be REMOVED afterwards (see `collapseWorkflowScope`).
 *
 * Absent on purpose:
 *   - Run-owned fields (`worktree`, `container`, `evidence_policy`, `budget`,
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
    if (isIncludeDirective(node)) continue;
    pushWorkflowScopeOntoNode(scope, node, insideLoopGroup);
    if (isLoopGroupNode(node)) {
      pushWorkflowScopeOntoNodes(scope, node.loop_group.nodes, true);
    }
  }
}

function pushWorkflowScopeOntoNode(
  scope: Record<string, unknown>,
  node: DagNode,
  insideLoopGroup: boolean
): void {
  const target = node as unknown as Record<string, unknown>;
  for (const [wfKey, nodeKey] of NODE_AFFECTING_WORKFLOW_FIELDS) {
    const value = scope[wfKey];
    if (value === undefined) continue;
    if (target[nodeKey] !== undefined) continue; // the node's own value always wins
    if (!workflowFieldTravelsTo(scope, nodeKey, node, insideLoopGroup)) continue;
    target[nodeKey] = value;
  }
}

function workflowFieldTravelsTo(
  scope: Record<string, unknown>,
  nodeKey: keyof DagNodeBase,
  node: DagNode,
  insideLoopGroup: boolean
): boolean {
  if (nodeKey === 'model') return workflowModelTravelsTo(scope, node);
  // `persist_session` only means something on a node that takes an AI turn and can
  // resume one, and never inside a loop_group body (see pushWorkflowScopeOntoNodes).
  if (nodeKey === 'persist_session') return !insideLoopGroup && isPersistableNode(node);
  return true;
}

/**
 * Collapse a workflow's node-affecting scope onto its own nodes and REMOVE that scope
 * from the definition — the load-time transform behind "a workflow runs as authored"
 * (#1764).
 *
 * The removal is the load-bearing half, not a tidy-up. Push-down alone leaves a node
 * that declares nothing free to fall back to `workflowLevelOptions`, which after
 * inlining belongs to whichever file composed it — so a block declaring no provider at
 * all still runs on the parent's. With the layer gone
 * such a node resolves from config, tier presets and user prefs at run time, exactly as
 * it would standalone.
 *
 * Runs on EVERY workflow, not only composed ones: a workflow must not behave differently
 * depending on whether it happens to contain an `include:`. That is why the old
 * byte-for-byte fast path for include-free workflows had to go.
 */
export function collapseWorkflowScope(raw: WorkflowDefinition): WorkflowDefinition {
  const collapsed: WorkflowDefinition = {
    ...raw,
    nodes: raw.nodes.map(cloneNodeWithEngineMetadata),
  };
  const scope = collapsed as unknown as Record<string, unknown>;
  pushWorkflowScopeOntoNodes(scope, collapsed.nodes);
  // Deleted rather than set to `undefined` so the collapsed definition has the shape a
  // workflow that never declared these would have — it is spread into the expanded result
  // and serialized by the workflows API, and a present-but-undefined key survives both.
  // (The drop-warning is indifferent: it already filters `!== undefined`.) The key set is
  // this module's own const tuple list, never caller input.
  for (const [wfKey] of NODE_AFFECTING_WORKFLOW_FIELDS) {
    delete scope[wfKey];
  }
  return collapsed;
}

/**
 * Workflow-level keys that are NOT dropped-config and must be excluded from the warning.
 *   - name/description: the block's identity, never inheritable config.
 *   - nodes: not dropped — they ARE what gets inlined.
 *   - plan: engine-owned metadata consumed while inlining, never authored config.
 *   - tags: cosmetic UI keyword-inference metadata with no runtime effect, so dropping it
 *     is behaviorally inert; reporting it would be noise.
 */
const NON_DROPPED_WORKFLOW_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'nodes',
  'plan',
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
  // A notice for launching this file directly. Inlining never launches it, so there
  // is nothing to carry; warning "dropped" would fire on every discovery of a
  // composer that includes a deprecated block.
  'deprecated',
]);

/** Isolation/concurrency-safety fields — a silent drop of these is the most dangerous. */
const SAFETY_WORKFLOW_KEYS: ReadonlySet<string> = new Set(['mutates_checkout']);

/**
 * What remains of the included file's workflow-level configuration after the collapse is
 * RUN-owned: isolation, evidence policy, concurrency safety. Those are
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
export function warnDroppedWorkflowLevelFields(
  includeNode: IncludeDirective,
  child: ResolvedWorkflow
): void {
  const droppedFields = Object.entries(child)
    .filter(([key, value]) => !NON_DROPPED_WORKFLOW_KEYS.has(key) && value !== undefined)
    .map(([key]) => key)
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
