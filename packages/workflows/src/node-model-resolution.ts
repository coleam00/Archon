import { NoDefaultProviderError } from '@archon/provider-contract';
/**
 * Which provider and model a node will actually run on — and where each value came from.
 *
 * This is the resolution chain ALONE, extracted from `resolveNodeProviderAndModel`
 * (dag/provider-resolution.ts) so a dry run can report the same answer the executor will produce
 * (#1764). The executor's own function is `async` and takes a platform + conversation id
 * because it MESSAGES the user about capability mismatches; calling it from a dry run
 * would send chat messages for a run that never happens. Reimplementing the chain in
 * the dry run instead would guarantee drift, which turns a legibility feature into an
 * actively misleading one — so both callers go through here.
 *
 * Pure: no I/O, no messaging, no registry mutation.
 */
import { isLiteralSpec, resolveModelSpec, isTierName, selectModelRef } from './model-validation';
import type {
  ModelAliasPreset,
  WorkflowModelRef,
  ResolvedAiProfile,
  TierName,
} from './model-validation';
import type { DagNode, EffortLevel } from './schemas';
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
  effort: EffortLevel | undefined;
  /** Reasoning depth the AUTHOR declared (node or workflow), before any preset fills in. */
  declaredEffort: EffortLevel | undefined;
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
  provider: string | undefined;
  model: string | undefined;
  preset: ModelAliasPreset | undefined;
  tier: TierName | undefined;
  /** Workflow-level `effort:`, still read as a per-node fallback. */
  effort: EffortLevel | undefined;
  /** Where the scope's own provider came from, so a node inheriting it can say. */
  providerOrigin: ResolutionOrigin;
}

/**
 * Resolve one node's provider, model and reasoning depth.
 *
 * This is the one chain execution, dry run and run preflight share, including the two
 * conditions that are easy to get wrong: a workflow-level model applies only when the
 * node resolves to the workflow's own provider, and a workflow-level PRESET applies only
 * when the node declares no `model:` of its own. Both exist so a node that switches
 * provider never inherits the other provider's model string.
 */
export function resolveNodeModel(
  node: DagNode,
  scope: WorkflowModelScope,
  assistantModels: Readonly<Record<string, string | undefined>>,
  aiProfile?: ResolvedAiProfile
): NodeModelResolution {
  const resolved = resolveNodeModelScope(node, scope, assistantModels, aiProfile);
  if (resolved.provider === undefined) throw new NoDefaultProviderError();
  return { ...resolved, provider: resolved.provider };
}

export function resolveNodeModelScope(
  node: DagNode,
  scope: WorkflowModelScope,
  assistantModels: Readonly<Record<string, string | undefined>>,
  aiProfile?: ResolvedAiProfile
): Omit<NodeModelResolution, 'provider'> & { provider: string | undefined } {
  // A preference list collapses to the one ref it selects against this run's config.
  const nodeModel = selectModelRef(node.model, aiProfile);
  const declared: ProviderChoice = {
    provider: node.provider ?? scope.provider,
    providerOrigin: node.provider ? 'node' : scope.providerOrigin,
  };
  const fromNode = nodeModel
    ? nodeModelChoice(node, nodeModel, declared, aiProfile)
    : { ...declared, model: undefined, modelOrigin: 'unset' as const };
  const choice =
    fromNode.model === undefined
      ? { ...fromNode, ...inheritedModel(fromNode.provider, scope, assistantModels) }
      : fromNode;

  // A node that names no model of its own and runs on the workflow's provider inherits
  // the workflow's preset and tier as well as its model.
  const inheritsWorkflowModel = !nodeModel && choice.provider === scope.provider;
  const preset = choice.preset ?? (inheritsWorkflowModel ? scope.preset : undefined);
  const { effort, declaredEffort, effortOrigin } = resolveEffort(node, scope, preset);
  return {
    provider: choice.provider,
    model: choice.model,
    effort,
    declaredEffort,
    tier: resolveTier(nodeModel, inheritsWorkflowModel, scope),
    preset,
    providerOrigin: choice.providerOrigin,
    modelOrigin: choice.modelOrigin,
    effortOrigin,
    authoredIn: readComposedMeta(node)?.origin,
    ...(choice.providerConflict ? { providerConflict: choice.providerConflict } : {}),
  };
}

interface ProviderChoice {
  provider: string | undefined;
  providerOrigin: ResolutionOrigin;
}

interface ModelChoice extends ProviderChoice {
  model: string | undefined;
  modelOrigin: ResolutionOrigin;
  preset?: ModelAliasPreset;
  providerConflict?: NodeModelResolution['providerConflict'];
}

