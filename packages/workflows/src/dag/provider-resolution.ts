import {
  type ProviderRegistry,
  type NodeConfig,
  type ProviderCapabilities,
  type SendQueryOptions,
  mcpServerMap,
  requireProvider,
  isEffortRung,
} from '@archon/provider-contract';
import {
  type ModelAliasPreset,
  type PresetEffortRejection,
  type TierName,
  resolvePresetEffort,
} from '../model-validation';
import { type DagNode, type EffortLevel, type NodeMcp, mcpDeclaration } from '../schemas';
import { type McpPathResolution, resolveMcpPath, missingMcpConfigMessage } from '../mcp-path';
import type { McpUnavailable } from '../schemas/node-execution';
import { capturedSourceReadGuard } from '../workflow-source';
import {
  type NodeModelResolution,
  resolveNodeModel,
  assistantModelDefaults,
} from '../node-model-resolution';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';
import type { ScopedCapabilityMismatch } from './capability-preflight';

export function applyPresetOptions(
  providers: ProviderRegistry,
  provider: string,
  preset: ModelAliasPreset | undefined,
  node: DagNode,
  declaredEffort: EffortLevel | undefined,
  nodeConfig: NodeConfig
): PresetEffortRejection | undefined {
  if (!preset) return;

  // An effort declared on the node or workflow outranks the preset's. Passed in
  // rather than re-derived so this cannot disagree with the chain that builds
  // `nodeConfig.effort` below — the two disagreeing is exactly what made an
  // explicit `effort:` on a Codex node suppress its tier's effort and apply
  // nothing at all (#2556).
  if (preset.effort === undefined || declaredEffort !== undefined) return;

  // Shared with the chat orchestrator's `applyPresetToRequestOptions`, so the
  // same tier cannot mean one depth in a workflow and another in chat. The
  // classifier returns the reason; each caller keeps its own event namespace.
  const decision = resolvePresetEffort(providers, provider, preset.effort);
  if (!decision.ok) {
    // Warn rather than silently drop it — fail-loud per the project's fail-fast
    // guideline. `unsupported` means the resolved provider has no reasoning
    // control at all (e.g. a `tiers:` entry sets `effort` on an OpenCode tier).
    getLog().warn(
      { provider, effort: preset.effort, nodeId: node.id, valid: decision.valid },
      decision.reason === 'unsupported'
        ? 'dag.preset_effort_unsupported'
        : 'dag.preset_effort_unknown'
    );
    return decision;
  }
  nodeConfig.effort = preset.effort;
  return undefined;
}

/** The provider diagnoses invalid selected JSON; inspection only supplies filtering names. */
export function parseMcpServerNames(raw: string, fullPath: string): string[] | undefined {
  try {
    const serverMap = mcpServerMap(JSON.parse(raw));
    if (serverMap.ok) return Object.keys(serverMap.servers);
    getLog().debug({ error: serverMap.error, fullPath }, 'dag.mcp_config_read_failed');
  } catch (err) {
    getLog().debug({ err, fullPath }, 'dag.mcp_config_read_failed');
  }
  return undefined;
}

/** What a node's `mcp:` declaration hands its provider for one attempt. */
export type NodeMcpResolution =
  | Extract<McpPathResolution, { kind: 'read_error' }>
  | { kind: 'none' }
  /** The provider loads `path`; `servers` are the names the file declares, if readable. */
  | { kind: 'load'; path: string; servers: Set<string> }
  | { kind: 'missing'; path: string; servers: Set<string>; diagnostic: string }
  /** An optional declaration the node runs without. */
  | { kind: 'unavailable'; fullPath: string; record: McpUnavailable; diagnostic?: string };

/**
 * Decide whether a node's MCP servers reach its provider. Missing required files and
 * readable invalid JSON still reach the provider for diagnosis; I/O errors retain their
 * cause for the executor. An optional declaration is withheld when the provider cannot
 * load MCP servers, or when its config file does not exist.
 */
