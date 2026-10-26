// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import type { CredentialStatus, ProviderDefaultsMap } from '@archon/provider-contract';
import type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  IAgentProvider,
} from '@archon/providers/types';
import type { StoredProviderCredential, WorkflowConfig } from './deps';
import type { WorkflowRun } from './schemas';
import { makeTestResolvedWorkflow, makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  type InconclusiveCredentialCheck,
  WorkflowCredentialPreflightError,
} from './run-preflight';

beforeAll(() => {
  registerBuiltinProviders();
  registerCommunityProviders();
});
const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {}, pi: { model: 'anthropic/sonnet' } },
  commands: {},
};
function fixture(status: CredentialStatus = { state: 'not_checked', source: 'native' }) {
  const checkCredential = mock<IAgentProvider['checkCredential']>(async () => status);
  const provider: IAgentProvider = {
    checkCredential,
    getType: () => 'claude',
    getCapabilities: () => ({
      backgroundWork: 'unobserved',
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      plugins: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: true,
      costControl: false,
      costReporting: false,
      effortControl: false,
      fallbackModel: false,
      sandbox: false,
      settingSources: false,
      nativeTools: false,
      containerExec: false,
      requiresAllPropertiesRequired: false,
    }),
    async *sendQuery() {},
  };
  const getUserProviderCredential = mock(
    async (_userId: string, _vendor: string): Promise<StoredProviderCredential | undefined> =>
      undefined
  );
  return {
    checkCredential,
    provider,
    deps: {
      providers: providerRegistry,
      loadConfig: mock(async () => structuredClone(config)),
      store: { getCodebaseEnvVars: mock(async () => ({ DB_SETTING: 'db' })) },
      getAgentProvider: mock(() => provider),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential,
    },
  };
}

