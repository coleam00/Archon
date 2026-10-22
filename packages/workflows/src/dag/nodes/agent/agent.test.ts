// @archon-test-isolated
import { readNodeRecordEvent } from '../../../node-record-reader';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { RATE_LIMIT_MAX_RETRIES, RATE_LIMIT_PAUSE_DELAY_MS } from '../../../executor-shared';
import type { SendQueryOptions } from '@archon/provider-contract';
import { type ProviderEvent } from '@archon/provider-contract';
import {
  mockLogFn,
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
  minimalConfig,
  stubMissingContainer,
  dagOptions,
  ready,
  node,
  makeWorkflowRun,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { readNodeArtifacts } from '../../../artifacts-index';
import {
  providerEventEnvelopeSchema,
  providerEventLineSchema,
} from '../../../schemas/provider-event';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../event-emitter';
import type { DagNode, WorkflowDefinition } from '../../../schemas';
import { dagNodeSchema } from '../../../schemas';
import { expandWorkflowIncludes } from '../../../include-expander';
import type { WorkflowDeps, WorkflowConfig } from '../../../deps';
import type { IWorkflowStore } from '../../../store';
import { buildAiProfile } from '../../../model-validation';

describe('executeDagWorkflow -- tool restrictions', () => {
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

  it('passes allowed_tools to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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

  it('warns when explicit node provider conflicts with alias provider and alias wins', async () => {
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
      repoAliases: {
        '@fast': { provider: 'codex', model: 'gpt-5.5', effort: 'minimal' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'alias-provider-conflict-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'claude',
              model: '@fast',
            },
          ],
        },
        workflowRun,
        aiProfile,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('codex');
    expect(
      platform.sendMessage.mock.calls.some(call =>
        String(call[1]).includes(
          "sets provider 'claude' but model '@fast' resolves to provider 'codex'"
        )
      )
    ).toBe(true);
  });

  it('warns user when Codex DAG node has denied_tools only', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-codex-denied',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              denied_tools: ['WebSearch'],
            },
          ],
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    expect(deliveredMessages(platform)).toContain(
      "Warning: Node 'review' uses allowed_tools/denied_tools but codex doesn't support it — this will be ignored."
    );
  });

  it('passes empty allowed_tools: [] (disable all tools) to sendQuery', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-empty-tools',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              allowed_tools: [],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual([]);
  });

  it('passes hooks to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-hooks',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              hooks: {
                PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.hooks).toBeDefined();
    const hooks = nodeConfig?.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it('warns user when Codex DAG node has hooks', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-codex-hooks',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              hooks: {
                PreToolUse: [{ response: { decision: 'block' } }],
              },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    expect(deliveredMessages(platform)).toContain(
      "Warning: Node 'review' uses hooks but codex doesn't support it — this will be ignored."
    );
  });
});

describe('executeDagWorkflow -- AI node prompt substitution failure', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-subst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('records a node_failed event when $BASE_BRANCH cannot be resolved (not a silent skip)', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('subst-fail-run-id', {
      workflow_name: 'subst-fail',
      conversation_id: 'conv-subst',
      user_message: 'test',
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-subst',
        cwd: testDir,
        workflow: {
          name: 'subst-fail',
          nodes: [
            {
              id: 'needs-base',
              kind: 'agent',
              source: {
                kind: 'inline',
                prompt: 'Diff the branch against $BASE_BRANCH and review.',
              },
            },
          ],
        },
        workflowRun,
        // The prompt references $BASE_BRANCH, so leaving it unresolved makes substitution throw.
        baseBranch: '',
      })
    );

    // The substitution throw must surface as a node_failed event. Previously the
    // catch returned state:'failed' silently — the node emitted node_started and
    // then vanished with no terminal event, so downstream all_success rules
    // skipped instead of the run reporting the failure.
    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'needs-base'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain('No base branch could be resolved');
    // The provider must never have been reached — the failure precedes the query.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });
});