export async function resolveNodeMcp(
  mcp: NodeMcp | undefined,
  capabilities: ProviderCapabilities,
  cwd: string,
  homeYamlDirectory?: string,
  verifiedFiles?: ReadonlySet<string>
): Promise<NodeMcpResolution> {
  const declaration = mcpDeclaration(mcp);
  if (declaration === undefined) return { kind: 'none' };
  const { path, optional } = declaration;
  const selected = await resolveMcpPath(
    path,
    cwd,
    homeYamlDirectory,
    capturedSourceReadGuard(verifiedFiles)
  );
  const fullPath = selected.kind === 'missing' ? selected.attemptedPaths[0] : selected.path;
  const servers =
    selected.kind === 'found' ? parseMcpServerNames(selected.content, fullPath) : undefined;
  if (optional && !capabilities.mcp) {
    return {
      kind: 'unavailable',
      fullPath,
      record: { path, reason: 'provider_unsupported', ...(servers ? { servers } : {}) },
    };
  }
  if (selected.kind === 'read_error') return selected;
  if (selected.kind === 'missing') {
    const diagnostic = missingMcpConfigMessage(path, selected.attemptedPaths);
    if (optional) {
      return {
        kind: 'unavailable',
        fullPath,
        record: { path, reason: 'config_missing' },
        diagnostic,
      };
    }
    return { kind: 'missing', path: fullPath, servers: new Set(), diagnostic };
  }
  return { kind: 'load', path: fullPath, servers: new Set(servers) };
}

type ProviderResolutionContext = Pick<
  RunLayersContext,
  | 'deps'
  | 'workflowProvider'
  | 'workflowModel'
  | 'config'
  | 'platform'
  | 'conversationId'
  | 'workflowRun'
  | 'workflowLevelOptions'
  | 'aiProfile'
  | 'workflowPreset'
  | 'execContext'
>;

/**
 * Resolve per-node provider and model.
 * Node-level overrides take precedence over workflow defaults.
 *
 * Provider-agnostic: builds universal base options + raw nodeConfig.
 * The provider internally translates nodeConfig to SDK-specific options.
 * Capability warnings inform users when features are unsupported.
 */
export async function resolveNodeProviderAndModel(
  ctx: ProviderResolutionContext,
  node: DagNode,
  {
    resolveAiText,
    warnedProviderConflicts,
  }: {
    /**
     * Resolve workflow variables and `$node.output` refs in the node's AI-configuration
     * text (#2476/#1764). Required rather than optional so a new call site has to decide:
     * omitting it silently ships `$ARTIFACTS_DIR` and `$plan.output` to the provider as
     * literal text, which is the defect this closes. Pass `text => text` only where the
     * node is engine-synthesised and cannot carry these fields.
     */
    resolveAiText: (text: string) => string;
    /**
     * Provider/model conflicts already reported this run. A conflict declared once at
     * workflow level is collapsed onto every node (#1764), so without de-duplication one
     * authoring mistake produces one chat message per node.
     */
    warnedProviderConflicts: Set<string> | undefined;
  }
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
  tier?: TierName;
  effort?: EffortLevel;
  preset?: ModelAliasPreset;
}> {
  const { config, workflowLevelOptions } = ctx;
  const providers = ctx.deps.providers;
  // The chain itself lives in node-model-resolution.ts so `workflow dry-run` reports the
  // same answer this produces (#1764). Everything below is the part a dry run must NOT
  // do: warn the user, throw, and build provider options.
  const resolution = resolveNodeModel(
    node,
    {
      provider: ctx.workflowProvider,
      model: ctx.workflowModel,
      preset: ctx.workflowPreset,
      tier: workflowLevelOptions.workflowTier,
      effort: workflowLevelOptions.effort,
      // Only used to LABEL an inherited provider in a dry run; the executor discards it.
      providerOrigin: 'workflow',
    },
    assistantModelDefaults(config),
    ctx.aiProfile
  );
  const { provider, model, preset: effectivePreset, declaredEffort } = resolution;
  if (resolution.providerConflict) {
    await warnProviderConflict(ctx, node, resolution.providerConflict, warnedProviderConflicts);
  }

  // Get provider capabilities for capability warnings (static lookup, no instantiation)
  const caps = requireProvider(providers, provider).capabilities;
  assertDispatchCapabilities(ctx, node, provider, caps);
  const unsupported = unsupportedCapabilities(ctx, node, provider, caps, declaredEffort);

  const aiFields = resolveNodeAiFields(node, workflowLevelOptions, resolveAiText);
  const baseOptions = baseQueryOptions(ctx, node, model, aiFields);
  const nodeConfig = buildNodeConfig(node, workflowLevelOptions, caps, declaredEffort, aiFields);

  // Pass assistantConfig from config — provider parses internally
  const assistantConfig: Record<string, unknown> = { ...(config.assistants[provider] ?? {}) };
  const presetEffortRejection = applyPresetOptions(
    providers,
    provider,
    effectivePreset,
    node,
    declaredEffort,
    nodeConfig
  );
  if (presetEffortRejection?.reason === 'unsupported') {
    unsupported.push('effort');
  }
  if (unsupported.length > 0) await warnUnsupportedCapabilities(ctx, node, provider, unsupported);

  // `webSearchMode:` has no node-level form and no other consumer, so the
  // workflow-level value is the only value — written only where it is read.
  if (provider === 'codex' && workflowLevelOptions.webSearchMode !== undefined) {
    assistantConfig.webSearchMode = workflowLevelOptions.webSearchMode;
  }

  // `node.model` is the original ref (e.g. "large"); `model` is the resolved
  // string (e.g. "opus"). Surface `tier` when the ref was a tier keyword — from
  // the node's own `model`, or (when the node inherits the workflow-level model)
  // from the workflow tier, mirroring the effectivePreset inheritance condition.
  return {
    provider,
    model,
    options: { ...baseOptions, nodeConfig, assistantConfig },
    tier: resolution.tier,
    effort: reportedEffort(nodeConfig, assistantConfig),
    preset: effectivePreset,
  };
}

