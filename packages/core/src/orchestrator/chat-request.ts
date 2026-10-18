import type { SendQueryOptions } from '@archon/providers/types';
import { providerRegistry } from '@archon/providers';
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
import { deliverCredential } from '../credentials/delivery';
import type { CredentialFailure } from '../credentials/unavailable-error';
import {
  resolveUserProviderCredentials,
  type UserProviderCredential,
} from '../credentials/user-provider-resolution';
import { getUserAiPrefs, type UserAiPrefs } from '../db/user-ai-prefs-store';
import { loadConfig } from '../config/config-loader';
import type { MergedConfig } from '../config/config-types';
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
 * Resolve provider + request options for conversation-title generation (#1855).
 *
 * Entry points that fire title generation outside a full chat turn
 * (create-with-message, web workflow run, CLI workflow run) resolve the `small` tier here —
 * config tiers plus per-user prefs when a userId is available — instead of
 * letting the provider fall through to its raw config-default model, which
 * the active account may not support (e.g. `gpt-5.3-codex` on ChatGPT-plan
 * Codex accounts). Mirrors the chat path's title resolution in
 * `handleMessage` (#1873), which keeps its own inline resolution to reuse
 * the already-loaded config and profile.
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
      // degrade to config-only (mirrors the chat path in handleMessage).
      getLog().warn({ err: profileErr as Error, userId }, 'orchestrator.title_prefs_invalid');
      configuredProviderKey = fallbackProvider;
      aiProfile = buildAiProfile(configuredProviderKey, {
        repoTiers: config.tiers,
        repoAliases: config.aliases,
      });
    }
    const titleRequest = resolveModelRequest(aiProfile, 'small', configuredProviderKey);
    const options: SendQueryOptions = {
      model: titleRequest.model,
      assistantConfig: { ...(config.assistants[titleRequest.provider] ?? {}) },
    };
    if (titleRequest.preset) {
      applyPresetToRequestOptions(titleRequest.provider, titleRequest.preset, options);
    }
    return { provider: titleRequest.provider, options };
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