describe('executeDagWorkflow -- output_format structured output', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-output-fmt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'classify.md'), 'Classify this: $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  for (const kind of ['agent', 'loop'] as const) {
    for (const mode of ['stream', 'reask', 'unknown-first-reask', 'iterations'] as const) {
      if (kind === 'agent' && mode === 'iterations') continue;
      it(`keeps ${kind} node tokens unknown after an unavailable interval (${mode})`, async () => {
        const reask = mode === 'reask' || mode === 'unknown-first-reask';
        const usage = { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 };
        let calls = 0;
        mockSendQueryDag.mockImplementation(async function* () {
          calls++;
          const unknown = mode === 'unknown-first-reask' ? calls === 1 : calls === 2;
          if (mode === 'stream') {
            yield { type: 'result', sessionId: 's', tokens: usage, cost: 0.1 };
            yield { type: 'result', sessionId: 's', tokensUnknown: true, cost: 0.2 };
            yield {
              type: 'result',
              sessionId: 's',
              tokens: usage,
              cost: 0.1,
              text: '<promise>COMPLETE</promise>',
            };
          } else {
            yield {
              type: 'result',
              sessionId: 's',
              cost: 0.1,
              ...(unknown ? { tokensUnknown: true } : { tokens: usage }),
              ...(reask
                ? { structuredOutput: calls === 1 ? {} : { done: true } }
                : { text: calls === 3 ? '<promise>COMPLETE</promise>' : 'Keep working.' }),
            };
          }
        });
        const store = createMockStore();
        const outputFormat = {
          type: 'object',
          properties: { done: { type: 'boolean' } },
          required: ['done'],
        };
        const node: DagNode =
          kind === 'agent'
            ? {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Work.' },
                ...(reask ? { output_format: outputFormat } : {}),
              }
            : {
                id: 'work',
                kind: 'loop',
                ...(reask ? { output_format: outputFormat } : {}),
                loop: {
                  prompt: 'Work.',
                  fresh_context: false,
                  max_iterations: 3,
                  ...(reask ? { until_field: 'done' } : { until: 'COMPLETE' }),
                },
              };
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: { name: 'unknown-node-tokens', nodes: [node] },
            workflowRun: makeWorkflowRun('unknown-node-tokens-run'),
            workflowProvider: reask ? 'pi' : 'claude',
            config: { ...minimalConfig, assistant: reask ? 'pi' : 'claude' },
          })
        );
        expect(calls).toBe(mode === 'stream' ? 1 : reask ? 2 : 3);
        const completed = persistedEvents(store).find(
          event => event.event_type === 'node_completed' && event.step_name === 'work'
        );
        expect(completed).toBeDefined();
        expect(completed?.data?.tokens).toBeUndefined();
        const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
        expect(record?.metadata?.spend.tokens).toMatchObject({ source: 'unavailable' });
        expect(completed?.data?.cost_usd).toBeCloseTo(mode === 'stream' ? 0.4 : reask ? 0.2 : 0.3);
        expect(store.completeWorkflowRun).toHaveBeenCalled();
      });
    }
  }

  for (const scope of ['retry', 'run', 'loop-group'] as const) {
    for (const unknownFirst of [true, false]) {
      it(`keeps ${scope} aggregate tokens unknown (unknown first: ${unknownFirst})`, async () => {
        let calls = 0;
        mockSendQueryDag.mockImplementation(async function* () {
          calls++;
          yield {
            type: 'result',
            sessionId: 's',
            text: 'Work completed.',
            cost: calls === 1 ? 0.1 : 0.2,
            ...((calls === 1) === unknownFirst
              ? { tokensUnknown: true }
              : { tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 } }),
            ...(scope === 'retry' && calls === 1
              ? { isError: true, failure: { class: 'unknown', evidence: 'failed attempt' } }
              : {}),
          };
        });
        const body: DagNode[] = ['first', 'second'].map((id, i) => ({
          id,
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Work.' },
          ...(i === 1 ? { depends_on: ['first'] } : {}),
        }));
        const nodes: DagNode[] =
          scope === 'retry'
            ? [
                {
                  id: 'work',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'Work.' },
                  retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' },
                },
              ]
            : scope === 'run'
              ? body
              : [
                  {
                    id: 'work',
                    kind: 'loop_group',
                    loop_group: {
                      until_bash: 'exit 0',
                      max_iterations: 1,
                      fresh_context: false,
                      nodes: body,
                    },
                  },
                ];
        const store = createMockStore();
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: { name: 'unknown-aggregate', nodes },
            workflowRun: makeWorkflowRun('unknown-aggregate-run'),
          })
        );
        expect(calls).toBe(2);
        const usage = runUsageWrites(store).at(-1);
        expect(usage?.total_cost_usd).toBeCloseTo(0.3);
        expect(usage?.total_tokens_unknown).toBe(true);
        expect(usage?.total_tokens_in).toBeNull();
        if (scope === 'loop-group') {
          const completed = persistedEvents(store).find(
            event => event.event_type === 'node_completed' && event.step_name === 'work'
          );
          const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
          expect(record?.metadata?.spend.tokens).toEqual({
            source: 'unavailable',
            reason: 'incomplete',
          });
        }
        const snapshot = await foldDagResumeSnapshot(
          persistedEvents(store),
          'unknown-aggregate-run'
        );
        expect(snapshot.tokens).toBeUndefined();
        expect(snapshot.tokensUnknown).toBe(true);
        expect(snapshot.costUsd).toBeCloseTo(0.3);
      });
    }
  }

  for (const feedback of [true, false]) {
    it(`keeps tokens unknown across interactive loop resume (feedback: ${feedback})`, async () => {
      const workflow: WorkflowDefinition = {
        name: 'unknown-gated',
        description: 'Unknown token resume',
        nodes: [
          {
            id: 'work',
            kind: 'loop',
            loop: {
              prompt: 'Work.',
              until: 'COMPLETE',
              fresh_context: false,
              max_iterations: 3,
              interactive: true,
              gate_message: 'Review.',
            },
          },
        ],
      };
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          sessionId: 's',
          cost: 0.1,
          tokensUnknown: true,
          text: '<promise>COMPLETE</promise>',
        };
      });
      const store = createMockStore();
      const run = makeWorkflowRun('unknown-gated-run');
      await executeDagWorkflow(
        dagOptions({ deps: createMockDeps(store), cwd: testDir, workflow, workflowRun: run })
      );
      const approval = store.pauseWorkflowRun.mock.calls[0]?.[1];
      expect(approval?.execution?.spend.tokens).toEqual({
        source: 'unavailable',
        reason: 'incomplete',
      });
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          sessionId: 's',
          cost: 0.2,
          tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 },
          text: '<promise>COMPLETE</promise>',
        };
      });
      const resumedStore = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(resumedStore),
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun(run.id, {
            metadata: {
              approval,
              loop_feedback_given: feedback,
              loop_user_input: feedback ? 'Continue.' : '',
            },
          }),
        })
      );
      expect(mockSendQueryDag.mock.calls).toHaveLength(feedback ? 1 : 0);
      const completed = persistedEvents(resumedStore).find(
        event => event.event_type === 'node_completed' && event.step_name === 'work'
      );
      expect(completed?.data?.tokens).toBeUndefined();
      const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
      expect(record?.metadata?.spend.tokens).toEqual({
        source: 'unavailable',
        reason: 'incomplete',
      });
      expect(completed?.data?.cost_usd).toBeCloseTo(feedback ? 0.3 : 0.1);
      expect(runUsageWrites(resumedStore).at(-1)?.total_tokens_unknown).toBe(true);
    });
  }

  it('uses structuredOutput from result when output_format is set', async () => {
    const structuredJson = { run_code_review: 'true', run_tests: 'false' };

    // Mock yields prose + JSON as assistant text, then result with structuredOutput
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Let me analyze the PR scope...\n' };
      yield { type: 'agent_message_chunk', text: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-1', structuredOutput: structuredJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        kind: 'agent',
        source: { kind: 'command', name: 'classify' },
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      {
        id: 'review',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Review the code' },
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Run tests' },
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-output-fmt',
        cwd: testDir,
        workflow: { name: 'output-fmt-test', nodes },
        workflowRun,
      })
    );

    // The review node's when condition should evaluate to true (run_code_review == 'true')
    // The test node's when condition should evaluate to false (run_tests == 'false', not 'true')
    // So sendQuery should be called for classify + review = 2 times (not 3)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  it('does NOT override nodeOutputText with structuredOutput when output_format is absent', async () => {
    // Even if the SDK returns structuredOutput, nodes without output_format use concatenated text
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'prose analysis text' };
      yield { type: 'result', sessionId: 'sid-no-fmt', structuredOutput: { type: 'BUG' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-output-fmt-run', {
      user_message: 'test guard',
    });

    const nodes: DagNode[] = [
      { id: 'a', kind: 'agent', source: { kind: 'command', name: 'classify' } },
      {
        id: 'b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Got: $a.output' },
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-no-fmt',
        cwd: testDir,
        workflow: { name: 'no-fmt-test', nodes },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated prose, not the JSON
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('prose analysis text');
    expect(secondCallPrompt).not.toContain('"type"');
  });

  it('falls back to concatenated text when structuredOutput is absent', async () => {
    // Mock without structuredOutput on result — backward compatible
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'plain text response' };
      yield { type: 'result', sessionId: 'sid-2' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-structured-run', {
      user_message: 'test fallback',
    });

    const nodes: DagNode[] = [
      { id: 'a', kind: 'agent', source: { kind: 'command', name: 'classify' } },
      {
        id: 'b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Use output: $a.output' },
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-fallback',
        cwd: testDir,
        workflow: { name: 'fallback-test', nodes },
        workflowRun,
      })
    );

    // Both nodes should execute (no output_format, no when conditions)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated text from node a
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('plain text response');
  });

  it('passes outputFormat to Codex nodes and uses inline JSON response', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    const classifyJson = { run_code_review: 'true', run_tests: 'false' };
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: JSON.stringify(classifyJson) };
      yield { type: 'result', sessionId: 'codex-sid-1', structuredOutput: classifyJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        kind: 'agent',
        source: { kind: 'command', name: 'classify' },
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
          required: ['run_code_review', 'run_tests'],
        },
      },
      {
        id: 'review',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Review the code' },
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Run tests' },
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-codex-fmt',
        cwd: testDir,
        workflow: { name: 'codex-output-fmt', nodes },
        workflowRun,
        workflowProvider: 'codex',
      })
    );

    // classify + review = 2 calls (test node skipped because run_tests == 'false')
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Verify outputFormat was passed to the Codex client (4th arg = options)
    const classifyOptions = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(classifyOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema: nodes[0].output_format,
    });
  });

  it('does not warn about missing structuredOutput for Codex nodes', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"status":"ok"}' };
      yield { type: 'result', sessionId: 'codex-sid-2', structuredOutput: { status: 'ok' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-no-warn-run', {
      user_message: 'check it',
    });

    const nodes: DagNode[] = [
      {
        id: 'check',
        kind: 'agent',
        source: { kind: 'command', name: 'classify' },
        output_format: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-codex-no-warn',
        cwd: testDir,
        workflow: { name: 'codex-no-warn', nodes },
        workflowRun,
        workflowProvider: 'codex',
      })
    );

    // Verify no "structured output missing" warning was sent to the user
    const sendCalls = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock
      .calls;
    const warningMessages = sendCalls
      .map(call => call[1] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('did not return structured output'));
    expect(warningMessages).toHaveLength(0);
  });
});

