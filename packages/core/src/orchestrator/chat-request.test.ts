// @archon-test-isolated
/** Covers chat-request.ts, directly and through `handleMessage`; shared mocks live in `../test/orchestrator-agent-harness`. */
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import type { Conversation } from '../types';
import {
  DEFAULT_PROVIDER_CAPS,
  chatDispatchLogs,
  makeConfig,
  makeConversation,
  makePlatform,
  mockChatVendor,
  mockDiscoverWorkflowsWithConfig,
  mockGenerateAndSetTitle,
  mockGetOrCreateConversation,
  mockGetRecentWorkflowResultMessages,
  mockGetUserAiPrefsDb,
  mockIsPerUserProviderKeysEnabled,
  mockIsRegisteredProvider,
  mockListCodebases,
  mockListUserProviderKeys,
  mockLoadConfig,
  mockLogger,
  mockParseCommand,
  mockSendQuery,
  mockStoredProviderCredentials,
  operator,
} from '../test/orchestrator-agent-harness';
import { handleMessage } from './orchestrator-agent';
import { resolveChatModelRequest, resolveTitleRequest } from './chat-request';
import { buildAiProfile } from '@archon/workflows/model-validation';

// ─── resolveUserProviderEnvForChat — per-user credential injection ────────────

describe('resolveUserProviderEnvForChat — chat env injection', () => {
  beforeEach(() => {
    mockSendQuery.mockReset();
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'session-1' };
    });
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ user_id: 'u-test' }))
    );
    mockGetRecentWorkflowResultMessages.mockReset();
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockStoredProviderCredentials.mockReset();
    mockStoredProviderCredentials.mockImplementation(async () => []);
    mockChatVendor.mockReset();
    mockListUserProviderKeys.mockClear();
    mockChatVendor.mockImplementation(() => 'anthropic');
    mockIsRegisteredProvider.mockReset();
    mockIsRegisteredProvider.mockImplementation(() => true);
    mockIsPerUserProviderKeysEnabled.mockReset();
    mockIsPerUserProviderKeysEnabled.mockImplementation(() => true);
    mockGenerateAndSetTitle.mockReset();
    mockGenerateAndSetTitle.mockImplementation(() => Promise.resolve());
  });

  test('injects api_key env vars from a connected provider', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'or-key' } },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    // The env passed to sendQuery should contain the provider's env var.
    const requestOptions = mockSendQuery.mock.calls[0]?.[3] as {
      env?: Record<string, string>;
      protectedEnvKeys?: readonly string[];
      userCredentialEnvKeys?: readonly string[];
    };
    expect(requestOptions?.userCredentialEnvKeys).toEqual(['OPENROUTER_API_KEY']);
    expect(requestOptions?.env).toMatchObject({ OPENROUTER_API_KEY: 'or-key' });
    expect(requestOptions?.protectedEnvKeys).toEqual(['OPENROUTER_API_KEY']);
  });

  test('a Claude subscription reaches chat only as CLAUDE_CODE_OAUTH_TOKEN; Pi gets no ANTHROPIC_OAUTH_TOKEN', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        cred: { kind: 'oauth', oauthApiKey: 'sk-ant-oat01-x', rawCreds: {} },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    const requestOptions = mockSendQuery.mock.calls[0]?.[3] as { env?: Record<string, string> };
    expect(requestOptions?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(requestOptions?.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
  });

  test('title generation receives the per-user env bag (#1984)', async () => {
    // The title-gen branch (if (!conversation.title)) previously built titleOptions
    // with no env, so title generation ran with no per-user subscription and failed
    // on per-user-only installs. title: null enters the branch; assert the bag flows.
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ user_id: 'u-test', title: null }))
    );
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        cred: { kind: 'oauth', oauthApiKey: 'sk-ant-oat01-x', rawCreds: {} },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello there', { actor: operator });
    // generateAndSetTitle(convId, msg, provider, cwd, sessionId?, assistantConfig?, titleOptions)
    const titleOptions = mockGenerateAndSetTitle.mock.calls[0]?.[6] as
      | { env?: Record<string, string>; protectedEnvKeys?: readonly string[] }
      | undefined;
    expect(titleOptions?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(titleOptions?.protectedEnvKeys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  test('a ChatGPT subscription reaches chat as the in-memory Codex login env, with no CODEX_HOME', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'openai',
        cred: { kind: 'oauth', oauthApiKey: 'tok', rawCreds: { access: 'tok', accountId: 'acct' } },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    const requestOptions = mockSendQuery.mock.calls[0]?.[3] as
      | { env?: Record<string, string>; protectedEnvKeys?: string[] }
      | undefined;
    expect(requestOptions?.env).toMatchObject({
      ARCHON_CODEX_CHATGPT_ACCESS_TOKEN: 'tok',
      ARCHON_CODEX_CHATGPT_ACCOUNT_ID: 'acct',
    });
    expect(requestOptions?.protectedEnvKeys).toEqual([
      'ARCHON_CODEX_CHATGPT_ACCESS_TOKEN',
      'ARCHON_CODEX_CHATGPT_ACCOUNT_ID',
    ]);
    expect(requestOptions?.env?.CODEX_HOME).toBeUndefined();
  });

  test('skips one broken credential but includes remaining providers', async () => {
    // 'mystery-broken' is not in KNOWN_PROVIDERS → deliverCredential throws.
    mockStoredProviderCredentials.mockResolvedValue([
      { provider: 'mystery-broken', cred: { kind: 'api_key', apiKey: 'x' } },
      { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'or-key' } },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    const requestOptions = mockSendQuery.mock.calls[0]?.[3] as { env?: Record<string, string> };
    expect(requestOptions?.env).toMatchObject({ OPENROUTER_API_KEY: 'or-key' });
  });

  test('refuses the turn when the connected credentials cannot be listed', async () => {
    // Without the list, the turn cannot tell whether the user has a credential of their
    // own, and running it would use the host login.
    mockStoredProviderCredentials.mockRejectedValue(new Error('db gone'));
    const platform = makePlatform();
    await expect(
      handleMessage(platform, 'conv-1', 'hello', { actor: operator })
    ).resolves.toBeUndefined();
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  const sentText = (platform: ReturnType<typeof makePlatform>): string =>
    platform.sendMessage.mock.calls.map(call => String(call[1])).join('\n');

  test('refuses a Codex turn whose connected subscription cannot be delivered (#4245)', async () => {
    mockChatVendor.mockReturnValue('openai');
    // No ChatGPT account id: delivery throws, and the turn would otherwise run Codex on
    // the host's own login.
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'openai',
        cred: { kind: 'oauth', oauthApiKey: 'sub-access', rawCreds: { access: 'sub-access' } },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockSendQuery).not.toHaveBeenCalled();
    const sent = sentText(platform);
    expect(sent).toContain('Your connected openai credential cannot be used');
    expect(sent).toContain('reconnect it with `archon ai login openai`');
    expect(sent).not.toContain('sub-access');
  });

  test('refuses a turn whose connected credential is unusable', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        status: {
          state: 'unusable',
          source: 'archon',
          evidence: 'The vendor rejected the refresh.',
        },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockSendQuery).not.toHaveBeenCalled();
    expect(sentText(platform)).toContain(
      'Your connected anthropic credential cannot be used: The vendor rejected the refresh.'
    );
  });

  test('a credential check that could not decide asks the user to retry, not reconnect', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        status: { state: 'check_failed', source: 'archon', evidence: 'The vendor timed out.' },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockSendQuery).not.toHaveBeenCalled();
    expect(sentText(platform)).toContain('The vendor timed out. Try again in a moment');
  });

  test('skips the title when the title model’s credential failed, and still runs the turn', async () => {
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ user_id: 'u-test', title: null }))
    );
    // The chat model is on anthropic; the `small` title model is on openai.
    mockChatVendor.mockReturnValueOnce('anthropic').mockReturnValueOnce('openai');
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'openai',
        status: { state: 'unusable', source: 'archon', evidence: 'Revoked.' },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello there', { actor: operator });
    expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
  });

  test('a title tier on an unregistered provider keeps its fallback when a credential failed', async () => {
    // Title generation falls back to a truncated title for an unknown provider; the
    // credential check must not throw first and fail the user's turn.
    mockIsRegisteredProvider.mockImplementation(provider => provider !== 'ghost');
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ user_id: 'u-test', title: null }))
    );
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({ tiers: { small: { provider: 'ghost', model: 'ghost-model' } } })
    );
    mockStoredProviderCredentials.mockResolvedValue([
      { provider: 'openai', status: { state: 'unusable', source: 'archon', evidence: 'Revoked.' } },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello there', { actor: operator });
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
    expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
    expect(mockGenerateAndSetTitle.mock.calls[0]?.[2]).toBe('ghost');
  });

  test('runs on the host login when the user connected nothing for the turn vendor', async () => {
    mockStoredProviderCredentials.mockResolvedValue([
      {
        provider: 'openai',
        status: { state: 'unusable', source: 'archon', evidence: 'Unrelated vendor.' },
      },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
  });

  test('skips injection when feature is disabled', async () => {
    // Persistent (not Once): the flag is install-level and read more than once
    // per turn (creator-fallback warn guard + the env seam itself).
    mockIsPerUserProviderKeysEnabled.mockReturnValue(false);
    mockStoredProviderCredentials.mockResolvedValue([
      { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'or-key' } },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockListUserProviderKeys).not.toHaveBeenCalled();
  });

  test('resolves credentials from the SENDER, not the conversation creator (#1976)', async () => {
    // beforeEach sets the conversation row's user_id to 'u-test' (the creator).
    // A different sender on this turn must use their OWN credentials — never
    // the creator's.
    mockStoredProviderCredentials.mockResolvedValue([
      { provider: 'openrouter', cred: { kind: 'api_key', apiKey: 'sender-key' } },
    ]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', {
      actor: { kind: 'user', userId: 'sender-2' },
    });
    expect(mockListUserProviderKeys).toHaveBeenCalledWith('sender-2');
    expect(mockListUserProviderKeys).not.toHaveBeenCalledWith('u-test');
  });

  test('falls back to the conversation creator for credentials when no sender (S1)', async () => {
    // Pins the env seam's fallback ARGUMENT — the prefs seam already asserts
    // its fallback attribution; without this, a regression of the env seam to
    // `undefined` would slip through the mock unnoticed.
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(mockListUserProviderKeys).toHaveBeenCalledWith('u-test');
  });

  test('prefs and credentials resolve to the SAME identity in a single turn (S1)', async () => {
    // Guards seam divergence: each seam's revert is caught individually, but
    // one seam silently using a different identity than the other is not.
    mockGetUserAiPrefsDb.mockClear();
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', {
      actor: { kind: 'user', userId: 'sender-2' },
    });
    expect(mockGetUserAiPrefsDb).toHaveBeenCalledWith('sender-2');
    expect(mockListUserProviderKeys).toHaveBeenCalledWith('sender-2');
  });
});