describe('run credential preflight', () => {
  test('enumerates actual aliases, loop scopes and conditional nodes, excluding coordination nodes', async () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'graph',
      nodes: [
        { id: 'shell', bash: 'true' },
        { id: 'a', prompt: 'a', model: '@other' },
        { id: 'b', prompt: 'b', model: '@other', when: '$a.output == false' },
        {
          id: 'group',
          provider: 'pi',
          model: 'openai/gpt',
          loop_group: {
            max_iterations: 2,
            until: 'done',
            nodes: [
              { id: 'inner', prompt: 'c' },
              {
                id: 'nested',
                provider: 'claude',
                loop_group: {
                  max_iterations: 2,
                  until: 'done',
                  nodes: [{ id: 'leaf', prompt: 'd' }],
                },
              },
            ],
          },
        },
        { id: 'child', workflow: 'child' },
      ],
    });
    const { deps } = fixture();
    deps.loadConfig.mockResolvedValue({
      ...config,
      aliases: { '@other': { provider: 'codex', model: 'gpt' } },
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/project');
    expect(prepared.requirements).toEqual([
      { provider: 'codex', model: 'gpt', vendor: 'openai' },
      { provider: 'pi', model: 'openai/gpt', vendor: 'openai' },
      { provider: 'claude', model: undefined, vendor: 'anthropic' },
    ]);
  });

  test('composition preserves the included provider and deterministic graphs make no checks', async () => {
    const composed = makeTestComposedWorkflow(
      [
        makeTestWorkflow({
          name: 'child',
          provider: 'codex',
          nodes: [{ id: 'ai', prompt: 'run' }],
        }),
        makeTestWorkflow({ name: 'parent', nodes: [{ id: 'include', include: 'child' }] }),
      ],
      'parent'
    );
    const { deps, checkCredential } = fixture();
    expect((await prepareRunAiConfiguration(deps, composed, '/p')).requirements[0]?.provider).toBe(
      'codex'
    );
    const workflow = makeTestResolvedWorkflow({
      name: 'shell',
      nodes: [{ id: 'sh', bash: 'true' }],
    });
    await assertRunCredentials(deps, await prepareRunAiConfiguration(deps, workflow, '/p'), {
      cwd: '/p',
    });
    expect(checkCredential).not.toHaveBeenCalled();
    expect(deps.getUserProviderCredential).not.toHaveBeenCalled();
  });

  test.each([
    { state: 'unusable', source: 'archon', evidence: 'cannot read' },
    { state: 'not_checked', source: 'archon' },
  ] satisfies CredentialStatus[])(
    'stored $state blocks without native fallback and names the provider',
    async status => {
      const workflow = makeTestResolvedWorkflow({ name: 'ai' });
      const { deps, checkCredential } = fixture();
      deps.getUserProviderCredential.mockResolvedValue({
        kind: 'api_key',
        getStatus: async () => status,
      });
      const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
      await expect(assertRunCredentials(deps, prepared, { cwd: '/p' })).rejects.toThrow(
        "provider 'claude' (vendor 'anthropic')"
      );
      expect(checkCredential).not.toHaveBeenCalled();
      expect(deps.getUserProviderCredential).toHaveBeenCalledWith('origin', 'anthropic');
    }
  );

  test('a stored check that cannot decide passes as connected, without native fallback', async () => {
    const workflow = makeTestResolvedWorkflow({ name: 'ai' });
    const { deps, checkCredential } = fixture();
    deps.getUserProviderCredential.mockResolvedValue({
      kind: 'oauth',
      getStatus: async () => ({
        state: 'check_failed',
        source: 'archon',
        evidence: 'refresh unavailable',
      }),
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
    expect(await assertRunCredentials(deps, prepared, { cwd: '/p' })).toEqual([
      {
        provider: 'claude',
        vendor: 'anthropic',
        source: 'archon',
        evidence: 'refresh unavailable',
      },
    ]);
    expect(checkCredential).not.toHaveBeenCalled();
    expect(prepared.connectedVendors.has('anthropic')).toBe(true);
  });

  test('a shared stored vendor is checked once and unused vendors are never read', async () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'ai',
      nodes: [
        { id: 'a', prompt: 'a', provider: 'claude' },
        { id: 'b', prompt: 'b', provider: 'pi' },
      ],
    });
    const { deps, checkCredential } = fixture();
    const getStatus = mock(
      async (): Promise<CredentialStatus> => ({ state: 'usable', source: 'archon' })
    );
    deps.getUserProviderCredential.mockImplementation(async () => ({ kind: 'api_key', getStatus }));
    await assertRunCredentials(
      deps,
      await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' }),
      { cwd: '/p' }
    );
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(deps.getUserProviderCredential).toHaveBeenCalledTimes(1);
    expect(checkCredential).not.toHaveBeenCalled();
  });

  test.each([
    [{ state: 'usable', source: 'native' }, []],
    [{ state: 'not_checked', source: 'native' }, []],
    [
      { state: 'check_failed', source: 'native', evidence: 'unreachable' },
      [{ provider: 'claude', vendor: 'anthropic', source: 'native', evidence: 'unreachable' }],
    ],
  ] satisfies [CredentialStatus, InconclusiveCredentialCheck[]][])(
    'native %# starts the run, returning any inconclusive check',
    async (status, inconclusive) => {
      const workflow = makeTestResolvedWorkflow({ name: 'ai' });
      const { deps, checkCredential } = fixture(status);
      const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
      expect(await assertRunCredentials(deps, prepared, { cwd: '/p' })).toEqual(inconclusive);
      expect(checkCredential).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    [{ state: 'not_connected', source: 'native' }, 'no usable login'],
    [
      { state: 'unusable', source: 'native', evidence: 'rejected' },
      'credential cannot be used: rejected',
    ],
  ] satisfies [CredentialStatus, string][])(
    'a definite bad native credential refuses the run: %#',
    async (status, reason) => {
      const workflow = makeTestResolvedWorkflow({ name: 'ai' });
      const { deps } = fixture(status);
      const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
      const check = assertRunCredentials(deps, prepared, { cwd: '/p' });
      await expect(check).rejects.toBeInstanceOf(WorkflowCredentialPreflightError);
      await expect(check).rejects.toThrow(
        `Credential preflight failed for provider 'claude' (vendor 'anthropic'): ${reason}`
      );
    }
  );

  test('a native probe that throws is inconclusive and keeps its error out of the evidence', async () => {
    const workflow = makeTestResolvedWorkflow({ name: 'ai' });
    const { deps, checkCredential } = fixture();
    checkCredential.mockRejectedValue(new Error('probe unavailable'));
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p');
    expect(await assertRunCredentials(deps, prepared, { cwd: '/p' })).toEqual([
      {
        provider: 'claude',
        vendor: 'anthropic',
        source: 'native',
        evidence: 'the native authentication check failed unexpectedly',
      },
    ]);
    expect(checkCredential).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['throws on abort', (signal: AbortSignal) => Promise.reject(signal.reason)],
    [
      'reports its abort as a failed check',
      (): Promise<CredentialStatus> =>
        Promise.resolve({ state: 'check_failed', source: 'native', evidence: 'aborted' }),
    ],
  ] as const)(
    'a timed-out native probe that %s starts with a timeout warning',
    async (_, probe) => {
      const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() =>
        AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
      );
      try {
        const workflow = makeTestResolvedWorkflow({ name: 'ai' });
        const { deps, checkCredential } = fixture();
        checkCredential.mockImplementation(({ signal }) => probe(signal));
        const prepared = await prepareRunAiConfiguration(deps, workflow, '/p');
        const [check, ...rest] = await assertRunCredentials(deps, prepared, { cwd: '/p' });
        expect(rest).toEqual([]);
        expect(check?.evidence).toStartWith('native authentication check timed out after 60s');
        expect(timeout).toHaveBeenCalledWith(60_000);
      } finally {
        timeout.mockRestore();
      }
    }
  );

  test('a stored connection removed after launch cannot switch to native authentication', async () => {
    const workflow = makeTestResolvedWorkflow({ name: 'ai' });
    const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
    deps.getUserProviderCredential.mockResolvedValueOnce({
      kind: 'api_key',
      getStatus: async () => ({ state: 'usable', source: 'archon' }),
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
    await assertRunCredentials(deps, prepared, { cwd: '/p' });
    await expect(assertRunCredentials(deps, prepared, { cwd: '/p' })).rejects.toThrow(
      "provider 'claude' (vendor 'anthropic'): no usable login"
    );
    expect(checkCredential).not.toHaveBeenCalled();
  });

  test.each(['pi', 'claude'])(
    'only a consumer resolves stored credential health: %s',
    async provider => {
      const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
      const getStatus = mock(async (): Promise<CredentialStatus> => {
        throw new Error('vault key unavailable');
      });
      deps.getUserProviderCredential.mockResolvedValue({ kind: 'oauth', getStatus });
      const prepared = await prepareRunAiConfiguration(
        deps,
        makeTestResolvedWorkflow({ name: 'credential-health', provider }),
        '/p',
        { userId: 'origin' }
      );
      const check = assertRunCredentials(deps, prepared, { cwd: '/p' });
      if (provider === 'pi') {
        await check;
        expect(getStatus).not.toHaveBeenCalled();
        expect(checkCredential).toHaveBeenCalledTimes(1);
        expect(prepared.connectedVendors.size).toBe(0);
      } else {
        await expect(check).rejects.toThrow('could not verify the stored credential');
        expect(getStatus).toHaveBeenCalledTimes(1);
        expect(checkCredential).not.toHaveBeenCalled();
      }
    }
  );

  test('a Pi node cannot use a stored Claude subscription and fails preflight naming provider: claude', async () => {
    const workflow = makeTestResolvedWorkflow({ name: 'pi', provider: 'pi' });
    const { deps, checkCredential } = fixture({ state: 'not_connected', source: 'native' });
    deps.getUserProviderCredential.mockResolvedValue({
      kind: 'oauth',
      getStatus: async () => ({ state: 'usable', source: 'archon' }),
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
    await expect(assertRunCredentials(deps, prepared, { cwd: '/p' })).rejects.toThrow(
      "provider 'pi' (vendor 'anthropic'): the anthropic subscription connected in Archon runs on `provider: claude`, not on pi. Use `provider: claude`, or give pi its own anthropic API key."
    );
    expect(checkCredential).toHaveBeenCalledTimes(1);
    expect(prepared.connectedVendors.has('anthropic')).toBe(false);
  });

  test('a Pi node with its own native Anthropic login runs beside a stored Claude subscription', async () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'mixed',
      nodes: [
        { id: 'a', prompt: 'a', provider: 'claude' },
        { id: 'b', prompt: 'b', provider: 'pi' },
      ],
    });
    const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
    deps.getUserProviderCredential.mockResolvedValue({
      kind: 'oauth',
      getStatus: async () => ({ state: 'usable', source: 'archon' }),
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
    await assertRunCredentials(deps, prepared, { cwd: '/p' });
    // The Claude node consumes the stored subscription; only the Pi node checks natively.
    expect(prepared.connectedVendors.has('anthropic')).toBe(true);
    expect(checkCredential.mock.calls.map(([r]) => r.model)).toEqual(['anthropic/sonnet']);
    expect(deps.getUserProviderCredential).toHaveBeenCalledTimes(1);
  });

  test('native checks receive each model, assistant settings and effective env', async () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'ai',
      nodes: [
        { id: 'a', prompt: 'a', model: 'one' },
        { id: 'b', prompt: 'b', model: 'two' },
      ],
    });
    const { deps, checkCredential } = fixture();
    deps.loadConfig.mockResolvedValue({ ...config, envVars: { SETTING: 'file' } });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { codebaseId: 'cb' });
    await assertRunCredentials(deps, prepared, { cwd: '/p' });
    expect(checkCredential.mock.calls.map(([r]) => r.model)).toEqual(['one', 'two']);
    expect(checkCredential.mock.calls[0]?.[0]).toMatchObject({
      assistantConfig: {},
      env: { SETTING: 'file', DB_SETTING: 'db' },
    });
  });

  test('provider native default is frozen before stored vendor selection', async () => {
    const workflow = makeTestResolvedWorkflow({ name: 'pi', provider: 'pi' });
    const { deps, provider, checkCredential } = fixture();
    deps.loadConfig.mockResolvedValue({ ...config, assistants: { claude: {}, codex: {}, pi: {} } });
    provider.resolveCredentialModel = mock(async () => 'openai/native-model');
    deps.getUserProviderCredential.mockResolvedValue({
      kind: 'api_key',
      getStatus: async () => ({ state: 'unusable', source: 'archon', evidence: 'dead' }),
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/project', {
      userId: 'origin',
    });
    expect(prepared.config.assistants.pi?.model).toBe('openai/native-model');
    await expect(assertRunCredentials(deps, prepared, { cwd: '/project' })).rejects.toThrow(
      "vendor 'openai'"
    );
    expect(provider.resolveCredentialModel).toHaveBeenCalledWith({
      cwd: '/project',
      assistantConfig: {},
    });
    expect(checkCredential).not.toHaveBeenCalled();
  });
});

