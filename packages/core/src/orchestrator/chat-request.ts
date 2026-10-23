import type { ProviderCapabilities, SendQueryOptions } from '@archon/providers/types';
import {
  getProviderCapabilities,
  getRegistration,
  isRegisteredProvider,
  providerRegistry,
} from '@archon/providers';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import {
  buildAiProfile,
  isLiteralSpec,
  isTierName,
  resolveModelSpec,
  resolveTierWithFallback,
  resolvePresetEffort,
  type ModelAliasPreset,
  type TierName,
} from '@archon/workflows/model-validation';
import type { IPlatformAdapter, Conversation, Codebase } from '../types';
import { deliverCredential } from '../credentials/delivery';
import { isPerUserProviderKeysEnabled } from '../credentials/config';
import {
  ConnectedCredentialUnavailableError,
  type CredentialFailure,
} from '../credentials/unavailable-error';
import {
  resolveUserProviderCredentials,
  type UserProviderCredential,
} from '../credentials/user-provider-resolution';
import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import { loadConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
import { getCodebaseEnvVars } from '../db/env-vars';
import { generateTitleForUser } from '../services/user-title-generator';
import { buildOrchestratorSystemAppend } from './prompt-builder';
import { getLog } from './agent-log';

export function applyPresetToRequestOptions(
  provider: string,
  preset: ModelAliasPreset,
  options: SendQueryOptions
): void {
  if (preset.effort === undefined) return;

  // One effort channel for every provider (#2556): the preset's rung goes on
  // nodeConfig and the provider clamps it into its own SDK vocabulary. The gate
  // is shared with `applyPresetOptions` in the DAG executor rather than
  // restated, so the same tier cannot mean different depths in chat and in a
  // workflow.
  const decision = resolvePresetEffort(providerRegistry, provider, preset.effort);
  if (!decision.ok) {
    // `unsupported` = the provider has no reasoning control at all. Warn instead
    // of silently dropping.
    getLog().warn(
      { provider, effort: preset.effort, valid: decision.valid },
      decision.reason === 'unsupported'
        ? 'orchestrator.preset_effort_unsupported'
        : 'orchestrator.preset_effort_unknown'
    );
    return;
  }
  options.nodeConfig = { ...(options.nodeConfig ?? {}), effort: preset.effort };
}

interface ResolvedModelRequest {
  provider: string;
  model: string | undefined;
  preset?: ModelAliasPreset;
  /** When `modelRef` was a tier: which tier in the fallback chain matched. */
  matchedTier?: TierName;
}

export function resolveModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  modelRef: string,
  fallbackProvider: string
): ResolvedModelRequest {
  if (isTierName(modelRef)) {
    const { preset, matchedTier } = resolveTierWithFallback(aiProfile, modelRef);
    return { provider: preset.provider, model: preset.model, preset, matchedTier };
  }
  const spec = resolveModelSpec(aiProfile, modelRef);
  if (isLiteralSpec(spec)) {
    return { provider: fallbackProvider, model: spec.literal };
  }
  return { provider: spec.provider, model: spec.model, preset: spec };
}

/**
 * Resolve the model request for the MAIN chat turn (#1998).
 *
 * Model precedence (chat call-site only — workflows keep resolving `large`):
 *   1. per-user `default_model` — applied only when the user's
 *      `default_provider` matches the effective provider (a stale pin must
 *      never ride a different provider). Routed through resolveModelRequest so
 *      `@alias` and tier refs keep working; an unresolvable ref (e.g. deleted
 *      alias) degrades to the tier path with a warning instead of failing chat.
 *   2. tier `large` from CONFIGURED tiers (user > repo > global).
 *   3. install `assistants.<p>.model` — outranks the BUILT-IN tier default
 *      only, never a configured tier ('inherit' means "SDK default", skip).
 *   4. built-in tier default.
 *
 * Title generation is NOT routed through this — it keeps the `small` tier.
 * With no user prefs and no `assistants.<p>.model`, this reduces byte-for-byte
 * to the previous `resolveModelRequest(aiProfile, 'large', provider)` call.
 */