// ─── Per-user AI prefs + tier-fallback nudge (Phase 3) ──────────────────────

describe('per-user AI prefs in chat + tier-fallback nudge', () => {
  beforeEach(() => {
    mockGetUserAiPrefsDb.mockClear();
    mockGetUserAiPrefsDb.mockImplementation(async () => ({}));
    mockSendQuery.mockClear();
    mockParseCommand.mockReturnValue({ command: '', args: [] });
  });

  test("a user's tier override wins for the chat model", async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'user-9' } as Partial<Conversation>))
    );
    mockGetUserAiPrefsDb.mockImplementation(async () => ({
      tiers: { large: { provider: 'codex', model: 'gpt-5.5' } },
    }));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockGetUserAiPrefsDb).toHaveBeenCalledWith('user-9');
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.model).toBe('gpt-5.5');
  });

  test('prefs are not consulted when the conversation has no user_id', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeConversation()));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockGetUserAiPrefsDb).not.toHaveBeenCalled();
  });

  test("the sender's prefs win over the conversation creator's (#1976)", async () => {
    // Multi-user thread: the conversation row carries the FIRST creator, but
    // the turn must execute with the SENDER's prefs (mirrors the workflow
    // executor's run-starter resolution).
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'creator-1' } as Partial<Conversation>))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', {
      actor: { kind: 'user', userId: 'sender-2' },
    });

    expect(mockGetUserAiPrefsDb).toHaveBeenCalledWith('sender-2');
    expect(mockGetUserAiPrefsDb).not.toHaveBeenCalledWith('creator-1');
  });

  test('falls back to conversation.user_id when the context has no sender', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'creator-1' } as Partial<Conversation>))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockGetUserAiPrefsDb).toHaveBeenCalledWith('creator-1');
  });

  test("per-user default provider wins over the conversation's stored assistant (#2241 chain)", async () => {
    // Chain order: user pref → conversation row (creation-time default). The
    // row says claude; the user's personal default assistant must win.
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'user-9' } as Partial<Conversation>))
    );
    mockGetUserAiPrefsDb.mockImplementation(async () => ({ defaultProvider: 'codex' }));
    mockLogger.info.mockClear();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(chatDispatchLogs()[0]?.provider).toBe('codex');
  });

  test("without an identity the conversation's stored assistant drives the turn (#2241 chain)", async () => {
    // No sender and no creator: the creation-time default on the conversation
    // row (resolved from config since #2241) is what executes.
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ ai_assistant_type: 'codex' }))
    );
    mockLogger.info.mockClear();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockGetUserAiPrefsDb).not.toHaveBeenCalled();
    expect(chatDispatchLogs()[0]?.provider).toBe('codex');
  });

  test('logs one dispatch line per turn tying both conversation ids to the provider and model (#1898)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'user-9' } as Partial<Conversation>))
    );
    mockGetUserAiPrefsDb.mockImplementation(async () => ({
      tiers: { large: { provider: 'codex', model: 'gpt-5.5' } },
    }));
    mockLogger.info.mockClear();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'secret prompt text', { actor: operator });

    const logs = chatDispatchLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      conversationId: 'conv-1-db',
      platformConversationId: 'conv-1',
      provider: 'codex',
      model: 'gpt-5.5',
    });
    expect(JSON.stringify(logs[0])).not.toContain('secret prompt text');
  });

  test('structurally invalid stored prefs degrade to config-only (chat still answers)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'user-9' } as Partial<Conversation>))
    );
    // An alias without the '@' prefix makes buildAiProfile throw.
    mockGetUserAiPrefsDb.mockImplementation(async () => ({
      aliases: { fast: { provider: 'claude', model: 'haiku' } },
    }));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    // Degraded to the config profile — the chat turn still reached the AI.
    expect(mockSendQuery).toHaveBeenCalled();
  });

  test('profile-invalid log attributes the EXECUTION identity, not the creator (S1)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'creator-1' } as Partial<Conversation>))
    );
    // Sender's stored prefs are corrupt → buildAiProfile throws → degrade path
    // logs the identity whose prefs were at fault: the sender.
    mockGetUserAiPrefsDb.mockImplementation(async () => ({
      aliases: { fast: { provider: 'claude', model: 'haiku' } },
    }));
    mockLogger.error.mockClear();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', {
      actor: { kind: 'user', userId: 'sender-2' },
    });

    const invalidLog = mockLogger.error.mock.calls.find(
      c => c[1] === 'orchestrator.user_ai_prefs_profile_invalid'
    ) as [Record<string, unknown>, string] | undefined;
    expect(invalidLog).toBeDefined();
    expect(invalidLog?.[0].userId).toBe('sender-2');
  });

  test('a prefs DB failure falls back to config-only (chat still answers)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ user_id: 'user-9' } as Partial<Conversation>))
    );
    mockGetUserAiPrefsDb.mockImplementation(async () => {
      throw new Error('db down');
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    expect(mockSendQuery).toHaveBeenCalled();
  });

  test("nudges once per conversation (not per message) when tier 'large' falls back", async () => {
    // 'unknownprov' has no built-in tier defaults; config sets only `small`,
    // so the chat's 'large' request resolves via the fallback chain. A distinct
    // conversation id keeps the module-level dedup Set isolated from other tests.
    const nudgeConversation = makeConversation({
      id: 'conv-nudge-dedup',
      platform_conversation_id: 'conv-nudge-dedup',
      ai_assistant_type: 'unknownprov',
    });
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(nudgeConversation));
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve(
        makeConfig({
          assistants: { claude: {}, codex: {} },
          envVars: {},
          tiers: { small: { provider: 'claude', model: 'haiku' } },
        })
      )
    );

    try {
      const platform = makePlatform();
      await handleMessage(platform, 'conv-nudge-dedup', 'Hello', { actor: operator });
      await handleMessage(platform, 'conv-nudge-dedup', 'Hello again', { actor: operator });

      const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as unknown as [
        string,
        string,
      ][];
      const nudges = sendCalls.filter(c => c[1].includes("tier 'large' isn't configured"));
      // Review C1: exactly ONE nudge across BOTH messages — per-conversation dedup.
      expect(nudges.length).toBe(1);
      expect(nudges[0]?.[1]).toContain("'small' preset");
      // Non-blocking: both chat turns still went to the AI.
      expect(mockSendQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
      mockLoadConfig.mockImplementation(() => Promise.resolve(makeConfig()));
    }
  });

  test("no nudge when the user's own 'large' tier satisfies the request", async () => {
    // Provider with no built-in defaults + only the USER's large tier set:
    // exact match through the per-user layer → no fallback, no nudge.
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(
        makeConversation({
          id: 'conv-user-large',
          platform_conversation_id: 'conv-user-large',
          ai_assistant_type: 'unknownprov',
          user_id: 'user-9',
        } as Partial<Conversation>)
      )
    );
    mockGetUserAiPrefsDb.mockImplementation(async () => ({
      tiers: { large: { provider: 'claude', model: 'opus' } },
    }));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-user-large', 'Hello', { actor: operator });

    const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as unknown as [
      string,
      string,
    ][];
    expect(sendCalls.some(c => c[1].includes("isn't configured"))).toBe(false);
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.model).toBe('opus');
  });

  test('no nudge when the large tier resolves exactly', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ ai_assistant_type: 'claude' }))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello', { actor: operator });

    const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as unknown as [
      string,
      string,
    ][];
    expect(sendCalls.some(c => c[1].includes("isn't configured"))).toBe(false);
  });
});