function savedRun(metadata: Record<string, unknown>): WorkflowRun {
  return {
    id: 'run',
    workflow_name: 'ai',
    origin: { conversationId: 'conversation' },
    conversation_id: 'conversation',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'paused',
    outcome: null,
    user_message: '',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/p',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
  };
}

/** Loaded config carries provider-native settings beyond WorkflowConfig's narrow view. */
function loadedAssistants(
  assistants: { claude: ClaudeProviderDefaults; codex: CodexProviderDefaults } & ProviderDefaultsMap
): WorkflowConfig['assistants'] {
  return assistants;
}

test('continuation retains launch AI values while native settings and environment stay live', async () => {
  const { deps } = fixture();
  const workflow = makeTestResolvedWorkflow({
    name: 'ai',
    nodes: [{ id: 'ai', prompt: 'go', model: '@custom' }],
  });
  deps.loadConfig.mockResolvedValue({
    ...config,
    assistants: loadedAssistants({
      claude: { model: 'sonnet', settingSources: ['user'], claudeBinaryPath: '/launch/claude' },
      codex: {
        model: 'gpt-launch',
        modelReasoningEffort: 'high',
        webSearchMode: 'disabled',
        additionalDirectories: ['/launch/context'],
        codexBinaryPath: '/launch/codex',
      },
      copilot: {
        model: 'gpt-launch',
        modelReasoningEffort: 'high',
        copilotCliPath: '/launch/copilot',
        configDir: '/launch/home',
        enableConfigDiscovery: false,
        useLoggedInUser: false,
        logLevel: 'error',
      },
      pi: { model: 'openai/native', env: { TOKEN: 'launch-secret' } },
    }),
    tiers: { small: { provider: 'claude', model: 'haiku' } },
    aliases: { '@custom': { provider: 'claude', model: 'sonnet' } },
    envVars: { TOKEN: 'launch-secret' },
  });
  const launch = await prepareRunAiConfiguration(deps, workflow, '/p');
  // The persisted record is a JSON round-trip, as it is in both database adapters.
  const metadata = JSON.parse(JSON.stringify({ ai_configuration: launch.aiConfigurationSnapshot }));
  deps.loadConfig.mockResolvedValue({
    ...config,
    assistant: 'codex',
    assistants: loadedAssistants({
      claude: { model: 'opus', settingSources: ['project'], claudeBinaryPath: '/live/claude' },
      codex: {
        model: 'gpt-live',
        modelReasoningEffort: 'low',
        webSearchMode: 'live',
        additionalDirectories: ['/live/context'],
        codexBinaryPath: '/live/codex',
      },
      copilot: {
        model: 'gpt-live',
        modelReasoningEffort: 'low',
        copilotCliPath: '/live/copilot',
        configDir: '/live/home',
        enableConfigDiscovery: true,
        useLoggedInUser: true,
        logLevel: 'debug',
      },
      pi: { env: { TOKEN: 'live-secret' } },
    }),
    aliases: { '@custom': { provider: 'codex', model: 'gpt' } },
    envVars: { TOKEN: 'live-secret' },
  });
  const resumed = await prepareRunAiConfiguration(deps, workflow, '/changed', {
    continuationRun: savedRun(metadata),
  });
  expect(resumed.aiProfile).toEqual(launch.aiProfile);
  expect(resumed.scope).toEqual(launch.scope);
  expect(resumed.config.assistant).toBe('claude');
  // Widen to the providers' own shapes: native settings ride beyond WorkflowConfig's view.
  const claude: ClaudeProviderDefaults = resumed.config.assistants.claude;
  const codex: CodexProviderDefaults = resumed.config.assistants.codex;
  expect(claude).toEqual({
    model: 'sonnet',
    settingSources: ['project'],
    claudeBinaryPath: '/live/claude',
  });
  expect(codex).toEqual({
    model: 'gpt-launch',
    modelReasoningEffort: 'high',
    webSearchMode: 'live',
    additionalDirectories: ['/live/context'],
    codexBinaryPath: '/live/codex',
  });
  expect(resumed.config.assistants.copilot).toEqual({
    model: 'gpt-launch',
    modelReasoningEffort: 'high',
    copilotCliPath: '/live/copilot',
    configDir: '/live/home',
    enableConfigDiscovery: true,
    useLoggedInUser: true,
    logLevel: 'debug',
  });
  expect(launch.aiConfigurationSnapshot.assistants.claude).toEqual({ model: 'sonnet' });
  expect(launch.aiConfigurationSnapshot.assistants.codex).toEqual({
    model: 'gpt-launch',
    modelReasoningEffort: 'high',
  });
  expect(launch.aiConfigurationSnapshot.assistants.copilot).toEqual({
    model: 'gpt-launch',
    modelReasoningEffort: 'high',
  });
  expect(resumed.config.assistants.pi?.model).toBe('openai/native');
  expect(resumed.config.assistants.pi?.env).toEqual({ TOKEN: 'live-secret' });
  expect(resumed.config.envVars?.TOKEN).toBe('live-secret');
  expect(JSON.stringify(metadata)).not.toContain('launch-secret');
});

