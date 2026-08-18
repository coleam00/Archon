/**
 * Which provider and model a node will actually run on — and where each value came from.
 *
 * This is the resolution chain ALONE, extracted from `resolveNodeProviderAndModel`
 * (dag-executor.ts) so a dry run can report the same answer the executor will produce
 * (#1764). The executor's own function is `async` and takes a platform + conversation id
 * because it MESSAGES the user about capability mismatches; calling it from a dry run
 * would send chat messages for a run that never happens. Reimplementing the chain in
 * dry-run.ts instead would guarantee drift, which turns a legibility feature into an
 * actively misleading one — so both callers go through here.
 *
 * Pure: no I/O, no messaging, no registry mutation.
 */
import { isLiteralSpec, resolveModelSpec, isTierName } from './model-validation';
import type { ModelAliasPreset, ResolvedAiProfile, TierName } from './model-validation';
import type { DagNode } from './schemas';
import { readComposedMeta } from './compiled-command';

/**
 * Where a resolved value came from, most specific first.
 *
 * `node` covers a value the node itself declares — which, after composition collapses a
 * workflow's config onto its own nodes (#1764), is also how a value declared by that
 * node's OWN workflow file arrives. `authoredIn` names that file, so a reader can tell
 * the two apart without the engine keeping a second resolution layer to do it.
 */
export type ResolutionOrigin =
  | 'node'
  | 'model ref'
  | 'workflow'
  | 'assistant config'
  | 'default assistant'
  | 'unset';

export interface NodeModelResolution {
  provider: string;
  model: string | undefined;
  /** Reasoning depth before any provider capability gate is applied. */
  effort: string | undefined;
  /** Reasoning depth the AUTHOR declared (node or workflow), before any preset fills in. */
  declaredEffort: string | undefined;
  /** Tier keyword when the effective model ref was one — drives `node_started` attribution. */
  tier: TierName | undefined;
  /** Set when the node's `model:` resolved through a tier or `@alias` preset. */
  preset: ModelAliasPreset | undefined;
  providerOrigin: ResolutionOrigin;
  modelOrigin: ResolutionOrigin;
  effortOrigin: ResolutionOrigin;
  /** The workflow file this node was authored in, when it arrived through `include:`. */
  authoredIn: string | undefined;
  /**
   * The node names one provider while its `model:` ref resolves to another. The executor
   * warns the user and uses the resolved one; reported here so a dry run can too.
   */
  providerConflict?: { declared: string; resolved: string; modelRef: string };
}

/** The workflow-level fallbacks the executor threads alongside each node. */
export interface WorkflowModelScope {
  provider: string;
  model: string | undefined;
  preset: ModelAliasPreset | undefined;
  tier: TierName | undefined;
  /** Workflow-level `effort:`, still read as a per-node fallback. */
  effort: string | undefined;
  /** Where the scope's own provider came from, so a node inheriting it can say. */
  providerOrigin: ResolutionOrigin;
}

/**
 * Resolve one node's provider, model and reasoning depth.
 *
 * Mirrors dag-executor's chain exactly, including the two conditions that are easy to get
 * wrong: a workflow-level model applies only when the node resolves to the workflow's own
 * provider, and a workflow-level PRESET applies only when the node declares no `model:`
 * of its own. Both exist so a node that switches provider never inherits the other
 * provider's model string.
 */