// ─── resolveChatModelRequest (#1998): per-user default chat model ─────────────

describe('resolveChatModelRequest', () => {
  // Minimal MergedConfig slice: both built-in providers present (AssistantDefaults).
  const emptyConfig = { assistants: { claude: {}, codex: {} }, tiers: undefined };

  test('no user prefs and no install model → plain built-in large tier (solo path unchanged)', () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(profile, 'claude', {}, emptyConfig);
    expect(req.provider).toBe('claude');
    expect(req.model).toBe('opus');
    expect(req.matchedTier).toBe('large');
  });

  test('user default_model replaces the large-tier lookup when the provider matches', () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(
      profile,
      'claude',
      { defaultProvider: 'claude', defaultModel: 'sonnet' },
      emptyConfig
    );
    expect(req.provider).toBe('claude');
    expect(req.model).toBe('sonnet');
    expect(req.matchedTier).toBeUndefined(); // literal path — no tier nudge
  });

  test('user default_model is IGNORED when the effective provider differs (stale pin guard)', () => {
    // e.g. degraded profile reset the provider to the conversation's assistant.
    const profile = buildAiProfile('codex');
    const req = resolveChatModelRequest(
      profile,
      'codex',
      { defaultProvider: 'claude', defaultModel: 'sonnet' },
      emptyConfig
    );
    expect(req.provider).toBe('codex');
    expect(req.model).toBe(profile.aliases.large?.model); // built-in codex large tier
    expect(req.matchedTier).toBe('large');
  });

  test('user default_model set without default_provider is ignored', () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(profile, 'claude', { defaultModel: 'sonnet' }, emptyConfig);
    expect(req.model).toBe('opus');
  });

  test('user default_model can be an @alias (resolved through the profile)', () => {
    const profile = buildAiProfile('claude', {
      userAliases: { '@fast': { provider: 'codex', model: 'gpt-5.5', effort: 'low' } },
    });
    const req = resolveChatModelRequest(
      profile,
      'claude',
      { defaultProvider: 'claude', defaultModel: '@fast' },
      emptyConfig
    );
    expect(req.provider).toBe('codex');
    expect(req.model).toBe('gpt-5.5');
  });

  test('an unresolvable default_model ref degrades to the large tier (never breaks chat)', () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(
      profile,
      'claude',
      { defaultProvider: 'claude', defaultModel: '@deleted-alias' },
      emptyConfig
    );
    expect(req.provider).toBe('claude');
    expect(req.model).toBe('opus');
    expect(req.matchedTier).toBe('large');
  });

  test('install assistants.<p>.model outranks the BUILT-IN large tier default', () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(
      profile,
      'claude',
      {},
      {
        assistants: { claude: { model: 'sonnet' }, codex: {} },
        tiers: undefined,
      }
    );
    expect(req.provider).toBe('claude');
    expect(req.model).toBe('sonnet');
  });

  test('a CONFIGURED large tier beats install assistants.<p>.model', () => {
    const tiers = { large: { provider: 'claude', model: 'claude-opus-4-7' } };
    const profile = buildAiProfile('claude', { repoTiers: tiers });
    const req = resolveChatModelRequest(
      profile,
      'claude',
      {},
      {
        assistants: { claude: { model: 'sonnet' }, codex: {} },
        tiers,
      }
    );
    expect(req.model).toBe('claude-opus-4-7');
  });

  test('a per-user large tier beats install assistants.<p>.model', () => {
    const userTiers = { large: { provider: 'claude', model: 'haiku' } };
    const profile = buildAiProfile('claude', { userTiers });
    const req = resolveChatModelRequest(
      profile,
      'claude',
      { tiers: userTiers },
      {
        assistants: { claude: { model: 'sonnet' }, codex: {} },
        tiers: undefined,
      }
    );
    expect(req.model).toBe('haiku');
  });

  test("assistants.<p>.model of 'inherit' is skipped (means SDK default, not a model)", () => {
    const profile = buildAiProfile('claude');
    const req = resolveChatModelRequest(
      profile,
      'claude',
      {},
      {
        assistants: { claude: { model: 'inherit' }, codex: {} },
        tiers: undefined,
      }
    );
    expect(req.model).toBe('opus');
  });

  test('user default_model outranks a configured large tier (highest layer)', () => {
    const tiers = { large: { provider: 'claude', model: 'claude-opus-4-7' } };
    const profile = buildAiProfile('claude', { repoTiers: tiers });
    const req = resolveChatModelRequest(
      profile,
      'claude',
      { defaultProvider: 'claude', defaultModel: 'sonnet' },
      { assistants: { claude: {}, codex: {} }, tiers }
    );
    expect(req.model).toBe('sonnet');
  });
});