describe('executeDagWorkflow -- tool events reach a streaming platform', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('calls sendStructuredEvent for tool messages in streaming mode during DAG', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    platform.getStreamingMode.mockReturnValue('stream');
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'call-w',
        name: 'Write',
        rawInput: { path: '/bar', content: 'x' },
      };
      yield { type: 'agent_message_chunk', text: 'Wrote the file.' };
      yield { type: 'result', sessionId: 'dag-session-tool' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-dag-tool',
        cwd: testDir,
        workflow: { name: 'dag-tool-test', nodes: [node('my-cmd')] },
        workflowRun,
      })
    );

    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-dag-tool', {
      type: 'tool_call',
      toolCallId: 'call-w',
      name: 'Write',
      rawInput: { path: '/bar', content: 'x' },
    });
  });
});

describe('executeDagWorkflow -- provider event recording', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-toolcomplete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('records every provider event unchanged in the store, the JSONL log and the emitter', async () => {
    const mockStore = createMockStore();
    const workflowRun = makeWorkflowRun();
    const yielded: ProviderEvent[] = [
      { type: 'agent_thought_chunk', text: 'thinking' },
      { type: 'tool_call', toolCallId: 'id-a', name: 'read_file', rawInput: { path: '/a' } },
      { type: 'tool_call', toolCallId: 'id-b', name: 'Bash', title: 'ls' },
      { type: 'tool_call_update', toolCallId: 'id-a', status: 'completed', output: 'contents' },
      {
        type: 'tool_call_update',
        toolCallId: 'id-b',
        status: 'failed',
        output: 'x'.repeat(16_384),
        outputTruncated: true,
        exitCode: 2,
      },
      { type: 'warning', code: 'claude.test', message: 'careful' },
      { type: 'mcp_server_status', server: 'github', status: 'connected' },
      { type: 'compaction', phase: 'completed', trigger: 'auto', tokensBefore: 9, tokensAfter: 3 },
      { type: 'subtask', taskId: 't-1', status: 'started', description: 'look' },
      { type: 'subtask', taskId: 't-1', status: 'completed', summary: 'found' },
      {
        type: 'hook',
        hookId: 'h-1',
        hookName: 'PreToolUse',
        hookEvent: 'PreToolUse',
        status: 'succeeded',
      },
      { type: 'state_update', state: 'running' },
      { type: 'agent_message_chunk', text: 'done' },
    ];
    mockSendQueryDag.mockImplementation(async function* () {
      yield* yielded;
      yield { type: 'result', sessionId: 'dag-sess-envelope' };
    });
    const emitted: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.type === 'provider_event') emitted.push(event);
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(mockStore),
          cwd: testDir,
          workflow: { name: 'dag-envelope-test', nodes: [node('my-cmd')] },
          workflowRun,
        })
      );
    } finally {
      unsubscribe();
    }

    const transcript = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const nodeStart = transcript.find(line => line.type === 'node_start');
    const attemptId = (nodeStart?.execution as { attempt?: { id?: string } } | undefined)?.attempt
      ?.id;
    expect(typeof attemptId).toBe('string');
    const rows = persistedEvents(mockStore).filter(e => e.event_type === 'provider_event');
    const lines = transcript.filter(line => line.type === 'provider_event');
    expect(rows.map(row => row.data?.event)).toEqual(yielded);
    expect(lines.map(line => line.event)).toEqual(yielded);
    expect(emitted.map(event => (event.type === 'provider_event' ? event.event : null))).toEqual(
      yielded
    );
    // The envelope names the node and the attempt, and numbers the attempt's events from 0.
    for (const [index, row] of rows.entries()) {
      expect(row.step_name).toBe('my-cmd');
      expect(providerEventEnvelopeSchema.parse(row.data)).toMatchObject({ attemptId, seq: index });
      expect(providerEventLineSchema.parse(lines[index])).toEqual({
        type: 'provider_event',
        workflow_id: workflowRun.id,
        ts: expect.any(String),
        step: 'my-cmd',
        ...providerEventEnvelopeSchema.parse(row.data),
      });
    }
    // The old line types are gone: the log has one shape for provider activity.
    expect(transcript.filter(line => line.type === 'assistant' || line.type === 'tool')).toEqual(
      []
    );
  });

  it('numbers a reask pass on from the first pass of the same attempt', async () => {
    const mockStore = createMockStore();
    const workflowRun = makeWorkflowRun();
    let pass = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      pass += 1;
      yield { type: 'agent_message_chunk', text: `pass ${String(pass)}` };
      yield {
        type: 'result',
        sessionId: `dag-sess-reask-${String(pass)}`,
        structuredOutput: pass === 1 ? { note: 'bad' } : { ok: true },
      };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(mockStore),
        cwd: testDir,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
        workflow: {
          name: 'dag-reask-seq',
          nodes: [
            {
              ...node('my-cmd'),
              provider: 'pi',
              output_format: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(pass).toBe(2);
    const envelopes = persistedEvents(mockStore)
      .filter(e => e.event_type === 'provider_event')
      .map(e => providerEventEnvelopeSchema.parse(e.data));
    expect(envelopes.map(e => e.seq)).toEqual([0, 1]);
    expect(new Set(envelopes.map(e => e.attemptId)).size).toBe(1);
  });

  it('records no tool event when no tools were called in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-sess-3' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-dag-notools',
        cwd: testDir,
        workflow: { name: 'dag-notools-test', nodes: [node('my-cmd')] },
        workflowRun,
      })
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const toolEvents = createEventCalls.filter(
      ([arg]) =>
        arg.event_type === 'provider_event' &&
        (arg.data?.event as { type?: string } | undefined)?.type?.startsWith('tool_call')
    );

    expect(toolEvents.length).toBe(0);
  });
});

