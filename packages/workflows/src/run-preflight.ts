import { FileStoreUnsupportedError } from './file-store/errors';
import { type ProviderRegistry, requireProvider } from '@archon/provider-contract';
import {
  createRunAiConfigurationSnapshot,
  readRunAiConfigurationSnapshot,
  restoreRunAiConfigurationDefaults,
} from './run-ai-configuration';
import type { RunAiConfigurationSnapshot } from './schemas/run-ai-configuration';
import type { CredentialStatus } from '@archon/provider-contract';
import type { WorkflowConfig, WorkflowDeps } from './deps';
import type { ResolvedWorkflow, WorkflowRun, DagNode } from './schemas';
import { isAgentNode, isLoopNode, isLoopGroupNode } from './schemas';
import { resolvedBodyNodes } from './graph-plan';
import {
  assistantModelDefaults,
  resolveNodeModel,
  resolveWorkflowModelScope,
  type WorkflowModelScope,
} from './node-model-resolution';
import {
  buildAiProfile,
  applyResolvedRunModelOverrides,
  createRunModelBindingsMetadata,
  readRunModelBindingsMetadata,
  resolveRunModelOverrides,
} from './model-validation';
import type {
  ResolvedAiProfile,
  ResolvedRunModelOverrides,
  RunModelOverrides,
  RunModelBindingsMetadata,
} from './model-validation';
import { applyWorkflowRunConfigLayer, readWorkflowRunConfigMetadata } from './run-config';
import type { WorkflowRunConfigInput, WorkflowRunConfigMetadata } from './schemas/run-config';
import { createLogger } from '@archon/paths';

const log = createLogger('workflow.run-preflight');
type UserAiPrefsLayer = Awaited<ReturnType<NonNullable<WorkflowDeps['getUserAiPrefs']>>>;

export interface RunAiConfigurationOptions {
  codebaseId?: string;
  userId?: string;
  continuationRun?: WorkflowRun;
  aiConfigurationRun?: WorkflowRun;
  inheritAiConfiguration?: boolean;
  runConfig?: WorkflowRunConfigInput;
  modelOverrideLayer?:
    | { kind: 'raw'; overrides: RunModelOverrides }
    | { kind: 'resolved'; overrides: ResolvedRunModelOverrides };
}