export function resolveChatModelRequest(
  aiProfile: ReturnType<typeof buildAiProfile>,
  configuredProviderKey: string,
  userAiPrefs: UserAiPrefs,
  config: Pick<MergedConfig, 'assistants' | 'tiers'>
): ResolvedModelRequest {
  if (
    userAiPrefs.defaultModel !== undefined &&
    userAiPrefs.defaultProvider === configuredProviderKey
  ) {
    try {
      return resolveModelRequest(aiProfile, userAiPrefs.defaultModel, configuredProviderKey);
    } catch (err) {
      getLog().warn(
        { err: err as Error, defaultModel: userAiPrefs.defaultModel },
        'orchestrator.user_default_model_invalid'
      );
    }
  }
  const request = resolveModelRequest(aiProfile, 'large', configuredProviderKey);
  if (request.matchedTier === undefined) return request;

  const tierConfigured =
    config.tiers?.[request.matchedTier] !== undefined ||
    userAiPrefs.tiers?.[request.matchedTier] !== undefined;
  if (tierConfigured) return request;

  const installModel = config.assistants[request.provider]?.model;
  if (typeof installModel === 'string' && installModel !== '' && installModel !== 'inherit') {
    return { ...request, model: installModel };
  }
  return request;
}

/** A resolved title-generation request: which provider to call, with fully resolved options. */
export interface TitleRequest {
  provider: string;
  options: SendQueryOptions;
}

/**
 * The title-generation request on the `small` tier. `env` is set on the options only when
 * the caller passes one.
 */
export function titleRequestOptions(
  aiProfile: ReturnType<typeof buildAiProfile>,
  providerKey: string,
  config: Pick<MergedConfig, 'assistants'>,
  env?: Record<string, string>
): TitleRequest {
  const titleRequest = resolveModelRequest(aiProfile, 'small', providerKey);
  const options: SendQueryOptions = {
    model: titleRequest.model,
    assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
    ...(env !== undefined ? { env } : {}),
  };
  if (titleRequest.preset) {
    applyPresetToRequestOptions(titleRequest.provider, titleRequest.preset, options);
  }
  return { provider: titleRequest.provider, options };
}

/**
 * Resolve provider + request options for conversation-title generation (#1855).
 *
 * Entry points that fire title generation outside a full chat turn
 * (create-with-message, web workflow run, CLI workflow run) resolve the `small` tier here —
 * config tiers plus per-user prefs when a userId is available — instead of
 * letting the provider fall through to its raw config-default model, which
 * the active account may not support (e.g. `gpt-5.3-codex` on ChatGPT-plan
 * Codex accounts). The chat path (`prepareChatTurnRequest`, #1873) reuses its
 * already-loaded config and profile instead; both paths build options through
 * `titleRequestOptions`.
 *
 * NEVER THROWS — degrades to `{ provider: fallbackProvider, options: {} }`
 * (the legacy behavior) so fire-and-forget callers stay safe.
 */
export async function resolveTitleRequest(
  fallbackProvider: string,
  userId?: string,
  repoPath?: string
): Promise<TitleRequest> {
  try {
    const config = await loadConfig(repoPath);
    const userAiPrefs = userId ? await resolveUserAiPrefsForChat(userId) : {};
    let configuredProviderKey = userAiPrefs.defaultProvider ?? fallbackProvider;
    let aiProfile: ReturnType<typeof buildAiProfile>;
    try {
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
        userTiers: userAiPrefs.tiers,
        userAliases: userAiPrefs.aliases,
      });
    } catch (profileErr) {
      // Structurally invalid STORED prefs must not break title generation —
      // degrade to config-only (mirrors prepareChatTurnRequest).
      getLog().warn({ err: profileErr as Error, userId }, 'orchestrator.title_prefs_invalid');
      configuredProviderKey = fallbackProvider;
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
      });
    }
    return titleRequestOptions(aiProfile, configuredProviderKey, config);
  } catch (err) {
    getLog().warn(
      { err: err as Error, fallbackProvider },
      'orchestrator.title_request_resolve_failed'
    );
    return { provider: fallbackProvider, options: {} };
  }
}