describe('executeDagWorkflow -- credit exhaustion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-credit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    await removeTempTree(testDir);
  });

  it.each([
    'The error message "Your credit balance is too low" is what the API returns when funds run out.',
    "A user once saw: You've hit your session limit · resets 3am. Handle it in the UI.",
  ])('a node whose output only mentions a credit or session limit completes: %s', async text => {
    const sendQuery = mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
      async function* () {
        yield { type: 'agent_message_chunk', text };
        yield { type: 'result', sessionId: 'dag-session-credit' };
      }
    );
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });

    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('credit-exhaustion-run');
    const logDir = join(testDir, 'logs');

    await executeDagWorkflow(
      dagOptions({
        deps,
        platform,
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-test',
          nodes: [
            {
              id: 'investigate',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Investigate the issue' },
            },
          ],
        },
        workflowRun,
        logDir,
      })
    );

    const eventCalls = (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>)
      .mock.calls;
    const events = eventCalls.map(c => c[0].event_type);
    expect(events).toContain('node_completed');
    expect(events).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  /** A provider turn that ends in a typed quota failure. */
  function quotaExhaustedQuery(
    resetAt?: string
  ): Mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']> {
    return mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
      yield {
        type: 'result',
        isError: true,
        sessionId: 'dag-session-credit',
        failure: {
          class: 'quota_exhausted',
          evidence: "You've hit your session limit",
          ...(resetAt !== undefined ? { resetAt } : {}),
        },
      };
    });
  }

  it.each(['2099-10-03T23:00:00.000Z', undefined])(
    'a typed quota failure fails the node with its reset time when present: %s',
    async resetAt => {
      const sendQuery = quotaExhaustedQuery(resetAt);
      mockGetAgentProviderDag.mockReturnValue({
        sendQuery,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      });
      const store = createMockStore();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: testDir,
          workflow: {
            name: 'credit-test',
            nodes: [
              {
                id: 'investigate',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Investigate the issue' },
                retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('typed-credit-failure-run'),
          config: quotaConfig(false),
        })
      );

      const eventCalls = (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>)
        .mock.calls;
      const events = eventCalls.map(c => c[0].event_type);
      expect(events).toContain('node_failed');
      expect(events).not.toContain('node_completed');
      const failedEvent = eventCalls.find(c => c[0].event_type === 'node_failed');
      expect(failedEvent?.[0].data?.error).toBe(
        resetAt !== undefined
          ? `Node 'investigate' failed: the provider's usage or credit limit is used up until ${resetAt}: You've hit your session limit`
          : "Node 'investigate' failed: the provider's usage or credit limit is used up. Resume the run once it reopens: You've hit your session limit"
      );
      expect(failedEvent?.[0].data?.provider_failure).toEqual({
        class: 'quota_exhausted',
        evidence: "You've hit your session limit",
        ...(resetAt !== undefined ? { resetAt } : {}),
      });
      expect(sendQuery).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    }
  );

  function quotaConfig(autoResumeOnQuotaReset = true): WorkflowConfig {
    return { ...minimalConfig, workflows: { autoResumeOnQuotaReset } };
  }

  const investigateWorkflow = {
    name: 'credit-wait-test',
    nodes: [
      {
        id: 'investigate',
        kind: 'agent' as const,
        source: { kind: 'inline' as const, prompt: 'Investigate the issue' },
      },
    ],
  };

  function useQuery(sendQuery: ReturnType<typeof quotaExhaustedQuery>): void {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });
  }

  it('waits until the reset instant a typed quota failure reports, instead of failing', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    useQuery(quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-wait-run'),
        config: quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-run',
      {
        owner: 'node',
        nodeId: 'investigate',
        kind: 'quota',
        pauseId: expect.any(String),
        waitingSince: expect.any(String),
        resumeAt: resetAt,
      },
      { kind: 'started', stepName: 'investigate' }
    );
    // The typed failure is recorded on the node, unchanged.
    const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
    expect(failed?.data?.provider_failure).toEqual({
      class: 'quota_exhausted',
      evidence: "You've hit your session limit",
      resetAt,
    });
  });

  it('propagates a rejected quota pause write while the run is still running', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    useQuery(quotaExhaustedQuery(resetAt));
    const store = createMockStore();
    const failure = new Error('quota pause write failed');
    store.pauseWorkflowRunForWait.mockRejectedValue(failure);

    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: testDir,
          workflow: investigateWorkflow,
          workflowRun: makeWorkflowRun('credit-write-failure-run'),
          config: quotaConfig(),
        })
      )
    ).rejects.toBe(failure);
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-write-failure-run',
      expect.objectContaining({ kind: 'quota', resumeAt: resetAt }),
      { kind: 'started', stepName: 'investigate' }
    );
    expect(store.getWorkflowRunStatus).toHaveBeenCalledWith('credit-write-failure-run');
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('waits when the quota failure comes from a loop-group body node', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    useQuery(quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-wait-group',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'draft' } }],
              },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-group-run'),
        config: quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-group-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'refine', resumeAt: resetAt }),
      { kind: 'started', stepName: 'refine' }
    );
  });

  it('waits when a loop-group body node failed reading the limited node output', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    useQuery(quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-wait-group-reader',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [
                  { id: 'prep', kind: 'exec', runtime: 'sh', script: 'echo ready' },
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'draft' },
                    depends_on: ['prep'],
                  },
                  {
                    id: 'join',
                    kind: 'exec',
                    runtime: 'sh',
                    script: 'echo $work.output',
                    depends_on: ['prep', 'work'],
                    trigger_rule: 'all_done',
                  },
                ],
              },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-group-reader-run'),
        config: quotaConfig(),
      })
    );

    expect(persistedEvents(store)).toContainEqual(
      expect.objectContaining({ event_type: 'node_failed', step_name: 'refine.join' })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-group-reader-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'refine', resumeAt: resetAt }),
      { kind: 'started', stepName: 'refine' }
    );
  });

  it('waits when a node failed reading the limited node output', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    useQuery(quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-wait-reader',
          nodes: [
            { id: 'sweep', kind: 'agent', source: { kind: 'inline', prompt: 'sweep' } },
            {
              id: 'record',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo $sweep.output',
              depends_on: ['sweep'],
              trigger_rule: 'all_done',
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-reader-run'),
        config: quotaConfig(),
      })
    );

    expect(persistedEvents(store)).toContainEqual(
      expect.objectContaining({ event_type: 'node_failed', step_name: 'record' })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-reader-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'sweep', resumeAt: resetAt }),
      { kind: 'started', stepName: 'sweep' }
    );
  });

  it.each([
    ['still ahead', 10 * 60_000],
    ['already passed', -60_000],
  ])('waits for the latest reset when another usage reset is %s', async (_case, offsetMs) => {
    const sooner = new Date(Date.now() + offsetMs).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    // The later reset is the first node, so a pass that kept the first or the earliest
    // reset would wait on the wrong one.
    useQuery(
      mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* (prompt) {
        yield {
          type: 'result',
          isError: true,
          sessionId: 'dag-session-credit',
          failure: {
            class: 'quota_exhausted',
            evidence: "You've hit your session limit",
            resetAt: prompt.includes('later') ? later : sooner,
          },
        };
      })
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-wait-latest',
          nodes: [
            { id: 'first', kind: 'agent', source: { kind: 'inline', prompt: 'later' } },
            { id: 'second', kind: 'agent', source: { kind: 'inline', prompt: 'sooner' } },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-latest-run'),
        config: quotaConfig(),
      })
    );

    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'node_failed')
        .map(event => event.step_name)
        .sort()
    ).toEqual(['first', 'second']);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-latest-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'first', resumeAt: later }),
      { kind: 'started', stepName: 'first' }
    );
  });

  it('never waits on error text that only reads like a quota limit', async () => {
    // Untyped provider errors: the words say "usage limit reached" with a reset epoch,
    // but no provider classified the failure, so the run fails.
    const resetEpoch = Math.floor(Date.now() / 1000) + 600;
    useQuery(
      mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_during_execution',
          errors: [`Claude AI usage limit reached|${String(resetEpoch)}`],
          sessionId: 'dag-session-credit',
        };
      })
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-prose-run'),
        config: quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  });

  it('fails as before when a typed quota failure reports no reset', async () => {
    useQuery(quotaExhaustedQuery());
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-no-reset-run'),
        config: quotaConfig(),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'credit-no-reset-run',
      expect.stringContaining('investigate'),
      { exitReason: 'node_error' }
    );
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        step_name: 'investigate',
        data: { reason: 'reset_unavailable' },
      })
    );
  });

  it.each([
    ['the operator turned the wait off', false, 10 * 60_000, 'disabled'],
    ['the reported reset has already passed', true, -60_000, 'reset_passed'],
  ])('fails when %s', async (_case, autoResume, resetOffsetMs, reason) => {
    useQuery(quotaExhaustedQuery(new Date(Date.now() + resetOffsetMs).toISOString()));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-fail-run'),
        config: quotaConfig(autoResume),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        step_name: 'investigate',
        data: { reason },
      })
    );
  });

  it('fails when another node failed for a reason the reset does not clear', async () => {
    useQuery(quotaExhaustedQuery(new Date(Date.now() + 10 * 60_000).toISOString()));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: testDir,
        workflow: {
          name: 'credit-mixed-test',
          nodes: [
            ...investigateWorkflow.nodes,
            { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-mixed-run'),
        config: quotaConfig(),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  /** A provider turn that ends in a typed rate limit, on every attempt. */
  function rateLimitedQuery(
    resetAt?: string
  ): Mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']> {
    return mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
      yield {
        type: 'result',
        isError: true,
        sessionId: 'dag-session-rate',
        failure: {
          class: 'rate_limited',
          evidence: 'HTTP 429',
          ...(resetAt !== undefined ? { resetAt } : {}),
        },
      };
    });
  }

  /** Run with the rate-limit retry delays shortened to a millisecond. */
  async function withShortRetryDelays(run: () => Promise<unknown>): Promise<void> {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      await run();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  it(
    'waits a jittered backoff when a rate limit outlasts its retries, instead of failing',
    async () => {
      const sendQuery = rateLimitedQuery();
      useQuery(sendQuery);
      const store = createMockStore();
      const before = Date.now();

      await withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: testDir,
            workflow: investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-wait-run'),
            config: quotaConfig(),
          })
        )
      );

      expect(sendQuery).toHaveBeenCalledTimes(1 + RATE_LIMIT_MAX_RETRIES);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'rate-wait-run',
        expect.objectContaining({ owner: 'node', nodeId: 'investigate', kind: 'quota' }),
        { kind: 'started', stepName: 'investigate' }
      );
      const wait = store.pauseWorkflowRunForWait.mock.calls[0]?.[1];
      const resumeAt = Date.parse(wait?.kind === 'quota' ? wait.resumeAt : '');
      expect(resumeAt).toBeGreaterThanOrEqual(before + RATE_LIMIT_PAUSE_DELAY_MS / 2);
      expect(resumeAt).toBeLessThanOrEqual(Date.now() + (RATE_LIMIT_PAUSE_DELAY_MS * 3) / 2);
      const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
      expect(failed?.data?.provider_failure).toEqual({
        class: 'rate_limited',
        evidence: 'HTTP 429',
      });
    },
    testTimeout(10_000)
  );

  it(
    'waits until the reset a rate-limited failure reports',
    async () => {
      const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
      useQuery(rateLimitedQuery(resetAt));
      const store = createMockStore();

      await withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: testDir,
            workflow: investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-reset-run'),
            config: quotaConfig(),
          })
        )
      );

      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'rate-reset-run',
        expect.objectContaining({ kind: 'quota', nodeId: 'investigate', resumeAt: resetAt }),
        { kind: 'started', stepName: 'investigate' }
      );
    },
    testTimeout(10_000)
  );

  it(
    'fails an exhausted rate limit when the operator turned the wait off',
    async () => {
      useQuery(rateLimitedQuery());
      const store = createMockStore();

      await withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: testDir,
            workflow: investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-disabled-run'),
            config: quotaConfig(false),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.createWorkflowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'quota_resume_skipped',
          step_name: 'investigate',
          data: { reason: 'disabled' },
        })
      );
    },
    testTimeout(10_000)
  );

  it(
    'fails when a node beside an exhausted rate limit failed for another reason',
    async () => {
      useQuery(rateLimitedQuery());
      const store = createMockStore();

      await withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: testDir,
            workflow: {
              name: 'rate-mixed-test',
              nodes: [
                ...investigateWorkflow.nodes,
                { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
              ] as DagNode[],
            },
            workflowRun: makeWorkflowRun('rate-mixed-run'),
            config: quotaConfig(),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    },
    testTimeout(10_000)
  );

  it(
    'fails a loop group whose body failed both on an exhausted rate limit and for another reason',
    async () => {
      useQuery(rateLimitedQuery());
      const store = createMockStore();

      await withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: testDir,
            workflow: {
              name: 'rate-mixed-group',
              nodes: [
                {
                  id: 'refine',
                  kind: 'loop_group',
                  loop_group: {
                    until: 'DONE',
                    max_iterations: 3,
                    nodes: [
                      { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'draft' } },
                      { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
                    ],
                  },
                },
              ] as DagNode[],
            },
            workflowRun: makeWorkflowRun('rate-mixed-group-run'),
            config: quotaConfig(),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      const groupFailed = persistedEvents(store).find(
        event => event.event_type === 'node_failed' && event.step_name === 'refine'
      );
      expect(groupFailed?.data?.error).toContain("'broken'");
      expect(groupFailed?.data?.provider_failure).toBeUndefined();
    },
    testTimeout(10_000)
  );

  it('does not wait for a container run, which the continuation host cannot continue', async () => {
    useQuery(quotaExhaustedQuery(new Date(Date.now() + 10 * 60_000).toISOString()));
    const store = createMockStore();
    const execSpy = stubMissingContainer();

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: testDir,
          workflow: investigateWorkflow,
          workflowRun: makeWorkflowRun('container-credit-run'),
          config: quotaConfig(),
          execContext: { kind: 'container', containerId: 'container-1' },
        })
      );
    } finally {
      execSpy.mockRestore();
    }

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        data: { reason: 'container_unsupported' },
      })
    );
  });
});

