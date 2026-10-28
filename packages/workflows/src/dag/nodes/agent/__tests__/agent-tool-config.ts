import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  deliveredMessages,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import { dagNodeSchema } from '../../../../schemas';
import { buildAiProfile } from '../../../../model-validation';

export function setupToolRestrictionsTests() {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    // Restore default claude client
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });
  return {
    get testDir() {
      return testDir;
    },
  };
}

export function registerToolConfigurationTests(
  fixture: ReturnType<typeof setupToolRestrictionsTests>
) {
  it('passes allowed_tools to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'dag-tool-restriction',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              allowed_tools: ['Read', 'Grep'],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('passes settingSources to sendQuery nodeConfig for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'dag-setting-sources',
          nodes: [
            {
              id: 'lean-review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              settingSources: ['project'],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.settingSources).toEqual(['project']);
    // Claude supports settingSources — no ignored-capability warning
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warnings = sendMessage.mock.calls
      .map(call => call[1] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('settingSources'));
    expect(warnings).toEqual([]);
  });

  it('warns that settingSources is ignored on a Codex node', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'dag-setting-sources-codex',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              settingSources: ['project'],
            },
          ],
        },
        workflowRun,
      })
    );

    // Capability gate: codex declares settingSources: false, so the executor
    // must surface a visible "will be ignored" warning instead of a silent no-op.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warnings = sendMessage.mock.calls
      .map(call => call[1] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('settingSources'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("doesn't support");
  });

  it('routes Codex tier effort to nodeConfig.effort like every other provider', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        medium: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'codex-tier-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('gpt-5.5');
    const assistantConfig = optionsArg.assistantConfig as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    // #2556: the engine no longer knows which field Codex wants — it writes the
    // one `effort` channel and the Codex provider translates it internally.
    expect(nodeConfig.effort).toBe('medium');
    expect(assistantConfig.modelReasoningEffort).toBeUndefined();

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    // The observable contract is unchanged: node_started still reports the depth.
    expect(nodeStartedCall?.[0].data?.effort).toBe('medium');
  });

  // The regression this refactor exists to prevent. `applyPresetOptions` bails
  // when an explicit effort is declared, on the assumption it outranks the
  // preset. Before #2556 that explicit value landed on nodeConfig, which Codex
  // ignored — so adding `effort: high` to a Codex node using a tier made it run
  // at LESS depth than omitting the line entirely.
  it('an explicit effort on a Codex node beats its tier preset instead of erasing both', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        medium: { provider: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'codex-explicit-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
              effort: 'high',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBe('high');

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBe('high');
  });

  it('applies inherited workflow tier effort to nodes without model overrides', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const workflowPreset = {
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    } as const;
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        large: workflowPreset,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'inherited-workflow-tier-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
        workflowProvider: 'codex',
        workflowModel: 'gpt-5.5',
        aiProfile,
        workflowPreset,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('gpt-5.5');
    const assistantConfig = optionsArg.assistantConfig as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBe('high');
    expect(assistantConfig.modelReasoningEffort).toBeUndefined();
  });

  // The rejection half of the shared `resolvePresetEffort` gate. Both callers
  // (here and the chat orchestrator) act on its verdict, and neither proved it
  // obeyed one — the branch was reachable pre-#2556 too and equally untested.
  // OpenCode is the only registered provider with `effortControl: false`.
  it('drops a tier effort for a provider with no reasoning control, and applies nothing', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'opencode',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        medium: { provider: 'opencode', model: 'anthropic/claude-sonnet-4-6', effort: 'high' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'opencode-tier-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('opencode');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    const assistantConfig = optionsArg.assistantConfig as Record<string, unknown>;
    // Dropped on both channels — not quietly written somewhere the provider ignores.
    expect(nodeConfig.effort).toBeUndefined();
    expect(assistantConfig.modelReasoningEffort).toBeUndefined();

    expect(deliveredMessages(platform)).toContain(
      "Warning: Node 'step1' uses effort but opencode doesn't support it — this will be ignored."
    );

    // And the run does not claim a depth it never applied.
    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBeUndefined();
  });

  // CodeRabbit found the other half of the drop the preset test above pins: a
  // DECLARED effort took the opposite path, warned as unsupported and then
  // written anyway, so `node_started` reported a depth the provider never
  // applied. Both paths now drop it.
  it('drops a declared effort for a provider with no reasoning control', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'opencode',
      getCapabilities: mockCodexCapabilities,
    }));
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'opencode-declared-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'opencode',
              effort: 'high',
            },
          ],
        },
        workflowRun,
        workflowProvider: 'opencode',
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBeUndefined();

    // The author is still told — the drop is loud, not silent.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(messages.find(m => m.includes('effort'))).toBeDefined();

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBeUndefined();
  });

  it('routes Claude tier effort to nodeConfig.effort', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        large: { provider: 'claude', model: 'opus', effort: 'max' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'claude-tier-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'large',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('opus');
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBe('max');

    // Verify that the node_started event carries the resolved tier and model.
    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall).toBeDefined();
    expect(nodeStartedCall?.[0].data?.tier).toBe('large');
    expect(nodeStartedCall?.[0].data?.model).toBe('opus');
    expect(nodeStartedCall?.[0].data?.effort).toBe('max');
  });

  it('forwards a loop_group tier to a body AI node that declares none', async () => {
    // The schema documents `model`/`provider` as forwarded from a loop_group to its
    // body AI nodes. The provider always was; the model was resolved and then thrown
    // away, so a body node silently took the enclosing workflow's model — or, when the
    // workflow declared none, the install's default assistant.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        small: { provider: 'claude', model: 'haiku', effort: 'low' },
        large: { provider: 'claude', model: 'opus', effort: 'max' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'loop-group-tier-forwarding',
          model: 'large',
          nodes: [
            dagNodeSchema.parse({
              id: 'group',
              model: 'small',
              loop_group: {
                until_bash: 'exit 0',
                max_iterations: 1,
                nodes: [{ id: 'body', prompt: 'body work' }],
              },
            }),
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    // The body node declares no model, so it takes the group's `small`, not the
    // workflow's `large`.
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('haiku');

    // Tier and preset travel with the model. Forwarding the model alone would run
    // `haiku` while attributing it to `large` and applying that preset's `max` effort.
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.effort).toBe('low');

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; step_name?: string; data?: Record<string, unknown> }]>;
    const bodyStarted = createEventCalls.find(
      ([arg]) => arg.event_type === 'node_started' && arg.step_name?.endsWith('body')
    );
    expect(bodyStarted?.[0].data?.tier).toBe('small');
    expect(bodyStarted?.[0].data?.model).toBe('haiku');
  });

  it('surfaces the workflow-level tier on nodes that inherit the workflow model', async () => {
    // Regression guard for #2036: the bundled default workflows set the tier at
    // the WORKFLOW level (e.g. `model: medium`), and their nodes have no own
    // `model`. The node_started event must still carry the inherited tier.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'workflow-level-tier-test',
          model: 'medium',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
        // The executor receives the already-resolved workflow-level `medium` tier.
        workflowModel: 'sonnet',
        aiProfile,
      })
    );

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall).toBeDefined();
    expect(nodeStartedCall?.[0].data?.tier).toBe('medium');
    expect(nodeStartedCall?.[0].data?.model).toBe('sonnet');
  });

  it('passes literal node model through unchanged', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'literal-model-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'claude',
              model: 'opus',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('claude');
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg.model).toBe('opus');
  });
}