/**
 * Resolve the per-user AI-provider credential env for a direct-chat turn
 * (Phase 2). Every usable connected credential is delivered as env, the ChatGPT
 * subscription included, so chat and workflows authenticate the same way.
 *
 * A connected credential that cannot be used is returned in `failed`, keyed by
 * vendor, with a reason that is safe to show. The caller refuses a turn whose own
 * vendor failed: running it would authenticate with the host's login instead of
 * the user's. Throws when the user's credentials cannot be listed, for the same
 * reason.
 */
export async function resolveUserProviderEnvForChat(userId: string): Promise<{
  env: Record<string, string>;
  failed: Map<string, CredentialFailure>;
  credentials: UserProviderCredential[];
}> {
  const env: Record<string, string> = {};
  const failed = new Map<string, CredentialFailure>();
  const credentials = await resolveUserProviderCredentials(userId);
  for (const { provider, vendor, stored } of credentials) {
    if (stored.state === 'usable') {
      try {
        Object.assign(env, deliverCredential(provider, stored.credential).env);
      } catch (err) {
        getLog().error(
          { err: err as Error, userId, provider },
          'orchestrator.provider_creds_deliver_failed'
        );
        failed.set(vendor, { reason: (err as Error).message, retryable: false });
      }
    } else if (stored.state !== 'not_connected') {
      // `not_connected` here means the row was deleted after the listing: the user has
      // no credential for this vendor, so the host login is theirs to use, as before.
      failed.set(vendor, {
        reason: stored.evidence,
        retryable: stored.state === 'check_failed',
      });
    }
  }
  return { env, failed, credentials };
}

/**
 * Resolve the user's personal AI prefs (tiers / aliases / default assistant)
 * for a direct-chat turn (Phase 3). Folded into `buildAiProfile` as the
 * highest-precedence layer.
 *
 * NEVER THROWS — returns `{}` on any failure so model resolution falls back
 * to install-wide config exactly as before.
 */
export async function resolveUserAiPrefsForChat(userId: string): Promise<UserAiPrefs> {
  try {
    return await getUserAiPrefs(userId);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'orchestrator.user_ai_prefs_resolve_failed');
    return {};
  }
}

/**
 * Conversations (DB ids) already nudged about a tier fallback. Process-lifetime
 * memory is intentional and sufficient: the nudge is a discovery aid, not
 * state — a server restart re-nudging once per conversation is acceptable.
 */
const tierFallbackNudgedConversations = new Set<string>();

interface ChatTurnRequestInput {
  platform: IPlatformAdapter;
  conversationId: string;
  conversation: Conversation;
  message: string;
  trimmedMessage: string;
  /** The message sender, when the adapter resolved one. */
  userId: string | undefined;
  codebases: readonly Codebase[];
  workflows: readonly ResolvedWorkflow[];
  config: MergedConfig;
  cwd: string;
}

export interface ChatTurnRequest {
  providerKey: string;
  requestOptions: SendQueryOptions;
  caps: ProviderCapabilities;
}

/**
 * Resolve the provider, model, env and system prompt for one direct-chat turn, and start
 * title generation for an untitled conversation. Throws `ConnectedCredentialUnavailableError`
 * when the turn's vendor has a connected credential that cannot be used.
 */