describe('executeDagWorkflow -- cost tracking', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('persists total_cost_usd on the run row when a node yields cost', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 'sid-cost', cost: 0.0042 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-cost',
          nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
        },
        workflowRun,
      })
    );

    expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.0042 }]);
    // Exactly one writer: completeWorkflowRun keeps node_counts, not usage (#2469).
    const completeCalls = (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>)
      .mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][2]).toEqual({
      node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
    });
  });

  it('sums total_cost_usd across multiple sequential nodes', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: `Step ${String(callCount)} output` };
      yield { type: 'result', sessionId: `sid-${String(callCount)}`, cost: 0.001 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-cost-multi',
          nodes: [
            { id: 'step1', kind: 'agent', source: { kind: 'inline', prompt: 'Step 1.' } },
            {
              id: 'step2',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Step 2.' },
              depends_on: ['step1'],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.002 }]);
  });

  it('marks unreported provider cost incomplete without inventing an amount', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Some output' };
      yield { type: 'result', sessionId: 'sid-no-cost' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-no-cost',
          nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
        },
        workflowRun,
      })
    );

    expect(runUsageWrites(store)).toEqual([{ total_cost_incomplete: true }]);
    const completeCalls = (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>)
      .mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][2]).not.toHaveProperty('total_cost_usd');
  });

  it('retains finite loop costs and marks a later non-finite cost incomplete', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount < 4) {
        yield { type: 'agent_message_chunk', text: 'Still working...' };
        yield {
          type: 'result',
          sessionId: `loop-sid-${String(callCount)}`,
          cost: callCount < 3 ? 0.001 : 0.002,
        };
      } else {
        yield { type: 'agent_message_chunk', text: 'All done! <promise>COMPLETE</promise>' };
        yield {
          type: 'result',
          sessionId: `loop-sid-${String(callCount)}`,
          cost: Number.NaN,
        };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-cost',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: { fresh_context: false, prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
            },
          ],
        },
        workflowRun,
      })
    );

    // The final NaN is omitted without erasing the first three iterations.
    expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.004, total_cost_incomplete: true }]);
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'loop_node.usage_cost_non_finite_ignored'
      )
    ).toBe(true);

    // The loop's own terminal row carries the cumulative total once, and its
    // per-iteration rows carry duration only (#3508). Nothing on the path restates
    // the total, so a reader summing the transcript lands on the run total.
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const terminal = rows.find(row => row.type === 'node_complete' && row.step === 'my-loop');
    expect(terminal?.cost_usd).toBeCloseTo(0.004, 10);
    const iterationRows = rows.filter(
      row =>
        row.type === 'node_complete' &&
        typeof row.step === 'string' &&
        row.step.startsWith('my-loop-iteration-')
    );
    expect(iterationRows.length).toBe(4);
    for (const row of iterationRows) expect(row).not.toHaveProperty('cost_usd');
  });
});