test('legacy continuation reloads configuration and retains only explicit model overrides', async () => {
  const { deps } = fixture();
  const workflow = makeTestResolvedWorkflow({ name: 'ai', model: 'large' });
  const launch = await prepareRunAiConfiguration(deps, workflow, '/p', {
    modelOverrideLayer: { kind: 'raw', overrides: { tiers: { large: 'claude/opus' } } },
  });
  deps.loadConfig.mockResolvedValue({
    ...config,
    assistant: 'codex',
    aliases: { '@new': { provider: 'codex', model: 'gpt' } },
  });
  const resumed = await prepareRunAiConfiguration(deps, workflow, '/p', {
    continuationRun: savedRun({ model_bindings: launch.modelBindingsMetadata }),
  });
  expect(resumed.baseAiProfile.defaultProvider).toBe('codex');
  expect(resumed.aiProfile.aliases.large).toEqual(launch.aiProfile.aliases.large);
  expect(resumed.aiProfile.aliases['@new']?.model).toBe('gpt');
});

test('restoration skips user preferences and native model rediscovery', async () => {
  const { deps, provider } = fixture();
  const workflow = makeTestResolvedWorkflow({ name: 'ai', provider: 'pi' });
  deps.loadConfig.mockResolvedValue({ ...config, assistants: { claude: {}, codex: {}, pi: {} } });
  provider.resolveCredentialModel = mock(async () => 'openai/native-model');
  const getUserAiPrefs = mock(async () => ({ defaultProvider: 'claude' }));
  const launch = await prepareRunAiConfiguration({ ...deps, getUserAiPrefs }, workflow, '/p', {
    userId: 'launcher',
  });
  getUserAiPrefs.mockRejectedValue(new Error('preferences must not be read'));
  const resumed = await prepareRunAiConfiguration({ ...deps, getUserAiPrefs }, workflow, '/p', {
    continuationRun: {
      ...savedRun({ ai_configuration: launch.aiConfigurationSnapshot }),
      user_id: 'launcher',
    },
  });
  expect(resumed.config.assistants.pi?.model).toBe('openai/native-model');
  expect(getUserAiPrefs).toHaveBeenCalledTimes(1);
  expect(provider.resolveCredentialModel).toHaveBeenCalledTimes(1);
});