export async function prepareChatTurnRequest(
  input: ChatTurnRequestInput
): Promise<ChatTurnRequest> {
  const {
    platform,
    conversationId,
    conversation,
    message,
    trimmedMessage,
    userId,
    codebases,
    workflows,
    config,
    cwd,
  } = input;
  const executionUserId = resolveChatExecutionUser(userId, conversation, conversationId);
  // Per-user AI prefs (Phase 3): the user's tiers/aliases/default-assistant
  // override install config (highest precedence). `{}` (no identity, no row,
  // or DB failure) keeps config-only behavior byte-for-byte.
  const userAiPrefs = executionUserId ? await resolveUserAiPrefsForChat(executionUserId) : {};
  const { configuredProviderKey, aiProfile } = resolveChatProfile(
    userAiPrefs,
    conversation.ai_assistant_type,
    config,
    executionUserId
  );
  // Main chat model: per-user default_model > configured `large` tier >
  // install assistants.<p>.model > built-in tier default (#1998).
  const chatRequest = resolveChatModelRequest(aiProfile, configuredProviderKey, userAiPrefs, {
    assistants: config.assistants,
    tiers: config.tiers,
  });
  await reportTierFallback(platform, conversationId, conversation.id, chatRequest);
  const providerKey = chatRequest.provider;
  const dbEnvVars = await loadChatCodebaseEnv(conversation.codebase_id);
  // Per-user AI-provider credentials (Phase 2), delivered as env. Merged LAST
  // so a connected user's keys win over file/db env. No-op when the feature is
  // disabled or no execution identity resolved (sender, else creator).
  //
  // A request whose vendor has a connected credential that failed must not run: it
  // would authenticate with the host's login. A provider whose credentials have no
  // static vendor for the model (OpenCode, an unparsed Pi model) consumes no stored
  // credential, so it is not checked, as in workflow preflight.
  const delivery =
    isPerUserProviderKeysEnabled() && executionUserId
      ? await resolveUserProviderEnvForChat(executionUserId)
      : { env: {}, failed: new Map<string, CredentialFailure>(), credentials: undefined };
  refuseFailedChatCredential(providerKey, chatRequest.model, delivery.failed);
  const userProviderEnv: Record<string, string> = delivery.env;
  const protectedEnvKeys = Object.keys(userProviderEnv);
  const effectiveEnv = { ...(config.envVars ?? {}), ...dbEnvVars, ...userProviderEnv };

  const caps = getProviderCapabilities(providerKey);
  // Warn if provider doesn't support env injection but env vars are configured
  if (Object.keys(effectiveEnv).length > 0) {
    if (!caps.envInjection) {
      getLog().warn(
        { provider: providerKey, envVarCount: Object.keys(effectiveEnv).length },
        'orchestrator.unsupported_env_injection'
      );
    }
  }

  const systemAppend = await buildOrchestratorSystemAppend(
    conversation,
    codebases,
    workflows,
    caps.nativeTools ? 'tools' : 'cli'
  );
  const requestOptions: SendQueryOptions = {
    assistantConfig: { ...(config.assistants[providerKey] ?? {}) },
    env: Object.keys(effectiveEnv).length > 0 ? effectiveEnv : undefined,
    protectedEnvKeys: protectedEnvKeys.length > 0 ? protectedEnvKeys : undefined,
    userCredentialEnvKeys: Object.keys(userProviderEnv),
    model: chatRequest.model,
    appendSystemPrompt: systemAppend,
  };
  if (chatRequest.preset) {
    applyPresetToRequestOptions(providerKey, chatRequest.preset, requestOptions);
  }

  if (!conversation.title && !trimmedMessage.startsWith('/')) {
    void generateTitleForUser(
      conversation.id,
      message,
      titleRequestOptions(aiProfile, configuredProviderKey, config, {
        ...(config.envVars ?? {}),
        ...dbEnvVars,
      }),
      cwd,
      executionUserId,
      undefined,
      delivery.credentials
    );
  }
  return { providerKey, requestOptions, caps };
}

function resolveChatExecutionUser(
  userId: string | undefined,
  conversation: Conversation,
  conversationId: string
): string | undefined {
  // Execution identity: the message sender when the adapter resolved one,
  // else the conversation creator (solo installs / legacy rows / surfaces
  // without auth). Sender-first mirrors the workflow executor, which
  // resolves prefs from the run starter — without it, a multi-user thread
  // would execute every turn on the creator's credentials (#1976).
  const executionUserId = userId ?? conversation.user_id ?? undefined;
  if (!userId && conversation.user_id && isPerUserProviderKeysEnabled()) {
    // No sender identity arrived with this turn while per-user credentials
    // are active — the turn executes (and bills) as the conversation
    // CREATOR. Distinguishes a degraded auth resolution from the normal
    // solo-install path (where per-user keys are off and this stays silent).
    getLog().warn(
      { conversationId, fallbackUserId: conversation.user_id },
      'orchestrator.execution_identity_creator_fallback'
    );
  }
  return executionUserId;
}