describe('executeDagWorkflow -- provider session ids stay on the node record', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-session-ids-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('records each attempt and iteration id durably and nowhere in the stream', async () => {
    const failedAttempt = 'a1111111-0000-4000-8000-000000000001';
    const completedAttempt = 'b2222222-0000-4000-8000-000000000002';
    const iterations = [
      'c3333333-0000-4000-8000-000000000003',
      'd4444444-0000-4000-8000-000000000004',
      'e5555555-0000-4000-8000-000000000005',
    ];
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      if (calls === 1) {
        yield {
          type: 'result',
          sessionId: failedAttempt,
          isError: true,
          errors: ['upstream overloaded'],
          failure: { class: 'transient', evidence: 'upstream overloaded' },
        };
        return;
      }
      if (calls === 2) {
        yield { type: 'agent_message_chunk', text: 'planned' };
        yield { type: 'result', sessionId: completedAttempt };
        return;
      }
      const iteration = calls - 2;
      yield { type: 'agent_message_chunk', text: iteration === 3 ? 'DONE' : 'working' };
      yield { type: 'result', sessionId: iterations[iteration - 1] };
    });
    const emitted: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      emitted.push(event);
    });
    const store = createMockStore();
    const workflowRun = makeWorkflowRun('session-ids-run');
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'session-ids',
            nodes: [
              {
                id: 'plan',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'plan it' },
                output_type: 'plan',
                retry: { max_attempts: 1, delay_ms: 1 },
              },
              {
                id: 'work',
                kind: 'loop',
                depends_on: ['plan'],
                output_type: 'work',
                loop: { prompt: 'work', until: 'DONE', max_iterations: 5, fresh_context: true },
              },
            ],
          },
          workflowRun,
        })
      );
    } finally {
      unsubscribe();
    }
    expect(store.completeWorkflowRun).toHaveBeenCalled();

    const rows = persistedEvents(store);
    const sessionIdsOf = (eventType: string, step: string): unknown[] =>
      rows
        .filter(row => row.event_type === eventType && row.step_name === step)
        .map(row => row.data?.session_id);
    expect(sessionIdsOf('node_failed', 'plan')).toEqual([failedAttempt]);
    expect(sessionIdsOf('node_completed', 'plan')).toEqual([completedAttempt]);
    expect(sessionIdsOf('loop_iteration_completed', 'work')).toEqual(iterations);
    expect(sessionIdsOf('node_completed', 'work')).toEqual([iterations[2]]);

    const allIds = [failedAttempt, completedAttempt, ...iterations];
    const transcript = await readFile(join(testDir, 'logs', `${workflowRun.id}.jsonl`), 'utf8');
    const stream = JSON.stringify(emitted);
    const { artifactsByType } = await readNodeArtifacts(join(testDir, 'artifacts'), {
      scope: 'current-run',
      runId: workflowRun.id,
    });
    expect(Object.keys(artifactsByType).sort()).toEqual(['plan', 'work']);
    const artifactIndex = JSON.stringify(artifactsByType);
    for (const id of allIds) {
      expect(transcript).not.toContain(id);
      expect(stream).not.toContain(id);
      expect(artifactIndex).not.toContain(id);
    }
    // The preview still reaches the stream.
    expect(stream).toContain(completedAttempt.slice(0, 8));
  });

  it("an iteration retried after a failed attempt records only the successful attempt's session", async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      if (calls === 2) {
        // Iteration 2, attempt 1: names a session, then fails transiently.
        yield {
          type: 'result',
          sessionId: 'failed-attempt-session',
          isError: true,
          errors: ['upstream overloaded'],
          failure: { class: 'transient', evidence: 'upstream overloaded' },
        };
        return;
      }
      yield { type: 'agent_message_chunk', text: calls === 4 ? 'DONE' : 'working' };
      // Iteration 2's successful retry (call 3) reports no session.
      yield calls === 3
        ? { type: 'result' }
        : { type: 'result', sessionId: `iteration-session-${String(calls)}` };
    });
    const store = createMockStore();
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'iteration-retry-session',
            nodes: [
              {
                id: 'work',
                kind: 'loop',
                loop: { prompt: 'work', until: 'DONE', max_iterations: 5, fresh_context: true },
              },
            ],
          },
          workflowRun: makeWorkflowRun('iteration-retry-session-run'),
        })
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(
      persistedEvents(store)
        .filter(row => row.event_type === 'loop_iteration_completed')
        .map(row => row.data?.session_id)
    ).toEqual(['iteration-session-1', undefined, 'iteration-session-4']);
  });
});