export async function prepareRunAiConfiguration(
  deps: Pick<
    WorkflowDeps,
    | 'providers'
    | 'loadConfig'
    | 'getUserAiPrefs'
    | 'getAgentProvider'
    | 'sealRunConfig'
    | 'unsealRunConfig'
  > & { store: Pick<WorkflowDeps['store'], 'getCodebaseEnvVars'> },
  workflow: ResolvedWorkflow,
  cwd: string,
  options: RunAiConfigurationOptions = {}
): Promise<PreparedRunAiConfiguration> {
  const { codebaseId } = options;
  const executionUserId = options.continuationRun
    ? (options.continuationRun.user_id ?? undefined)
    : options.userId;
  let runConfigMetadata: WorkflowRunConfigMetadata | undefined;
  let effectiveRunConfig: WorkflowRunConfigInput | undefined;
  if (options.continuationRun !== undefined) {
    runConfigMetadata = readWorkflowRunConfigMetadata(options.continuationRun.metadata);
    if (runConfigMetadata) {
      if (!deps.unsealRunConfig) {
        throw new Error('This Archon build cannot restore persisted workflow run config.');
      }
      effectiveRunConfig = {
        layer: deps.unsealRunConfig(runConfigMetadata),
        source: runConfigMetadata.source,
      };
    }
  } else {
    effectiveRunConfig = options.runConfig;
    if (effectiveRunConfig) {
      if (!deps.sealRunConfig) {
        throw new Error('This Archon build cannot persist workflow run config.');
      }
      runConfigMetadata = deps.sealRunConfig(effectiveRunConfig.layer, effectiveRunConfig.source);
    }
  }
  const fileConfig = await deps.loadConfig(cwd);
  const dbEnvVars = codebaseId ? await deps.store.getCodebaseEnvVars(codebaseId) : {};
  const config = applyWorkflowRunConfigLayer(
    { ...fileConfig, envVars: { ...fileConfig.envVars, ...dbEnvVars } },
    effectiveRunConfig?.layer
  );
  const snapshot =
    readRunAiConfigurationSnapshot(deps.providers, options.continuationRun?.metadata) ??
    readRunAiConfigurationSnapshot(deps.providers, options.aiConfigurationRun?.metadata);
  if (
    snapshot &&
    options.aiConfigurationRun &&
    !options.continuationRun &&
    !options.inheritAiConfiguration
  ) {
    const layer = options.runConfig?.layer;
    if (
      options.modelOverrideLayer ||
      (layer &&
        ['assistant', 'assistants', 'tiers', 'aliases'].some(key => Object.hasOwn(layer, key)))
    ) {
      throw new Error('Cannot override AI configuration inherited from a recorded run.');
    }
  }
  if (snapshot) restoreRunAiConfigurationDefaults(deps.providers, config, snapshot);
  let userAiPrefs: UserAiPrefsLayer = {};
  if (!snapshot && executionUserId && deps.getUserAiPrefs) {
    try {
      userAiPrefs = await deps.getUserAiPrefs(executionUserId);
    } catch (error) {
      log.warn(
        { err: error as Error, userId: executionUserId },
        'workflow.user_ai_prefs_resolve_failed'
      );
    }
  }
  let baseAiProfile: ResolvedAiProfile;
  if (snapshot) {
    baseAiProfile = snapshot.baseAiProfile;
  } else
    try {
      baseAiProfile = buildAiProfile(
        effectiveRunConfig?.layer.assistant ?? userAiPrefs.defaultProvider ?? fileConfig.assistant,
        {
          repoTiers: fileConfig.tiers,
          repoAliases: fileConfig.aliases,
          userTiers: userAiPrefs.tiers,
          userAliases: userAiPrefs.aliases,
          runTiers: effectiveRunConfig?.layer.tiers,
          runAliases: effectiveRunConfig?.layer.aliases,
        }
      );
    } catch (error) {
      // Corrupt stored preferences degrade to config-only. Invalid file or run
      // configuration still fails when rebuilt without the stored preferences.
      log.error(
        { err: error as Error, userId: executionUserId },
        'workflow.user_ai_prefs_profile_invalid'
      );
      baseAiProfile = buildAiProfile(effectiveRunConfig?.layer.assistant ?? fileConfig.assistant, {
        repoTiers: fileConfig.tiers,
        repoAliases: fileConfig.aliases,
        runTiers: effectiveRunConfig?.layer.tiers,
        runAliases: effectiveRunConfig?.layer.aliases,
      });
    }

  const persistedModelBindings =
    !snapshot && options.continuationRun
      ? readRunModelBindingsMetadata(deps.providers, options.continuationRun.metadata)
      : undefined;
  const resolvedModelOverrides =
    snapshot?.modelOverrides ??
    persistedModelBindings?.overrides ??
    (options.modelOverrideLayer?.kind === 'resolved'
      ? options.modelOverrideLayer.overrides
      : resolveRunModelOverrides(
          deps.providers,
          baseAiProfile,
          options.modelOverrideLayer?.overrides
        ));
  const aiProfile = applyResolvedRunModelOverrides(baseAiProfile, resolvedModelOverrides);
  const modelBindingsMetadata = createRunModelBindingsMetadata(resolvedModelOverrides, aiProfile);
  let scope = resolveWorkflowModelScope(
    workflow,
    config.assistant,
    assistantModelDefaults(config),
    aiProfile
  );
  if (!deps.providers.get(scope.provider))
    throw new Error(
      `Workflow '${workflow.name}': unknown provider '${scope.provider}'. Registered: ${deps.providers
        .list()
        .map(p => p.id)
        .join(', ')}`
    );
  const unresolved = collectRunCredentialRequirements(deps.providers, workflow, {
    config,
    aiProfile,
    scope,
  }).filter(r => r.model === undefined);
  for (const provider of new Set((snapshot ? [] : unresolved).map(r => r.provider))) {
    const runtime = deps.getAgentProvider(provider);
    if (runtime.resolveCredentialModel) {
      const model = await runtime.resolveCredentialModel({
        cwd,
        assistantConfig: config.assistants[provider],
      });
      if (model !== undefined) {
        config.assistants = {
          ...config.assistants,
          [provider]: { ...config.assistants[provider], model },
        };
      }
    }
  }
  const aiConfigurationSnapshot =
    snapshot ??
    createRunAiConfigurationSnapshot(deps.providers, config, baseAiProfile, resolvedModelOverrides);
  if (!snapshot) restoreRunAiConfigurationDefaults(deps.providers, config, aiConfigurationSnapshot);
  scope = resolveWorkflowModelScope(
    workflow,
    config.assistant,
    assistantModelDefaults(config),
    aiProfile
  );
  return {
    aiConfigurationSnapshot,
    config,
    dbEnvVars,
    baseAiProfile,
    aiProfile,
    resolvedModelOverrides,
    modelBindingsMetadata,
    scope,
    effectiveRunConfig,
    runConfigMetadata,
    executionUserId,
    requirements: collectRunCredentialRequirements(deps.providers, workflow, {
      config,
      aiProfile,
      scope,
    }),
    connectedVendors: new Set(),
  };
}

export interface PreparedRunAiConfiguration {
  aiConfigurationSnapshot: RunAiConfigurationSnapshot;
  requirements: readonly RunCredentialRequirement[];
  connectedVendors: Set<string>;
  config: WorkflowConfig;
  dbEnvVars: Record<string, string>;
  baseAiProfile: ResolvedAiProfile;
  aiProfile: ResolvedAiProfile;
  resolvedModelOverrides: ResolvedRunModelOverrides;
  modelBindingsMetadata: RunModelBindingsMetadata;
  scope: WorkflowModelScope;
  effectiveRunConfig?: WorkflowRunConfigInput;
  runConfigMetadata?: WorkflowRunConfigMetadata;
  executionUserId?: string;
}
export interface RunCredentialRequirement {
  provider: string;
  model?: string;
  vendor?: string;
}