/** The node's own `model:`: a literal model, or a tier or `@alias` ref resolved to its preset. */
function nodeModelChoice(
  node: DagNode,
  nodeModel: string,
  declared: ProviderChoice,
  aiProfile: ResolvedAiProfile | undefined
): ModelChoice {
  if (!aiProfile) return { ...declared, model: nodeModel, modelOrigin: 'node' };
  const spec = resolveModelSpec(aiProfile, nodeModel);
  if (isLiteralSpec(spec)) return { ...declared, model: spec.literal, modelOrigin: 'node' };
  return modelRefChoice(node, nodeModel, spec);
}

/** A tier or `@alias` preset names the provider as well as the model, and wins over `provider:`. */
function modelRefChoice(node: DagNode, nodeModel: string, preset: ModelAliasPreset): ModelChoice {
  return {
    provider: preset.provider,
    providerOrigin: 'model ref',
    model: preset.model,
    modelOrigin: 'model ref',
    preset,
    ...(node.provider && node.provider !== preset.provider
      ? {
          providerConflict: {
            declared: node.provider,
            resolved: preset.provider,
            modelRef: nodeModel,
          },
        }
      : {}),
  };
}

/**
 * The model a node without one of its own inherits: the workflow's when the node runs on
 * the workflow's provider, else that provider's assistant config. Note the asymmetry: on
 * the workflow's own provider there is NO further fallback — the caller has already
 * folded the assistant default into `scope.model`.
 */
function inheritedModel(
  provider: string | undefined,
  scope: WorkflowModelScope,
  assistantModels: Readonly<Record<string, string | undefined>>
): Pick<ModelChoice, 'model' | 'modelOrigin'> {
  if (provider === scope.provider) {
    return { model: scope.model, modelOrigin: scope.model !== undefined ? 'workflow' : 'unset' };
  }
  const model = provider === undefined ? undefined : assistantModels[provider];
  return { model, modelOrigin: model !== undefined ? 'assistant config' : 'unset' };
}

/**
 * What the author declared (node, then workflow), before a preset fills in and before the
 * provider's capability gate drops it — the executor threads exactly this value into both
 * `applyPresetOptions` and its capability check, so the two cannot disagree.
 */
function resolveEffort(
  node: DagNode,
  scope: WorkflowModelScope,
  preset: ModelAliasPreset | undefined
): Pick<NodeModelResolution, 'effort' | 'declaredEffort' | 'effortOrigin'> {
  const declaredEffort = node.effort ?? scope.effort;
  return {
    effort: declaredEffort ?? preset?.effort,
    declaredEffort,
    effortOrigin: effortOrigin(node, scope, preset),
  };
}

function effortOrigin(
  node: DagNode,
  scope: WorkflowModelScope,
  preset: ModelAliasPreset | undefined
): ResolutionOrigin {
  if (node.effort !== undefined) return 'node';
  if (scope.effort !== undefined) return 'workflow';
  if (preset?.effort !== undefined) return 'model ref';
  return 'unset';
}

function resolveTier(
  nodeModel: string | undefined,
  inheritsWorkflowModel: boolean,
  scope: WorkflowModelScope
): TierName | undefined {
  if (nodeModel) return isTierName(nodeModel) ? nodeModel : undefined;
  return inheritsWorkflowModel ? scope.tier : undefined;
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
  workflow: { provider?: string; model?: WorkflowModelRef; effort?: EffortLevel },
  defaultAssistant: string | undefined,
  assistantModels: Readonly<Record<string, string | undefined>>,
  aiProfile?: ResolvedAiProfile
): WorkflowModelScope {
  const workflowModel = selectModelRef(workflow.model, aiProfile);
  let provider = workflow.provider ?? defaultAssistant;
  let model: string | undefined;
  let preset: ModelAliasPreset | undefined;
  if (workflowModel && aiProfile) {
    const spec = resolveModelSpec(aiProfile, workflowModel);
    if (isLiteralSpec(spec)) {
      model = spec.literal;
    } else {
      preset = spec;
      provider = spec.provider;
      model = spec.model;
    }
  } else if (workflowModel) {
    model = workflowModel;
  }
  if (provider !== undefined) model ??= assistantModels[provider];
  return {
    provider,
    model,
    preset,
    tier: workflowModel && isTierName(workflowModel) ? workflowModel : undefined,
    effort: workflow.effort,
    providerOrigin: workflowProviderOrigin(preset, workflow.provider, defaultAssistant),
  };
}

function workflowProviderOrigin(
  preset: ModelAliasPreset | undefined,
  workflowProvider: string | undefined,
  defaultAssistant: string | undefined
): ResolutionOrigin {
  // A resolved preset overrides even an explicitly declared workflow provider.
  if (preset) return 'model ref';
  if (workflowProvider) return 'workflow';
  return defaultAssistant === undefined ? 'unset' : 'default assistant';
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