/** Warn once per run, in the log and in chat, that a node's model ref overrides its provider. */
async function warnProviderConflict(
  ctx: Pick<ProviderResolutionContext, 'platform' | 'conversationId' | 'workflowRun'>,
  node: DagNode,
  conflict: NonNullable<NodeModelResolution['providerConflict']>,
  warnedProviderConflicts: Set<string> | undefined
): Promise<void> {
  const conflictKey = `${conflict.declared}|${conflict.resolved}|${conflict.modelRef}`;
  if (warnedProviderConflicts?.has(conflictKey)) return;
  warnedProviderConflicts?.add(conflictKey);
  const workflowRunId = ctx.workflowRun.id;
  getLog().warn(
    {
      nodeId: node.id,
      configuredProvider: conflict.declared,
      resolvedProvider: conflict.resolved,
      modelRef: conflict.modelRef,
    },
    'dag.model_provider_conflict'
  );
  const delivered = await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Warning: Node '${node.id}' sets provider '${conflict.declared}' but model '${conflict.modelRef}' resolves to provider '${conflict.resolved}' — using '${conflict.resolved}'.`,
    { workflowId: workflowRunId, nodeName: node.id }
  );
  if (!delivered) {
    getLog().error(
      { nodeId: node.id, workflowRunId },
      'dag.model_provider_conflict_warning_delivery_failed'
    );
  }
}

/** Capabilities a node cannot run without fail the dispatch instead of warning. */
function assertDispatchCapabilities(
  ctx: Pick<ProviderResolutionContext, 'execContext'>,
  node: DagNode,
  provider: string,
  caps: ProviderCapabilities
): void {
  // Keep the container capability check at dispatch as well as preflight: every
  // actual turn must honour the requested execution context.
  if (ctx.execContext.kind === 'container' && !caps.containerExec) {
    throw new Error(
      `Provider '${provider}' cannot run inside a container yet (containerExec ` +
        'capability). Use provider claude, or run without --container.'
    );
  }

  // Re-check scoped capabilities at the actual dispatch boundary.
  const unscoped = unsupportedScopedCapabilities(node, caps);
  if (unscoped.length > 0) {
    throw new Error(
      scopedCapabilityMismatchMessage([{ nodeId: node.id, provider, capabilities: unscoped }])
    );
  }
}

/** Fields the node sets that its provider does not support, so they will be ignored. */
function unsupportedCapabilities(
  ctx: Pick<ProviderResolutionContext, 'config' | 'workflowLevelOptions'>,
  node: DagNode,
  provider: string,
  caps: ProviderCapabilities,
  declaredEffort: EffortLevel | undefined
): string[] {
  const { config, workflowLevelOptions } = ctx;
  const capChecks: [string, keyof ProviderCapabilities, boolean][] = [
    [
      'allowed_tools/denied_tools',
      'toolRestrictions',
      node.allowed_tools !== undefined || node.denied_tools !== undefined,
    ],
    ['hooks', 'hooks', node.hooks !== undefined],
    ['agents', 'agents', node.agents !== undefined],
    ['effort', 'effortControl', declaredEffort !== undefined],
    ['maxBudgetUsd', 'costControl', node.maxBudgetUsd !== undefined],
    [
      'fallbackModel',
      'fallbackModel',
      (node.fallbackModel ?? workflowLevelOptions.fallbackModel) !== undefined,
    ],
    ['sandbox', 'sandbox', (node.sandbox ?? workflowLevelOptions.sandbox) !== undefined],
    ['settingSources', 'settingSources', node.settingSources !== undefined],
    ['env', 'envInjection', (config.envVars && Object.keys(config.envVars).length > 0) === true],
  ];
  const unsupported = capChecks.filter(([, cap, isSet]) => isSet && !caps[cap]).map(([f]) => f);

  // `webSearchMode:` is Codex's alone — no other provider reads it, and #2556
  // decided it keeps no node-level form, making it the single workflow-level
  // field with no per-node counterpart. There is deliberately no
  // ProviderCapabilities axis for one provider's one field, so capChecks above
  // cannot see it. Surfacing it here reuses the existing loud-mismatch path so a
  // workflow that declares it on a node that cannot read it gets the same
  // warning every other capability mismatch produces, instead of a silent no-op.
  //
  // Reasoning depth is NOT in this category any more: the loader translates the
  // deprecated `modelReasoningEffort:` into `effort:`, so the executor sees one
  // provider-agnostic field and needs no Codex branch for it.
  if (provider !== 'codex' && workflowLevelOptions.webSearchMode !== undefined) {
    unsupported.push('webSearchMode');
  }
  return unsupported;
}

interface NodeAiFields {
  systemPrompt: string | undefined;
  agents: NodeConfig['agents'];
  fallbackModel: string | undefined;
}

/**
 * Resolved, never mutated in place: the node object is the shared definition and a loop
 * or a resume would otherwise substitute into an already-substituted string.
 */
function resolveNodeAiFields(
  node: DagNode,
  workflowLevelOptions: ProviderResolutionContext['workflowLevelOptions'],
  resolveAiText: (text: string) => string
): NodeAiFields {
  const systemPrompt =
    node.systemPrompt !== undefined ? resolveAiText(node.systemPrompt) : undefined;
  const agents =
    node.agents !== undefined
      ? Object.fromEntries(
          Object.entries(node.agents).map(([id, agent]) => [
            id,
            {
              ...agent,
              prompt: resolveAiText(agent.prompt),
              description: resolveAiText(agent.description),
            },
          ])
        )
      : undefined;
  return {
    systemPrompt,
    agents,
    fallbackModel: node.fallbackModel ?? workflowLevelOptions.fallbackModel,
  };
}

/** Universal options every provider reads. */
function baseQueryOptions(
  ctx: Pick<ProviderResolutionContext, 'config' | 'execContext'>,
  node: DagNode,
  model: string | undefined,
  { systemPrompt, fallbackModel }: NodeAiFields
): SendQueryOptions {
  const { config, execContext } = ctx;
  const baseOptions: SendQueryOptions = {};
  if (model) baseOptions.model = model;
  // Only annotate options with the execution context when running in a container
  // (Phase B). Host is the default/absent case, so host runs produce byte-identical
  // options — the provider infers host behavior from the missing field.
  if (execContext.kind === 'container') {
    baseOptions.execContext = execContext;
  }
  if (config.envVars && Object.keys(config.envVars).length > 0) {
    baseOptions.env = config.envVars;
  }
  baseOptions.userCredentialEnvKeys = config.userCredentialEnvKeys;
  if (config.protectedEnvKeys && config.protectedEnvKeys.length > 0) {
    baseOptions.protectedEnvKeys = config.protectedEnvKeys;
  }
  if (systemPrompt !== undefined) baseOptions.systemPrompt = systemPrompt;
  if (node.maxBudgetUsd !== undefined) baseOptions.maxBudgetUsd = node.maxBudgetUsd;
  if (fallbackModel) baseOptions.fallbackModel = fallbackModel;
  if (node.output_format) {
    baseOptions.outputFormat = { type: 'json_schema', schema: node.output_format };
  }
  return baseOptions;
}

/** Raw nodeConfig — the provider translates it internally. */
function buildNodeConfig(
  node: DagNode,
  workflowLevelOptions: ProviderResolutionContext['workflowLevelOptions'],
  caps: ProviderCapabilities,
  declaredEffort: EffortLevel | undefined,
  { systemPrompt, agents, fallbackModel }: NodeAiFields
): NodeConfig {
  return {
    nodeId: node.id,
    // `mcp` is set per attempt by `executeAgentNode`, which decides whether an
    // optional declaration reaches the provider.
    hooks: node.hooks,
    skills: node.skills,
    plugins: node.plugins,
    agents,
    // Portable per-node Pi extension posture (#2133) — Pi provider reads it as
    // the highest-precedence override; ignored by other providers.
    pi: node.pi,
    allowed_tools: node.allowed_tools,
    denied_tools: node.denied_tools,
    // Dropped for a provider with no reasoning control, matching what the preset
    // path does in `applyPresetOptions`. `unsupportedCapabilities` has already told
    // the author it will be ignored; writing it anyway would make `node_started`
    // report a depth that was never applied, and would leave declared and preset
    // effort behaving oppositely on the same provider.
    effort: caps.effortControl ? declaredEffort : undefined,
    sandbox: node.sandbox ?? workflowLevelOptions.sandbox,
    betas: node.betas ?? workflowLevelOptions.betas,
    output_format: node.output_format,
    maxBudgetUsd: node.maxBudgetUsd,
    systemPrompt,
    fallbackModel,
    settingSources: node.settingSources,
  };
}

async function warnUnsupportedCapabilities(
  ctx: Pick<ProviderResolutionContext, 'platform' | 'conversationId' | 'workflowRun'>,
  node: DagNode,
  provider: string,
  unsupported: readonly string[]
): Promise<void> {
  const workflowRunId = ctx.workflowRun.id;
  getLog().warn({ nodeId: node.id, provider, unsupported }, 'dag.unsupported_capabilities');
  const delivered = await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `Warning: Node '${node.id}' uses ${unsupported.join(', ')} but ${provider} doesn't support ${unsupported.length === 1 ? 'it' : 'them'} — ${unsupported.length === 1 ? 'this will be' : 'these will be'} ignored.`,
    { workflowId: workflowRunId, nodeName: node.id }
  );
  if (!delivered) {
    getLog().error({ nodeId: node.id, workflowRunId }, 'dag.capability_warning_delivery_failed');
  }
}