export function collectRunCredentialRequirements(
  providers: ProviderRegistry,
  workflow: ResolvedWorkflow,
  prepared: Pick<PreparedRunAiConfiguration, 'config' | 'aiProfile' | 'scope'>
): RunCredentialRequirement[] {
  const requirements = new Map<string, RunCredentialRequirement>();
  const models = assistantModelDefaults(prepared.config);
  const visit = (nodes: readonly DagNode[], scope: WorkflowModelScope): void => {
    for (const node of nodes) {
      if (!isAgentNode(node) && !isLoopNode(node) && !isLoopGroupNode(node)) continue;
      const resolved = resolveNodeModel(node, scope, models, prepared.aiProfile);
      if (isLoopGroupNode(node)) {
        visit(resolvedBodyNodes(node.loop_group), {
          ...scope,
          provider: resolved.provider,
          model: resolved.model,
          preset: resolved.preset,
          tier: resolved.tier,
          providerOrigin: resolved.providerOrigin,
        });
      } else {
        const { provider, model } = resolved;
        requirements.set(JSON.stringify([provider, model]), {
          provider,
          model,
          vendor: requireProvider(providers, provider).credentials.vendorFor(model),
        });
      }
    }
  };
  visit(workflow.nodes, prepared.scope);
  return [...requirements.values()];
}

export class WorkflowCredentialPreflightError extends Error {
  constructor(requirement: RunCredentialRequirement, reason: string) {
    super(
      `Credential preflight failed for provider '${requirement.provider}'${requirement.vendor ? ` (vendor '${requirement.vendor}')` : ''}: ${reason}`
    );
    this.name = 'WorkflowCredentialPreflightError';
  }
}

export function assertCredentialStatus(
  requirement: RunCredentialRequirement,
  status: CredentialStatus
): void {
  switch (status.state) {
    case 'usable':
      return;
    case 'not_checked':
      if (status.source === 'native') return;
      throw new WorkflowCredentialPreflightError(
        requirement,
        'credential adapter returned an unsupported stored status'
      );
    case 'not_connected':
      throw new WorkflowCredentialPreflightError(
        requirement,
        'no usable login; connect a credential or log in with the provider'
      );
    case 'unusable':
      throw new WorkflowCredentialPreflightError(
        requirement,
        `credential cannot be used: ${status.evidence}`
      );
    case 'check_failed':
      throw new WorkflowCredentialPreflightError(
        requirement,
        `could not verify: ${status.evidence}`
      );
  }
}

export async function assertRunCredentials(
  deps: Pick<
    WorkflowDeps,
    | 'getAgentProvider'
    | 'isPerUserProviderKeysEnabled'
    | 'getUserProviderCredentialStatus'
    | 'credentialStore'
  >,
  prepared: PreparedRunAiConfiguration
): Promise<void> {
  const storedStatuses = new Map<string, CredentialStatus>();
  for (const requirement of prepared.requirements) {
    const { provider, model, vendor } = requirement;
    if (prepared.executionUserId && deps.isPerUserProviderKeysEnabled?.() && vendor) {
      if (deps.credentialStore === 'files')
        throw new FileStoreUnsupportedError('stored per-user provider credentials');
      if (!deps.getUserProviderCredentialStatus)
        throw new WorkflowCredentialPreflightError(
          requirement,
          'credential adapter has no stored status port'
        );
      let status = storedStatuses.get(vendor);
      if (!status) {
        try {
          status = await deps.getUserProviderCredentialStatus(prepared.executionUserId, vendor);
        } catch {
          throw new WorkflowCredentialPreflightError(
            requirement,
            'could not verify the stored credential'
          );
        }
        storedStatuses.set(vendor, status);
      }
      if (status.state === 'not_connected' && prepared.connectedVendors.has(vendor)) {
        assertCredentialStatus(requirement, status);
      }
      if (status.state !== 'not_connected') {
        assertCredentialStatus(requirement, status);
        prepared.connectedVendors.add(vendor);
        continue;
      }
    }
    let status: CredentialStatus;
    try {
      status = await deps.getAgentProvider(provider).checkCredential({
        model,
        assistantConfig: prepared.config.assistants[provider],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value]]
            )
          ),
          ...prepared.config.envVars,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new WorkflowCredentialPreflightError(
        requirement,
        'could not verify native authentication'
      );
    }
    assertCredentialStatus(requirement, status);
  }
}

export class StoredCredentialDeliveryError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: CredentialStatus
  ) {
    super(`Stored credential delivery failed for '${vendor}'`);
    this.name = 'StoredCredentialDeliveryError';
  }
}
