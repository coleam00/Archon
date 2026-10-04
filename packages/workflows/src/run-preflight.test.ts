import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import type { CredentialStatus } from '@archon/provider-contract';
import type { IAgentProvider } from '@archon/providers/types';
import type { WorkflowConfig } from './deps';
import { makeTestResolvedWorkflow, makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import {
  prepareRunAiConfiguration,
  collectRunCredentialRequirements,
  assertRunCredentials,
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
  const getUserProviderCredentialStatus = mock(
    async (_userId: string, _vendor: string): Promise<CredentialStatus> => ({
      state: 'not_connected',
      source: 'archon',
    })
  );
  return {
    checkCredential,
    provider,
    deps: {
      loadConfig: mock(async () => config),
      store: { getCodebaseEnvVars: mock(async () => ({ DB_SETTING: 'db' })) },
      getAgentProvider: mock(() => provider),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredentialStatus,
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
    expect(collectRunCredentialRequirements(workflow, prepared)).toEqual([
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
    expect(
      collectRunCredentialRequirements(
        composed,
        await prepareRunAiConfiguration(deps, composed, '/p')
      )[0]?.provider
    ).toBe('codex');
    const workflow = makeTestResolvedWorkflow({
      name: 'shell',
      nodes: [{ id: 'sh', bash: 'true' }],
    });
    await assertRunCredentials(
      deps,
      workflow,
      await prepareRunAiConfiguration(deps, workflow, '/p')
    );
    expect(checkCredential).not.toHaveBeenCalled();
    expect(deps.getUserProviderCredentialStatus).not.toHaveBeenCalled();
  });

  test.each([
    { state: 'unusable', source: 'archon', evidence: 'cannot read' },
    { state: 'check_failed', source: 'archon', evidence: 'refresh unavailable' },
    { state: 'not_checked', source: 'archon' },
  ] satisfies CredentialStatus[])(
    'stored $state blocks without native fallback and names the provider',
    async status => {
      const workflow = makeTestResolvedWorkflow({ name: 'ai' });
      const { deps, checkCredential } = fixture();
      deps.getUserProviderCredentialStatus.mockResolvedValue(status);
      const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
      await expect(assertRunCredentials(deps, workflow, prepared)).rejects.toThrow(
        "provider 'claude' (vendor 'anthropic')"
      );
      expect(checkCredential).not.toHaveBeenCalled();
      expect(deps.getUserProviderCredentialStatus).toHaveBeenCalledWith('origin', 'anthropic');
    }
  );

  test('a shared stored vendor is checked once and unused vendors are never read', async () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'ai',
      nodes: [
        { id: 'a', prompt: 'a', provider: 'claude' },
        { id: 'b', prompt: 'b', provider: 'pi' },
      ],
    });
    const { deps, checkCredential } = fixture();
    deps.getUserProviderCredentialStatus.mockImplementation(async (_user, vendor) =>
      vendor === 'anthropic'
        ? { state: 'usable', source: 'archon' }
        : { state: 'unusable', source: 'archon', evidence: 'dead' }
    );
    await assertRunCredentials(
      deps,
      workflow,
      await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' })
    );
    expect(deps.getUserProviderCredentialStatus).toHaveBeenCalledTimes(1);
    expect(checkCredential).not.toHaveBeenCalled();
  });

  test.each([
    [{ state: 'usable', source: 'native' }, true],
    [{ state: 'not_checked', source: 'native' }, true],
    [{ state: 'not_connected', source: 'native' }, false],
    [{ state: 'unusable', source: 'native', evidence: 'rejected' }, false],
    [{ state: 'check_failed', source: 'native', evidence: 'unreachable' }, false],
  ] satisfies [CredentialStatus, boolean][])('native policy %#', async (status, allowed) => {
    const workflow = makeTestResolvedWorkflow({ name: 'ai' });
    const { deps, checkCredential } = fixture(status);
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/p', { userId: 'origin' });
    const check = assertRunCredentials(deps, workflow, prepared);
    if (allowed) await check;
    else
      await expect(check).rejects.toThrow(
        status.state === 'check_failed'
          ? 'could not verify: unreachable'
          : 'Credential preflight failed'
      );
    expect(checkCredential).toHaveBeenCalledTimes(1);
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
    await assertRunCredentials(deps, workflow, prepared);
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
    deps.getUserProviderCredentialStatus.mockResolvedValue({
      state: 'unusable',
      source: 'archon',
      evidence: 'dead',
    });
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/project', {
      userId: 'origin',
    });
    expect(prepared.config.assistants.pi?.model).toBe('openai/native-model');
    await expect(assertRunCredentials(deps, workflow, prepared)).rejects.toThrow("vendor 'openai'");
    expect(provider.resolveCredentialModel).toHaveBeenCalledWith({
      cwd: '/project',
      assistantConfig: {},
    });
    expect(checkCredential).not.toHaveBeenCalled();
  });
});