describe('executeDagWorkflow -- systemPrompt and agents are runtime substitution surfaces', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-aicfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  async function runNodes(
    nodes: unknown[],
    run = makeWorkflowRun('aicfg-run')
  ): Promise<SendQueryOptions[]> {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: { name: 'aicfg', nodes: nodes.map(n => dagNodeSchema.parse(n) as DagNode) },
        workflowRun: run,
      })
    );
    return mockSendQueryDag.mock.calls.map(call => {
      const options = call[3];
      if (!options) throw new Error('Expected provider query options');
      return options;
    });
  }

  it('AC15 — all three surfaces resolve workflow variables and $node.output refs', async () => {
    const options = await runNodes([
      { id: 'produce', bash: 'printf "%s" "UPSTREAM"' },
      {
        id: 'use',
        prompt: 'go',
        depends_on: ['produce'],
        systemPrompt: 'artifacts=$ARTIFACTS_DIR upstream=$produce.output',
        agents: {
          helper: {
            description: 'handles $produce.output',
            prompt: 'work on $produce.output in $ARTIFACTS_DIR',
          },
        },
      },
    ]);

    const artifacts = join(testDir, 'artifacts');
    const last = options.at(-1)!;
    expect(last.systemPrompt).toBe(`artifacts=${artifacts} upstream=UPSTREAM`);
    expect(last.nodeConfig?.agents?.helper?.description).toBe('handles UPSTREAM');
    expect(last.nodeConfig?.agents?.helper?.prompt).toBe(`work on UPSTREAM in ${artifacts}`);
  });

  it('AC15 — the node definition is not mutated, so a second pass is not double-substituted', async () => {
    const definition = dagNodeSchema.parse({
      id: 'use',
      prompt: 'go',
      systemPrompt: 'dir=$ARTIFACTS_DIR',
    }) as DagNode;
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: { name: 'aicfg2', nodes: [definition] },
        workflowRun: makeWorkflowRun('aicfg-run-2'),
      })
    );
    expect(definition.systemPrompt).toBe('dir=$ARTIFACTS_DIR');
  });

  it('AC15 — $INPUTS in a systemPrompt produces the same text standalone as composed', async () => {
    const block: WorkflowDefinition = {
      name: 'sp-blk',
      description: 'sp-blk',
      inputs: { mode: { default: 'strict' } },
      nodes: [dagNodeSchema.parse({ id: 'work', prompt: 'go', systemPrompt: 'mode=$INPUTS.mode' })],
    };
    const parent: WorkflowDefinition = {
      name: 'sp-parent',
      description: 'sp-parent',
      nodes: [dagNodeSchema.parse({ id: 'inc', include: 'sp-blk' })],
    };

    // Standalone: `$INPUTS.mode` resolves at RUN time from the run's own declared inputs.
    const standalone = await runNodes(
      [{ id: 'work', prompt: 'go', systemPrompt: 'mode=$INPUTS.mode' }],
      makeWorkflowRun('sp-standalone', { metadata: { inputs: { mode: 'strict' } } })
    );
    expect(standalone.at(-1)!.systemPrompt).toBe('mode=strict');

    // Composed: the same text, resolved at LOAD time by the include macro.
    mockSendQueryDag.mockClear();
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['sp-blk', block],
        ['sp-parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: ready(workflows.get('sp-parent')!),
        workflowRun: makeWorkflowRun('sp-composed'),
      })
    );
    expect(mockSendQueryDag.mock.calls.at(-1)?.[3]?.systemPrompt).toBe('mode=strict');
  });
});