/**
 * There is one effort channel now, so telemetry has one place to read (#2556).
 * `nodeConfig.effort` holds whatever will be applied — declared, or filled in from the
 * preset, or absent when the provider warned and dropped it.
 * `assistants.<provider>.modelReasoningEffort` from config.yaml never enters nodeConfig,
 * so it stays the fallback.
 *
 * Providers clamp a rung their SDK lacks (`ultra` → `max` on Claude/Pi or `xhigh` on
 * Copilot), and this reports the declared rung rather than the clamped one — consistent
 * across providers, and no longer able to name a field the provider ignored, which was
 * the #2395 failure mode.
 */
function reportedEffort(
  nodeConfig: NodeConfig,
  assistantConfig: Record<string, unknown>
): EffortLevel | undefined {
  const assistantEffort = isEffortRung(assistantConfig.modelReasoningEffort)
    ? assistantConfig.modelReasoningEffort
    : undefined;
  return nodeConfig.effort ?? assistantEffort;
}

/**
 * Node fields that name a capability for the node to load. Each is also the key of
 * the provider capability that honours it. Running the node without what it named
 * would produce output from a setup its author did not intend, so a mismatch fails
 * the run instead of warning like the other capability axes. An `mcp:` declared
 * `optional: true` names no requirement; `resolveNodeMcp` records its absence.
 */