// ─── resolveTitleRequest (#1855): small-tier title generation ────────────────

describe('resolveTitleRequest', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve(
        makeConfig({
          assistants: { claude: {}, codex: { model: 'gpt-5.3-codex' } },
          envVars: {},
        })
      )
    );
    mockGetUserAiPrefsDb.mockReset();
    mockGetUserAiPrefsDb.mockImplementation(async () => ({}));
  });

  test('resolves the built-in codex small tier instead of the raw config-default model', async () => {
    const req = await resolveTitleRequest('codex');

    expect(req.provider).toBe('codex');
    // Built-in codex small tier — NOT the (ChatGPT-plan-unsupported) assistants default.
    expect(req.options.model).toBe(buildAiProfile('codex').aliases.small?.model);
    expect(req.options.assistantConfig).toEqual({ model: 'gpt-5.3-codex' });
    // Built-in tiers carry no effort — the provider's default reasoning applies.
    expect(req.options.nodeConfig).toBeUndefined();
  });

  // #2556: preset effort rides the one nodeConfig channel on every provider.
  // Built-in tiers no longer carry effort, so the pin uses a configured tier.
  test('a configured tier effort rides nodeConfig (#2556)', async () => {
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({
        assistants: { claude: {}, codex: { model: 'gpt-5.3-codex' } },
        tiers: { small: { provider: 'codex', model: 'test-small-model', effort: 'minimal' } },
        envVars: {},
      })
    );

    const req = await resolveTitleRequest('codex');

    expect(req.options.model).toBe('test-small-model');
    expect(req.options.nodeConfig).toEqual({ effort: 'minimal' });
  });

  // The chat half of the shared `resolvePresetEffort` gate (#2556). Chat and the
  // DAG executor must agree on when a preset's effort is dropped, or the same
  // tier means different depths in a workflow and in a chat turn — so the
  // rejection is pinned on both sides, not just the acceptance.
  test('drops a tier effort when the resolved provider has no reasoning control', async () => {
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({
        assistants: { claude: {}, codex: { model: 'gpt-5.3-codex' } },
        tiers: { small: { provider: 'codex', model: 'test-small-model', effort: 'minimal' } },
        envVars: {},
      })
    );
    const providers = await import('@archon/providers');
    const capsMock = providers.getProviderCapabilities as ReturnType<typeof mock>;
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, effortControl: false });

    try {
      const req = await resolveTitleRequest('codex');

      expect(req.options.model).toBe('test-small-model');
      // The tier still selects the model; only its effort is dropped, and it is
      // not quietly written onto the other channel either.
      expect(req.options.nodeConfig?.effort).toBeUndefined();
      expect(req.options.assistantConfig).toEqual({ model: 'gpt-5.3-codex' });
    } finally {
      capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
    }
  });

  test('a configured small tier wins (including a provider switch)', async () => {
    mockLoadConfig.mockResolvedValueOnce(
      makeConfig({
        assistants: { claude: {}, codex: { model: 'gpt-5.3-codex' } },
        tiers: { small: { provider: 'claude', model: 'haiku' } },
        envVars: {},
      })
    );

    const req = await resolveTitleRequest('codex');

    expect(req.provider).toBe('claude');
    expect(req.options.model).toBe('haiku');
    expect(req.options.assistantConfig).toEqual({});
  });

  test('per-user small tier participates when a userId is available', async () => {
    mockGetUserAiPrefsDb.mockResolvedValueOnce({
      tiers: { small: { provider: 'codex', model: 'gpt-5.4-mini' } },
    });

    const req = await resolveTitleRequest('codex', 'user-1');

    expect(mockGetUserAiPrefsDb).toHaveBeenCalledWith('user-1');
    expect(req.provider).toBe('codex');
    expect(req.options.model).toBe('gpt-5.4-mini');
  });

  test('per-user prefs are NOT consulted without a userId', async () => {
    await resolveTitleRequest('codex');
    expect(mockGetUserAiPrefsDb).not.toHaveBeenCalled();
  });

  test("a repo path loads that repo's tiers", async () => {
    mockLoadConfig.mockImplementationOnce((path?: string) =>
      Promise.resolve(
        makeConfig(
          path === '/repos/test-repo'
            ? {
                tiers: { small: { provider: 'claude', model: 'haiku' } },
                assistants: { claude: {}, codex: {} },
                envVars: {},
              }
            : {}
        )
      )
    );

    const req = await resolveTitleRequest('codex', undefined, '/repos/test-repo');

    expect(req.provider).toBe('claude');
    expect(req.options.model).toBe('haiku');
  });

  test('per-user default provider rebases the built-in tier defaults', async () => {
    mockGetUserAiPrefsDb.mockResolvedValueOnce({ defaultProvider: 'claude' });

    const req = await resolveTitleRequest('codex', 'user-1');

    expect(req.provider).toBe('claude');
    expect(req.options.model).toBe('haiku');
  });

  test('structurally invalid stored prefs degrade to config-only resolution', async () => {
    // Missing '@' prefix makes buildAiProfile throw for the user layer.
    mockGetUserAiPrefsDb.mockResolvedValueOnce({
      aliases: { fast: { provider: 'codex', model: 'gpt-5.5' } },
    });

    const req = await resolveTitleRequest('codex', 'user-1');

    expect(req.provider).toBe('codex');
    expect(req.options.model).toBe(buildAiProfile('codex').aliases.small?.model);
  });

  test('NEVER throws — config load failure falls back to the bare legacy request', async () => {
    mockLoadConfig.mockRejectedValueOnce(new Error('config exploded'));

    const req = await resolveTitleRequest('codex', 'user-1');

    expect(req).toEqual({ provider: 'codex', options: {} });
  });
});