test('AI-only inheritance uses the new actor and refuses conflicting adoption inputs', async () => {
  const { deps } = fixture();
  const workflow = makeTestResolvedWorkflow({ name: 'ai' });
  const launch = await prepareRunAiConfiguration(deps, workflow, '/p');
  const ancestor = {
    ...savedRun({ ai_configuration: launch.aiConfigurationSnapshot }),
    user_id: 'ancestor',
  };
  const adopted = await prepareRunAiConfiguration(deps, workflow, '/p', {
    aiConfigurationRun: ancestor,
    userId: 'new-actor',
  });
  expect(adopted.executionUserId).toBe('new-actor');
  expect(adopted.aiConfigurationSnapshot).toEqual(launch.aiConfigurationSnapshot);
  await expect(
    prepareRunAiConfiguration(deps, workflow, '/p', {
      aiConfigurationRun: ancestor,
      modelOverrideLayer: { kind: 'raw', overrides: {} },
    })
  ).rejects.toThrow('Cannot override AI configuration');
});

test('preflight protects only effective database values after run overrides', async () => {
  const { deps } = fixture();
  const workflow = makeTestResolvedWorkflow({
    name: 'setup',
    nodes: [{ id: 'shell', bash: 'true' }],
  });
  const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { codebaseId: 'cb' });
  expect(prepared.config.protectedCredentialValues).toEqual(['db']);
  const overridden = await prepareRunAiConfiguration(
    {
      ...deps,
      sealRunConfig: () => ({
        version: 1,
        source: { kind: 'cli', label: 'test' },
        ciphertext: 'test',
        keys: ['envVars'],
      }),
    },
    workflow,
    '/p',
    {
      codebaseId: 'cb',
      runConfig: {
        layer: { envVars: { DB_SETTING: 'override' } },
        source: { kind: 'cli', label: 'test' },
      },
    }
  );
  expect(overridden.config.protectedCredentialValues).not.toContain('db');
});