export function resolveNodeModel(
  node: DagNode,
  scope: WorkflowModelScope,
  assistantModels: Readonly<Record<string, string | undefined>>,
  aiProfile?: ResolvedAiProfile
): NodeModelResolution {
  let provider = node.provider ?? scope.provider;
  let providerOrigin: ResolutionOrigin = node.provider ? 'node' : scope.providerOrigin;
  let preset: ModelAliasPreset | undefined;
  let model: string | undefined;
  let modelOrigin: ResolutionOrigin = 'unset';
  let providerConflict: NodeModelResolution['providerConflict'];

  if (node.model) {
    modelOrigin = 'node';
    if (aiProfile) {
      const spec = resolveModelSpec(aiProfile, node.model);
      if (isLiteralSpec(spec)) {
        model = spec.literal;
      } else {
        preset = spec;
        provider = spec.provider;
        model = spec.model;
        modelOrigin = 'model ref';
        providerOrigin = 'model ref';
        if (node.provider && node.provider !== provider) {
          providerConflict = {
            declared: node.provider,
            resolved: provider,
            modelRef: node.model,
          };
        }
      }
    } else {
      model = node.model;
    }
  }

  if (model === undefined) {
    // Exact mirror of the executor's `model ??= provider === workflowProvider ?
    // workflowModel : providerAssistantConfig?.model`. Note the asymmetry: when the node
    // resolves to the workflow's own provider there is NO further fallback — the caller
    // has already folded the assistant default into `scope.model`.
    if (provider === scope.provider) {
      model = scope.model;
      modelOrigin = model !== undefined ? 'workflow' : 'unset';
    } else {
      model = assistantModels[provider];
      modelOrigin = model !== undefined ? 'assistant config' : 'unset';
    }
  }

  const effectivePreset =
    preset ?? (!node.model && provider === scope.provider ? scope.preset : undefined);

  // What the author declared, before a preset fills in and before the provider's
  // capability gate drops it — the executor threads exactly this value into both
  // `applyPresetOptions` and its capability check, so the two cannot disagree.
  const declaredEffort = node.effort ?? scope.effort;
  const effort = declaredEffort ?? effectivePreset?.effort;
  const effortOrigin: ResolutionOrigin =
    node.effort !== undefined
      ? 'node'
      : scope.effort !== undefined
        ? 'workflow'
        : effectivePreset?.effort !== undefined
          ? 'model ref'
          : 'unset';

  const tier =
    node.model && isTierName(node.model)
      ? node.model
      : !node.model && provider === scope.provider
        ? scope.tier
        : undefined;

  return {
    provider,
    model,
    effort,
    declaredEffort,
    tier,
    preset: effectivePreset,
    providerOrigin,
    modelOrigin,
    effortOrigin,
    authoredIn: readComposedMeta(node)?.origin,
    ...(providerConflict ? { providerConflict } : {}),
  };
}

/**
 * Derive the workflow-level fallbacks from a definition. `executor.ts` calls this and
 * layers its user-facing warning and the unknown-provider throw on top, exactly as
 * `resolveNodeProviderAndModel` wraps `resolveNodeModel` one level down — so a dry run
 * cannot report a different workflow-level scope than the run uses.
 *
 * After the #1764 collapse a discovered workflow carries no node-affecting fields, so
 * this normally reduces to `config.assistant` — but a programmatic caller can still hand
 * over an unexpanded definition, and the fallbacks have to behave the same for it.
 */
export function resolveWorkflowModelScope(
  workflow: { provider?: string; model?: string; effort?: string },
  defaultAssistant: string,
  assistantModels: Readonly<Record<string, string | undefined>>,
  aiProfile?: ResolvedAiProfile
): WorkflowModelScope {
  let provider = workflow.provider ?? defaultAssistant;
  let model: string | undefined;
  let preset: ModelAliasPreset | undefined;
  if (workflow.model && aiProfile) {
    const spec = resolveModelSpec(aiProfile, workflow.model);
    if (isLiteralSpec(spec)) {
      model = spec.literal;
    } else {
      preset = spec;
      provider = spec.provider;
      model = spec.model;
    }
  } else if (workflow.model) {
    model = workflow.model;
  }
  model ??= assistantModels[provider];
  return {
    provider,
    model,
    preset,
    tier: workflow.model && isTierName(workflow.model) ? workflow.model : undefined,
    effort: workflow.effort,
    // The preset is checked FIRST because when one resolves, its provider is what won —
    // `provider` was reassigned from `spec.provider` above, overriding any `provider:` the
    // workflow declared (the executor warns about exactly that case). Reporting the
    // overridden value as the origin would name the loser. Matches `resolveNodeModel`,
    // which sets 'model ref' inside its own preset branch for the same reason.
    providerOrigin: preset ? 'model ref' : workflow.provider ? 'workflow' : 'default assistant',
  };
}

/**
 * Per-provider default model from an install's `assistants:` block, in the shape the
 * resolver takes. Kept here beside its only consumers so the `as string | undefined`
 * narrowing of an untyped config value happens once.
 */
export function assistantModelDefaults(config: {
  assistants: Record<string, Record<string, unknown> | undefined>;
}): Record<string, string | undefined> {
  const models: Record<string, string | undefined> = {};
  for (const [provider, assistant] of Object.entries(config.assistants)) {
    const model = assistant?.model;
    if (typeof model === 'string') models[provider] = model;
  }
  return models;
}
