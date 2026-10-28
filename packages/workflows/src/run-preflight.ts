import { providerInvocation } from './dag/capability-preflight';
import {
  type ExecutionContext,
  type ProviderRegistry,
  type NodeConfig,
  type StoredCredentialKind,
  consumesStoredCredential,
  requireProvider,
  unconsumedStoredCredentialReason,
  NoDefaultProviderError,
} from '@archon/provider-contract';
import {
  createRunAiConfigurationSnapshot,
  readRunAiConfigurationSnapshot,
  restoreRunAiConfigurationDefaults,
} from './run-ai-configuration';
import type { RunAiConfigurationSnapshot } from './schemas/run-ai-configuration';
import type { CredentialSource, CredentialStatus } from '@archon/provider-contract';
import type { StoredProviderCredential, WorkflowConfig, WorkflowDeps } from './deps';
import type { ResolvedWorkflow, WorkflowRun, DagNode } from './schemas';
import { resolvedBodyNodes } from './graph-plan';
import {
  assistantModelDefaults,
  resolveNodeModel,
  resolveNodeModelScope,
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
import type {
  WorkflowRunConfigInput,
  WorkflowRunConfigLayer,
  WorkflowRunConfigMetadata,
} from './schemas/run-config';
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

// The resolvers that throw NoDefaultProviderError are pure and shared with the executor
// and validator, which hold no registry. Preflight does, so it adds the install hint here.
/**
 * Managed database values still in effect: a value a later layer replaced is no longer
 * delivered, so it is not protected. Preflight and the executor both apply this rule,
 * the executor again after it layers GitHub and provider credentials over the env.
 */
export function effectiveDbCredentialValues(
  dbEnvVars: Record<string, string>,
  envVars: Record<string, string> | undefined
): string[] {
  return Object.entries(dbEnvVars).flatMap(([key, value]) =>
    envVars?.[key] === value ? [value] : []
  );
}

export function applyRunEnvironment(
  fileConfig: WorkflowConfig,
  dbEnvVars: Record<string, string>,
  layer?: WorkflowRunConfigLayer
): WorkflowConfig {
  const config = applyWorkflowRunConfigLayer(
    { ...fileConfig, envVars: { ...fileConfig.envVars, ...dbEnvVars } },
    layer
  );
  config.protectedCredentialValues = [
    ...new Set([
      ...(config.protectedCredentialValues ?? []),
      ...effectiveDbCredentialValues(dbEnvVars, config.envVars),
    ]),
  ];
  return config;
}

export async function prepareRunAiConfiguration(
  ...args: Parameters<typeof prepareAiConfiguration>
): Promise<PreparedRunAiConfiguration> {
  try {
    return await prepareAiConfiguration(...args);
  } catch (error) {
    if (error instanceof NoDefaultProviderError)
      throw new NoDefaultProviderError(args[0].providers);
    throw error;
  }
}

type PreflightDeps = Pick<
  WorkflowDeps,
  | 'providers'
  | 'loadConfig'
  | 'getUserAiPrefs'
  | 'getAgentProvider'
  | 'sealRunConfig'
  | 'unsealRunConfig'
> & { store: Pick<WorkflowDeps['store'], 'getCodebaseEnvVars'> };

interface EffectiveRunConfig {
  effectiveRunConfig?: WorkflowRunConfigInput;
  runConfigMetadata?: WorkflowRunConfigMetadata;
}

async function prepareAiConfiguration(
  deps: PreflightDeps,
  workflow: ResolvedWorkflow,
  cwd: string,
  options: RunAiConfigurationOptions = {}
): Promise<PreparedRunAiConfiguration> {
  const executionUserId = options.continuationRun
    ? (options.continuationRun.user_id ?? undefined)
    : options.userId;
  const { effectiveRunConfig, runConfigMetadata } = resolveEffectiveRunConfig(deps, options);
  const fileConfig = await deps.loadConfig(cwd);
  const dbEnvVars = options.codebaseId
    ? await deps.store.getCodebaseEnvVars(options.codebaseId)
    : {};
  const config = applyRunEnvironment(fileConfig, dbEnvVars, effectiveRunConfig?.layer);
  const snapshot = readRecordedAiConfiguration(deps.providers, options);
  if (snapshot) restoreRunAiConfigurationDefaults(deps.providers, config, snapshot);
  const baseAiProfile = snapshot
    ? snapshot.baseAiProfile
    : await buildBaseAiProfile(deps, executionUserId, fileConfig, effectiveRunConfig);
  const resolvedModelOverrides = resolveModelOverrides(
    deps.providers,
    options,
    snapshot,
    baseAiProfile
  );
  const aiProfile = applyResolvedRunModelOverrides(baseAiProfile, resolvedModelOverrides);
  const modelBindingsMetadata = createRunModelBindingsMetadata(resolvedModelOverrides, aiProfile);
  const initialScope = resolveWorkflowModelScope(
    workflow,
    config.assistant,
    assistantModelDefaults(config),
    aiProfile
  );
  if (initialScope.provider !== undefined) requireProvider(deps.providers, initialScope.provider);
  const unresolved = collectRunCredentialRequirements(deps.providers, workflow, {
    config,
    aiProfile,
    scope: initialScope,
  }).filter(r => r.model === undefined);
  if (!snapshot) await resolveCredentialModels(deps, cwd, config, unresolved);
  const aiConfigurationSnapshot =
    snapshot ??
    createRunAiConfigurationSnapshot(deps.providers, config, baseAiProfile, resolvedModelOverrides);
  if (!snapshot) restoreRunAiConfigurationDefaults(deps.providers, config, aiConfigurationSnapshot);
  const scope = resolveWorkflowModelScope(
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

/** A continuation restores the run config it sealed at start; a fresh run seals its own. */
function resolveEffectiveRunConfig(
  deps: Pick<WorkflowDeps, 'sealRunConfig' | 'unsealRunConfig'>,
  options: RunAiConfigurationOptions
): EffectiveRunConfig {
  if (options.continuationRun !== undefined) {
    const runConfigMetadata = readWorkflowRunConfigMetadata(options.continuationRun.metadata);
    if (!runConfigMetadata) return { runConfigMetadata };
    if (!deps.unsealRunConfig) {
      throw new Error('This Archon build cannot restore persisted workflow run config.');
    }
    return {
      runConfigMetadata,
      effectiveRunConfig: {
        layer: deps.unsealRunConfig(runConfigMetadata),
        source: runConfigMetadata.source,
      },
    };
  }
  const effectiveRunConfig = options.runConfig;
  if (!effectiveRunConfig) return { effectiveRunConfig };
  if (!deps.sealRunConfig) {
    throw new Error('This Archon build cannot persist workflow run config.');
  }
  return {
    effectiveRunConfig,
    runConfigMetadata: deps.sealRunConfig(effectiveRunConfig.layer, effectiveRunConfig.source),
  };
}

/**
 * The AI configuration recorded on the continued run, else on the run this one inherits
 * from. An inherited configuration refuses a fresh run's own AI overrides unless the
 * caller asked to inherit it.
 */
function readRecordedAiConfiguration(
  providers: ProviderRegistry,
  options: RunAiConfigurationOptions
): RunAiConfigurationSnapshot | undefined {
  const snapshot =
    readRunAiConfigurationSnapshot(providers, options.continuationRun?.metadata) ??
    readRunAiConfigurationSnapshot(providers, options.aiConfigurationRun?.metadata);
  if (
    snapshot &&
    options.aiConfigurationRun &&
    !options.continuationRun &&
    !options.inheritAiConfiguration &&
    overridesAiConfiguration(options)
  ) {
    throw new Error('Cannot override AI configuration inherited from a recorded run.');
  }
  return snapshot;
}

function overridesAiConfiguration(options: RunAiConfigurationOptions): boolean {
  const layer = options.runConfig?.layer;
  if (options.modelOverrideLayer) return true;
  return (
    layer !== undefined &&
    ['assistant', 'assistants', 'tiers', 'aliases'].some(key => Object.hasOwn(layer, key))
  );
}

/** The run's AI profile from its run config, the user's stored preferences and the file config. */
async function buildBaseAiProfile(
  deps: Pick<WorkflowDeps, 'getUserAiPrefs'>,
  executionUserId: string | undefined,
  fileConfig: WorkflowConfig,
  effectiveRunConfig: WorkflowRunConfigInput | undefined
): Promise<ResolvedAiProfile> {
  const userAiPrefs = await loadUserAiPrefs(deps, executionUserId);
  const runLayer = effectiveRunConfig?.layer;
  try {
    return buildAiProfile(
      runLayer?.assistant ?? userAiPrefs.defaultProvider ?? fileConfig.assistant,
      {
        repoTiers: fileConfig.tiers,
        repoAliases: fileConfig.aliases,
        userTiers: userAiPrefs.tiers,
        userAliases: userAiPrefs.aliases,
        runTiers: runLayer?.tiers,
        runAliases: runLayer?.aliases,
      }
    );
  } catch (error) {
    // Corrupt stored preferences degrade to config-only. Invalid file or run
    // configuration still fails when rebuilt without the stored preferences.
    log.error(
      { err: error as Error, userId: executionUserId },
      'workflow.user_ai_prefs_profile_invalid'
    );
    return buildAiProfile(runLayer?.assistant ?? fileConfig.assistant, {
      repoTiers: fileConfig.tiers,
      repoAliases: fileConfig.aliases,
      runTiers: runLayer?.tiers,
      runAliases: runLayer?.aliases,
    });
  }
}

async function loadUserAiPrefs(
  deps: Pick<WorkflowDeps, 'getUserAiPrefs'>,
  executionUserId: string | undefined
): Promise<UserAiPrefsLayer> {
  if (!executionUserId || !deps.getUserAiPrefs) return {};
  try {
    return await deps.getUserAiPrefs(executionUserId);
  } catch (error) {
    log.warn(
      { err: error as Error, userId: executionUserId },
      'workflow.user_ai_prefs_resolve_failed'
    );
    return {};
  }
}

/** Recorded overrides win, then a continuation's persisted bindings, then this dispatch's. */
function resolveModelOverrides(
  providers: ProviderRegistry,
  options: RunAiConfigurationOptions,
  snapshot: RunAiConfigurationSnapshot | undefined,
  baseAiProfile: ResolvedAiProfile
): ResolvedRunModelOverrides {
  const persistedModelBindings =
    !snapshot && options.continuationRun
      ? readRunModelBindingsMetadata(providers, options.continuationRun.metadata)
      : undefined;
  const layer = options.modelOverrideLayer;
  return (
    snapshot?.modelOverrides ??
    persistedModelBindings?.overrides ??
    (layer?.kind === 'resolved'
      ? layer.overrides
      : resolveRunModelOverrides(providers, baseAiProfile, layer?.overrides))
  );
}

/** Pin the model a provider's credential resolves to, for providers no node names a model for. */
async function resolveCredentialModels(
  deps: Pick<WorkflowDeps, 'getAgentProvider'>,
  cwd: string,
  config: WorkflowConfig,
  unresolved: readonly RunCredentialRequirement[]
): Promise<void> {
  for (const provider of new Set(unresolved.map(r => r.provider))) {
    const runtime = deps.getAgentProvider(provider);
    if (!runtime.resolveCredentialModel) continue;
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
  settingSources?: NodeConfig['settingSources'];
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
      const invocation = providerInvocation(node);
      if (invocation.kind === 'none') continue;
      if (invocation.kind === 'group') {
        const group = invocation.node;
        const resolved = resolveNodeModelScope(group, scope, models, prepared.aiProfile);
        visit(resolvedBodyNodes(group.loop_group), {
          ...scope,
          provider: resolved.provider,
          model: resolved.model,
          preset: resolved.preset,
          tier: resolved.tier,
          providerOrigin: resolved.providerOrigin,
        });
        continue;
      }
      const invoked = invocation.kind === 'gate_rework' ? invocation.rework : invocation.node;
      const { provider, model } = resolveNodeModel(invoked, scope, models, prepared.aiProfile);
      requirements.set(JSON.stringify([provider, model, invoked.settingSources]), {
        provider,
        model,
        ...(invoked.settingSources !== undefined ? { settingSources: invoked.settingSources } : {}),
        vendor: requireProvider(providers, provider).credentials.vendorFor(model),
      });
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

/**
 * A credential check that could not decide, which the run starts despite. A bad
 * credential behind it then fails the first AI node as `auth`.
 */
export interface InconclusiveCredentialCheck {
  provider: string;
  vendor?: string;
  source: CredentialSource;
  evidence: string;
}

export function credentialRefusal(
  requirement: RunCredentialRequirement,
  status: CredentialStatus
): WorkflowCredentialPreflightError {
  switch (status.state) {
    case 'not_connected':
      return new WorkflowCredentialPreflightError(
        requirement,
        'no usable login; connect a credential or log in with the provider'
      );
    case 'unusable':
      return new WorkflowCredentialPreflightError(
        requirement,
        `credential cannot be used: ${status.evidence}`
      );
    case 'check_failed':
      return new WorkflowCredentialPreflightError(
        requirement,
        `could not verify: ${status.evidence}`
      );
    case 'usable':
    case 'not_checked':
      return new WorkflowCredentialPreflightError(
        requirement,
        'credential adapter returned an unsupported stored status'
      );
  }
}

/** Refuses a definite bad credential; returns a check that could not decide. */
export function assertCredentialStatus(
  requirement: RunCredentialRequirement,
  status: CredentialStatus
): InconclusiveCredentialCheck | undefined {
  switch (status.state) {
    case 'usable':
      return undefined;
    case 'not_checked':
      if (status.source === 'native') return undefined;
      throw credentialRefusal(requirement, status);
    case 'check_failed':
      return {
        provider: requirement.provider,
        ...(requirement.vendor !== undefined ? { vendor: requirement.vendor } : {}),
        source: status.source,
        evidence: status.evidence,
      };
    case 'not_connected':
    case 'unusable':
      throw credentialRefusal(requirement, status);
  }
}

// A native probe can spawn the provider's CLI. When many runs launch at once, machine load
// slows that spawn well past a quiet machine's few seconds, so the bound leaves room for a
// launch burst. A definite answer still returns as soon as the probe has it.
const NATIVE_CREDENTIAL_TIMEOUT_MS = 60_000;

async function checkNativeCredential(
  deps: Pick<WorkflowDeps, 'getAgentProvider'>,
  prepared: PreparedRunAiConfiguration,
  requirement: RunCredentialRequirement,
  context: { cwd: string; execContext?: ExecutionContext }
): Promise<CredentialStatus> {
  // A container runs with only the environment Archon forwards, never the host's.
  const baseEnv = context.execContext?.kind === 'container' ? {} : process.env;
  const signal = AbortSignal.timeout(NATIVE_CREDENTIAL_TIMEOUT_MS);
  const timedOut = (): CredentialStatus => ({
    state: 'check_failed',
    source: 'native',
    evidence: `native authentication check timed out after ${NATIVE_CREDENTIAL_TIMEOUT_MS / 1000}s; the provider did not answer, which is not a definite authentication failure`,
  });
  let status: CredentialStatus;
  try {
    status = await deps.getAgentProvider(requirement.provider).checkCredential({
      ...context,
      settingSources: requirement.settingSources,
      model: requirement.model,
      assistantConfig: prepared.config.assistants[requirement.provider],
      env: {
        ...Object.fromEntries(
          Object.entries(baseEnv).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value]]
          )
        ),
        ...prepared.config.envVars,
      },
      signal,
    });
  } catch (error) {
    log.warn(
      { err: error as Error, provider: requirement.provider },
      'workflow.native_credential_check_failed'
    );
    if (signal.aborted) return timedOut();
    // The provider's raw error is not guaranteed redacted, so it stays in the log.
    return {
      state: 'check_failed',
      source: 'native',
      evidence: 'the native authentication check failed unexpectedly',
    };
  }
  // Some providers report their own abort as a failed check rather than throwing.
  if (status.state === 'check_failed' && signal.aborted) return timedOut();
  return status;
}

type CredentialCheckDeps = Pick<
  WorkflowDeps,
  | 'providers'
  | 'getAgentProvider'
  | 'isPerUserProviderKeysEnabled'
  | 'getUserProviderCredential'
  | 'credentialStore'
>;

/** Stored credentials and statuses already read for this preflight, by vendor. */
interface StoredCredentialReads {
  credentials: Map<string, StoredProviderCredential | undefined>;
  statuses: Map<string, CredentialStatus>;
}

/**
 * What the stored-credential check left for the native check: nothing when a stored
 * credential is connected, otherwise the kind of a stored credential this provider
 * cannot consume, which only explains a missing native login.
 */
type StoredCredentialOutcome =
  | { connected: true; inconclusive?: InconclusiveCredentialCheck }
  | { connected: false; unconsumedKind?: StoredCredentialKind };

/**
 * Refuses the run on a definite bad credential and returns the checks that could not
 * decide, which do not refuse it. The caller that owns a run records them.
 */
export async function assertRunCredentials(
  deps: CredentialCheckDeps,
  prepared: PreparedRunAiConfiguration,
  // Where the provider runs, which decides the native login it sees. A host checkout and
  // the worktree cut from it share the host login, so a host run is checked before
  // isolation. A container sees only what Archon forwards, so before the container exists
  // check stored credentials only; executeWorkflow checks it in the container context.
  context: { cwd: string; execContext?: ExecutionContext } | 'pending-container'
): Promise<InconclusiveCredentialCheck[]> {
  const reads: StoredCredentialReads = { credentials: new Map(), statuses: new Map() };
  const inconclusive = new Map<string, InconclusiveCredentialCheck>();
  for (const requirement of prepared.requirements) {
    const stored = await checkStoredCredential(deps, prepared, requirement, reads);
    let check = stored.connected ? stored.inconclusive : undefined;
    if (!stored.connected && context !== 'pending-container') {
      check = await assertNativeCredential(
        deps,
        prepared,
        requirement,
        context,
        stored.unconsumedKind
      );
    }
    // Requirements that differ only by model often share one result; record it once.
    if (check) inconclusive.set(JSON.stringify(check), check);
  }
  for (const check of inconclusive.values()) {
    log.warn(check, 'workflow.credential_check_inconclusive');
  }
  return [...inconclusive.values()];
}

async function checkStoredCredential(
  deps: CredentialCheckDeps,
  prepared: PreparedRunAiConfiguration,
  requirement: RunCredentialRequirement,
  reads: StoredCredentialReads
): Promise<StoredCredentialOutcome> {
  const { provider, vendor } = requirement;
  const userId = prepared.executionUserId;
  if (
    deps.credentialStore === 'files' ||
    !userId ||
    !deps.isPerUserProviderKeysEnabled?.() ||
    !vendor
  ) {
    return { connected: false };
  }
  const stored = await storedCredentialFor(deps, userId, requirement, vendor, reads);
  // A stored credential this provider cannot consume is never delivered to it, so the
  // provider must authenticate natively; the stored kind only explains a missing login.
  if (
    stored &&
    !consumesStoredCredential(
      requireProvider(deps.providers, provider).credentials,
      vendor,
      stored.kind
    )
  ) {
    return { connected: false, unconsumedKind: stored.kind };
  }
  const status = await storedStatusFor(stored, requirement, vendor, reads);
  if (status.state === 'not_connected') {
    if (prepared.connectedVendors.has(vendor)) assertCredentialStatus(requirement, status);
    return { connected: false };
  }
  const inconclusive = assertCredentialStatus(requirement, status);
  prepared.connectedVendors.add(vendor);
  return inconclusive ? { connected: true, inconclusive } : { connected: true };
}

async function storedCredentialFor(
  deps: Pick<WorkflowDeps, 'getUserProviderCredential'>,
  userId: string,
  requirement: RunCredentialRequirement,
  vendor: string,
  reads: StoredCredentialReads
): Promise<StoredProviderCredential | undefined> {
  if (!deps.getUserProviderCredential)
    throw new WorkflowCredentialPreflightError(
      requirement,
      'credential adapter has no stored status port'
    );
  if (reads.credentials.has(vendor)) return reads.credentials.get(vendor);
  let stored: StoredProviderCredential | undefined;
  try {
    stored = await deps.getUserProviderCredential(userId, vendor);
  } catch {
    throw new WorkflowCredentialPreflightError(
      requirement,
      'could not verify the stored credential'
    );
  }
  reads.credentials.set(vendor, stored);
  return stored;
}

async function storedStatusFor(
  stored: StoredProviderCredential | undefined,
  requirement: RunCredentialRequirement,
  vendor: string,
  reads: StoredCredentialReads
): Promise<CredentialStatus> {
  const read = reads.statuses.get(vendor);
  if (read) return read;
  let status: CredentialStatus;
  try {
    status = (await stored?.getStatus()) ?? { state: 'not_connected', source: 'archon' };
  } catch {
    throw new WorkflowCredentialPreflightError(
      requirement,
      'could not verify the stored credential'
    );
  }
  reads.statuses.set(vendor, status);
  return status;
}

async function assertNativeCredential(
  deps: CredentialCheckDeps,
  prepared: PreparedRunAiConfiguration,
  requirement: RunCredentialRequirement,
  context: { cwd: string; execContext?: ExecutionContext },
  unconsumedKind: StoredCredentialKind | undefined
): Promise<InconclusiveCredentialCheck | undefined> {
  const { provider, vendor } = requirement;
  const status = await checkNativeCredential(deps, prepared, requirement, context);
  if (unconsumedKind && vendor && status.state === 'not_connected') {
    throw new WorkflowCredentialPreflightError(
      requirement,
      unconsumedStoredCredentialReason(deps.providers, provider, vendor, unconsumedKind)
    );
  }
  return assertCredentialStatus(requirement, status);
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