test.each(['claude', 'codex', 'pi'])(
  'files check native %s authentication with a CLI user and never read stored credentials',
  async provider => {
    const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
    deps.loadConfig.mockResolvedValue({
      ...config,
      envVars: { NATIVE_AUTH: 'environment-credential' },
    });
    deps.getUserProviderCredential.mockRejectedValue(new Error('SQL must not be read'));
    const files = { ...deps, credentialStore: 'files' as const };
    const ai = makeTestResolvedWorkflow({ name: 'ai', provider });
    const prepared = await prepareRunAiConfiguration(files, ai, '/p', { userId: 'origin' });
    await assertRunCredentials(files, prepared, { cwd: '/p' });
    expect(prepared.executionUserId).toBe('origin');
    expect(checkCredential).toHaveBeenCalledTimes(1);
    expect(checkCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantConfig: prepared.config.assistants[provider],
        env: expect.objectContaining({ NATIVE_AUTH: 'environment-credential' }),
      })
    );
    expect(deps.getUserProviderCredential).not.toHaveBeenCalled();
    expect([...prepared.connectedVendors]).toEqual([]);
    const shell = makeTestResolvedWorkflow({
      name: 'shell',
      nodes: [{ id: 'shell', bash: 'true' }],
    });
    await assertRunCredentials(
      files,
      await prepareRunAiConfiguration(files, shell, '/p', { userId: 'origin' }),
      { cwd: '/p' }
    );
    expect(checkCredential).toHaveBeenCalledTimes(1);
    expect(deps.getUserProviderCredential).not.toHaveBeenCalled();
  }
);