export const SCOPED_CAPABILITIES = ['mcp', 'skills', 'plugins'] as const;

export type ScopedCapability = (typeof SCOPED_CAPABILITIES)[number];

export function namesScopedCapability(node: DagNode, capability: ScopedCapability): boolean {
  switch (capability) {
    case 'mcp':
      return 'mcp' in node && mcpDeclaration(node.mcp)?.optional === false;
    // `skills: []` and `plugins: []` name nothing, so they need no capability.
    case 'skills':
      return 'skills' in node && (node.skills?.length ?? 0) > 0;
    case 'plugins':
      return 'plugins' in node && (node.plugins?.length ?? 0) > 0;
  }
}

export function unsupportedScopedCapabilities(
  node: DagNode,
  caps: ProviderCapabilities
): ScopedCapability[] {
  return SCOPED_CAPABILITIES.filter(cap => namesScopedCapability(node, cap) && !caps[cap]);
}

export function scopedCapabilityMismatchMessage(
  mismatches: readonly ScopedCapabilityMismatch[]
): string {
  const list = mismatches
    .map(m => `Node '${m.nodeId}' (provider '${m.provider}') names ${m.capabilities.join(', ')}`)
    .join('; ');
  return (
    `${list}, but ${mismatches.length === 1 ? 'that provider cannot' : 'those providers cannot'} ` +
    'load what the node names. Remove the field from the node or use a provider whose ' +
    'capability is true (see the provider capability matrix).'
  );
}