function resolveChatProfile(
  userAiPrefs: UserAiPrefs,
  fallbackProvider: string,
  config: MergedConfig,
  executionUserId: string | undefined
): { configuredProviderKey: string; aiProfile: ReturnType<typeof buildAiProfile> } {
  let configuredProviderKey = userAiPrefs.defaultProvider ?? fallbackProvider;
  let aiProfile: ReturnType<typeof buildAiProfile>;
  try {
    aiProfile = buildAiProfile(configuredProviderKey, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
      userTiers: userAiPrefs.tiers,
      userAliases: userAiPrefs.aliases,
    });
  } catch (profileErr) {
    // Structurally invalid STORED prefs (corrupt DB row) must not break the
    // user's chat — degrade to config-only. A broken config layer still
    // fails fast: the rebuild rethrows the same error.
    getLog().error(
      { err: profileErr as Error, userId: executionUserId },
      'orchestrator.user_ai_prefs_profile_invalid'
    );
    configuredProviderKey = fallbackProvider;
    aiProfile = buildAiProfile(configuredProviderKey, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
    });
  }
  return { configuredProviderKey, aiProfile };
}

async function reportTierFallback(
  platform: IPlatformAdapter,
  conversationId: string,
  dbConversationId: string,
  chatRequest: ResolvedModelRequest
): Promise<void> {
  // Tier-fallback nudge (mirrors dag.model_provider_conflict): chat asks for
  // 'large'; when that tier is unset and a sibling preset answered, tell the
  // user ONCE PER CONVERSATION, non-blocking — the dedup Set is what
  // keeps it from becoming a per-message banner (review C1). Only the main
  // chat request nags — the background title model ('small') falls back
  // silently. Delivery failure must never fail the chat turn.
  if (
    chatRequest.matchedTier !== undefined &&
    chatRequest.matchedTier !== 'large' &&
    !tierFallbackNudgedConversations.has(dbConversationId)
  ) {
    // Mark BEFORE attempting delivery: a failed send shouldn't retry the
    // nudge on every subsequent message either.
    tierFallbackNudgedConversations.add(dbConversationId);
    getLog().warn(
      {
        requestedTier: 'large',
        matchedTier: chatRequest.matchedTier,
        provider: chatRequest.provider,
        model: chatRequest.model,
      },
      'orchestrator.tier_fallback_nudge'
    );
    try {
      await platform.sendMessage(
        conversationId,
        `ℹ️ Model tier 'large' isn't configured — using the '${chatRequest.matchedTier}' preset ` +
          `(${chatRequest.provider}/${chatRequest.model ?? ''}). Set it in Settings → Model Tiers ` +
          'or `archon ai tier set large <provider> <model>`.'
      );
    } catch (nudgeErr) {
      getLog().warn(
        { err: nudgeErr as Error, conversationId },
        'orchestrator.tier_fallback_nudge_delivery_failed'
      );
    }
  }
}

async function loadChatCodebaseEnv(codebaseId: string | null): Promise<Record<string, string>> {
  let dbEnvVars: Record<string, string> = {};
  if (codebaseId) {
    try {
      dbEnvVars = await getCodebaseEnvVars(codebaseId);
    } catch (error) {
      getLog().warn({ err: error as Error, codebaseId }, 'codebase_env_vars_load_failed');
    }
  }
  return dbEnvVars;
}

function refuseFailedChatCredential(
  provider: string,
  model: string | undefined,
  failed: ReadonlyMap<string, CredentialFailure>
): void {
  // An unregistered provider fails where it is used; the credential check must not mask it.
  if (failed.size === 0 || !isRegisteredProvider(provider)) return;
  const vendor = getRegistration(provider).credentials.vendorFor(model);
  const failure = vendor !== undefined ? failed.get(vendor) : undefined;
  if (vendor !== undefined && failure !== undefined) {
    throw new ConnectedCredentialUnavailableError(vendor, failure);
  }
}