test('files report a missing native login at preflight with a CLI user', async () => {
  const { deps, checkCredential } = fixture({ state: 'not_connected', source: 'native' });
  const files = { ...deps, credentialStore: 'files' as const };
  const ai = makeTestResolvedWorkflow({ name: 'ai', provider: 'claude' });
  const prepared = await prepareRunAiConfiguration(files, ai, '/p', { userId: 'origin' });
  await expect(assertRunCredentials(files, prepared, { cwd: '/p' })).rejects.toThrow(
    "Credential preflight failed for provider 'claude' (vendor 'anthropic'): no usable login"
  );
  expect(checkCredential).toHaveBeenCalledTimes(1);
  expect(deps.getUserProviderCredential).not.toHaveBeenCalled();
});

test('a run needing an unset default fails in preflight before provider execution', async () => {
  const { deps } = fixture();
  deps.loadConfig.mockResolvedValue({ ...config, assistant: undefined });
  const workflow = makeTestResolvedWorkflow({
    name: 'default-needed',
    nodes: [{ id: 'ai', prompt: 'never spend' }],
  });
  await expect(prepareRunAiConfiguration(deps, workflow, '/project')).rejects.toThrow(
    "No default provider: set 'defaultAssistant' in ~/.archon/config.yaml or run archon setup"
  );
  expect(deps.getAgentProvider).not.toHaveBeenCalled();
  await expect(
    prepareRunAiConfiguration(
      { ...deps, providers: { get: () => undefined, list: () => [] } },
      workflow,
      '/project'
    )
  ).rejects.toThrow('No providers installed. Run: archon provider add <claude|codex|pi>');
  const deprecatedOnly = providerRegistry.list().filter(provider => provider.deprecationNotice);
  expect(deprecatedOnly.map(provider => provider.id).sort()).toEqual(['copilot', 'opencode']);
  await expect(
    prepareRunAiConfiguration(
      { ...deps, providers: { get: () => undefined, list: () => deprecatedOnly } },
      workflow,
      '/project'
    )
  ).rejects.toThrow('No providers installed. Run: archon provider add <claude|codex|pi>');
});

test('an unset default permits deterministic nodes and explicitly selected AI nodes', async () => {
  const { deps } = fixture();
  deps.loadConfig.mockResolvedValue({ ...config, assistant: undefined });
  const workflow = makeTestResolvedWorkflow({
    name: 'explicit-only',
    nodes: [
      {
        id: 'group',
        loop_group: {
          max_iterations: 1,
          until: 'done',
          nodes: [
            { id: 'shell', bash: 'true' },
            { id: 'ai', provider: 'codex', prompt: 'explicit' },
          ],
        },
      },
    ],
  });
  const prepared = await prepareRunAiConfiguration(deps, workflow, '/project');
  expect(prepared.requirements.map(requirement => requirement.provider)).toEqual(['codex']);
  expect(prepared.config.assistant).toBeUndefined();
  expect(prepared.aiConfigurationSnapshot.assistant).toBeUndefined();
});

test('gate rework also requires its provider during preflight', async () => {
  const { deps } = fixture();
  deps.loadConfig.mockResolvedValue({ ...config, assistant: undefined });
  const workflow = makeTestResolvedWorkflow({
    name: 'gate-rework',
    nodes: [
      {
        id: 'gate',
        approval: { message: 'Review', on_reject: { prompt: 'revise', max_attempts: 1 } },
      },
    ],
  });
  await expect(prepareRunAiConfiguration(deps, workflow, '/project')).rejects.toThrow(
    'No default provider'
  );
  expect(deps.getAgentProvider).not.toHaveBeenCalled();
});

test('an implicit built-in tier cannot choose a provider when the default is unset', async () => {
  const { deps } = fixture();
  deps.loadConfig.mockResolvedValue({ ...config, assistant: undefined });
  const workflow = makeTestResolvedWorkflow({
    name: 'tier-default',
    nodes: [{ id: 'ai', prompt: 'never spend', model: 'large' }],
  });
  await expect(prepareRunAiConfiguration(deps, workflow, '/project')).rejects.toThrow(
    'No default provider'
  );
  await expect(
    prepareRunAiConfiguration(
      { ...deps, providers: { get: () => undefined, list: () => [] } },
      workflow,
      '/project'
    )
  ).rejects.toThrow('No providers installed');
});

test('credential preflight retains each node setting scope and target cwd', async () => {
  const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
  const workflow = makeTestResolvedWorkflow({
    name: 'scopes',
    nodes: [
      { id: 'default', prompt: 'a' },
      { id: 'disabled', prompt: 'b', settingSources: [] },
      { id: 'project', prompt: 'c', settingSources: ['project'] },
      { id: 'same', prompt: 'd', settingSources: ['project'] },
    ],
  });
  const prepared = await prepareRunAiConfiguration(deps, workflow, '/target-project');
  await assertRunCredentials({ ...deps, credentialStore: 'files' }, prepared, {
    cwd: '/target-project',
  });
  expect(
    checkCredential.mock.calls.map(([request]) => ({
      cwd: request.cwd,
      settingSources: request.settingSources,
    }))
  ).toEqual([
    { cwd: '/target-project', settingSources: undefined },
    { cwd: '/target-project', settingSources: [] },
    { cwd: '/target-project', settingSources: ['project'] },
  ]);
});

test('a usable same-model node cannot hide another node with no native credential in its scope', async () => {
  const { deps, checkCredential } = fixture();
  checkCredential.mockImplementation(async request => ({
    state: request.settingSources?.includes('project') ? 'usable' : 'not_connected',
    source: 'native',
  }));
  const workflow = makeTestResolvedWorkflow({
    name: 'scopes',
    nodes: [
      { id: 'disabled', prompt: 'b', settingSources: [] },
      { id: 'project', prompt: 'a', settingSources: ['project'] },
    ],
  });
  const prepared = await prepareRunAiConfiguration(deps, workflow, '/target-project');
  await expect(
    assertRunCredentials({ ...deps, credentialStore: 'files' }, prepared, {
      cwd: '/target-project',
    })
  ).rejects.toThrow('no usable login');
  expect(checkCredential).toHaveBeenCalledTimes(1);
});

for (const execContext of [
  { kind: 'host' },
  { kind: 'container', containerId: 'runner' },
] as const) {
  test(`native preflight uses resolved execution context: ${execContext.kind}`, async () => {
    const { deps, checkCredential } = fixture({ state: 'usable', source: 'native' });
    const workflow = makeTestResolvedWorkflow({
      name: 'isolated',
      nodes: [{ id: 'ai', prompt: 'hello' }],
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/launch');
    await assertRunCredentials({ ...deps, credentialStore: 'files' }, prepared, {
      cwd: '/execution',
      execContext,
    });
    expect(checkCredential.mock.calls[0]?.[0]).toMatchObject({ cwd: '/execution', execContext });
    if (execContext.kind === 'container')
      expect(checkCredential.mock.calls[0]?.[0].env.PATH).toBeUndefined();
  });
}

test('before its container exists, preflight refuses a stored credential but defers native authentication', async () => {
  const { deps, checkCredential } = fixture({ state: 'not_connected', source: 'native' });
  const workflow = makeTestResolvedWorkflow({ name: 'pending', provider: 'claude' });
  const prepared = await prepareRunAiConfiguration(deps, workflow, '/launch', { userId: 'origin' });
  await assertRunCredentials(deps, prepared, 'pending-container');
  await assertRunCredentials({ ...deps, credentialStore: 'files' }, prepared, 'pending-container');
  deps.getUserProviderCredential.mockResolvedValue({
    kind: 'api_key',
    getStatus: async () => ({ state: 'unusable', source: 'archon', evidence: 'revoked' }),
  });
  await expect(assertRunCredentials(deps, prepared, 'pending-container')).rejects.toThrow(
    'credential cannot be used: revoked'
  );
  expect(checkCredential).not.toHaveBeenCalled();
});
