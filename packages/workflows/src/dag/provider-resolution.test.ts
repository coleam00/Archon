// @archon-test-isolated
import { describe, beforeEach, afterEach, it, mock, expect, type Mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import { getProviderCapabilities, providerRegistry } from '@archon/providers';
import { loadMcpConfig } from '@archon/providers/mcp/config';
import type { MessageChunk } from '@archon/provider-contract';
import type { WorkflowDeps, IWorkflowPlatform } from '../deps';
import { type DagNode, type WorkflowDefinition, type NodeMcp, dagNodeSchema } from '../schemas';
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from '../dag-executor';
import { readNodeRecordEvent } from '../node-record-reader';
import type { IWorkflowStore } from '../store';
import { buildAiProfile } from '../model-validation';
import { missingMcpConfigMessage } from '../mcp-path';
import { discoverWorkflows } from '../workflow-discovery';
import { captureWorkflowSource, capturedSourceRoots } from '../workflow-source';
import { readHomeMcpDirectory } from '../compiled-command';
import { expandWorkflowIncludes } from '../include-expander';
import {
  createMockStore,
  createMockDeps,
  withProviderCapabilities,
  mockProviderRegistry,
  mockClaudeCapabilities,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockPlatform,
  mockCodexCapabilities,
  minimalConfig,
  deliveredMessages,
  mockLogFn,
  runUsageWrites,
  loaderBypassingWorkflow,
  setMockWorkflowHome,
  mockWorkflowHome,
  type MockWorkflowStore,
  ready,
} from './test-utils';

describe('executor capability ownership', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dag-capabilities-'));
  });

  afterEach(async () => {
    await removeTempTree(cwd);
  });

  for (const kind of ['agent', 'loop'] as const) {
    it(`rejects unsupported descriptor capabilities before creating a ${kind} provider`, async () => {
      const store = createMockStore();
      const deps = createMockDeps(
        store,
        withProviderCapabilities(mockProviderRegistry, 'claude', {
          ...mockClaudeCapabilities(),
          skills: false,
        })
      );
      const factory = mock<WorkflowDeps['getAgentProvider']>(() => {
        throw new Error('Rejected capabilities must not create a provider');
      });
      deps.getAgentProvider = factory;
      const node: DagNode =
        kind === 'agent'
          ? {
              id: 'work',
              kind,
              source: { kind: 'inline', prompt: 'work' },
              skills: ['required-skill'],
            }
          : {
              id: 'work',
              kind,
              skills: ['required-skill'],
              loop: {
                prompt: 'work',
                fresh_context: false,
                max_iterations: 1,
                until: 'COMPLETE',
              },
            };
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps,
            cwd,
            workflow: { name: 'descriptor-admission', nodes: [node] },
            workflowRun: makeWorkflowRun(),
          })
        )
      ).rejects.toThrow(
        "Node 'work' (provider 'claude') names skills, but that provider cannot load what the node names."
      );
      expect(factory).not.toHaveBeenCalled();
    });

    for (const structuredOutput of ['best-effort', 'enforced'] as const) {
      it(`uses the descriptor's ${structuredOutput} reask policy in a ${kind} node`, async () => {
        let calls = 0;
        const sendQuery = mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
          async function* () {
            calls++;
            yield {
              type: 'result',
              sessionId: 'owner-session',
              structuredOutput: calls === 1 ? { invalid: true } : { done: true },
            };
            yield { type: 'settled' };
          }
        );
        const store = createMockStore();
        const providers = withProviderCapabilities(mockProviderRegistry, 'claude', {
          ...mockClaudeCapabilities(),
          structuredOutput,
        });
        const deps = createMockDeps(store, providers);
        const factory = mock<WorkflowDeps['getAgentProvider']>(() => ({
          sendQuery,
          checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
          getType: () => 'claude',
          getCapabilities: () => {
            throw new Error('Instance capabilities are not the executor owner');
          },
        }));
        deps.getAgentProvider = factory;
        const output_format = {
          type: 'object',
          properties: { done: { type: 'boolean' } },
          required: ['done'],
          additionalProperties: false,
        };
        const node: DagNode =
          kind === 'agent'
            ? {
                id: 'work',
                kind,
                source: { kind: 'inline', prompt: 'work' },
                output_format,
                retry: { max_attempts: 0 },
              }
            : {
                id: 'work',
                kind,
                output_format,
                retry: { max_attempts: 0 },
                loop: {
                  prompt: 'work',
                  fresh_context: false,
                  max_iterations: 1,
                  until_field: 'done',
                },
              };
        await executeDagWorkflow(
          dagOptions({
            deps,
            cwd,
            workflow: { name: 'descriptor-reasks', nodes: [node] },
            workflowRun: makeWorkflowRun(),
          })
        );
        expect(factory).toHaveBeenCalledTimes(1);
        expect(sendQuery).toHaveBeenCalledTimes(structuredOutput === 'best-effort' ? 2 : 1);
        expect(
          persistedEvents(store).some(
            event =>
              event.event_type ===
              (structuredOutput === 'best-effort' ? 'node_completed' : 'node_failed')
          )
        ).toBe(true);
      });
    }

    for (const reports of [false, true]) {
      it(`records descriptor reporting availability (${reports}) in a ${kind} node`, async () => {
        const store = createMockStore();
        const deps = createMockDeps(
          store,
          withProviderCapabilities(mockProviderRegistry, 'claude', {
            ...mockClaudeCapabilities(),
            costReporting: reports,
            tokenReporting: reports,
            turnCountReporting: reports,
            stopReasonReporting: reports,
            resolvedModelReporting: reports,
          })
        );
        deps.getAgentProvider = mock<WorkflowDeps['getAgentProvider']>(() => ({
          sendQuery: async function* () {
            yield {
              type: 'result',
              sessionId: 'owner-session',
              text: '<promise>COMPLETE</promise>',
            };
            yield { type: 'settled' };
          },
          checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
          getType: () => 'claude',
          getCapabilities: () => {
            throw new Error('Instance capabilities are not the executor owner');
          },
        }));
        const node: DagNode =
          kind === 'agent'
            ? { id: 'work', kind, source: { kind: 'inline', prompt: 'work' } }
            : {
                id: 'work',
                kind,
                loop: {
                  prompt: 'work',
                  fresh_context: false,
                  max_iterations: 1,
                  until: 'COMPLETE',
                },
              };
        await executeDagWorkflow(
          dagOptions({
            deps,
            cwd,
            workflow: { name: 'descriptor-reporting', nodes: [node] },
            workflowRun: makeWorkflowRun(),
          })
        );
        const completed = persistedEvents(store).find(
          event => event.event_type === 'node_completed'
        );
        expect(completed).toBeDefined();
        const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
        const unavailable = {
          source: 'unavailable',
          reason: reports ? 'not_reported' : 'unsupported',
        } as const;
        expect(record?.metadata?.spend.costUsd).toEqual(unavailable);
        expect(record?.metadata?.spend.tokens).toEqual(unavailable);
        expect(record?.metadata?.spend.numTurns).toEqual(unavailable);
        expect(record?.metadata?.spend.stopReason).toEqual(unavailable);
        expect(record?.metadata?.binding.model?.resolved).toEqual(unavailable);
        expect(deps.getAgentProvider).toHaveBeenCalledTimes(1);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Skills — executor-level behavior (#446)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- skills options', () => {
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
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  it('passes agents/agent/allowedTools to sendQuery when node has skills', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-skills',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              skills: ['codebase-search', 'test-runner'],
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    // skills are passed in nodeConfig — provider translates to agents internally
    expect(nodeConfig?.skills).toEqual(['codebase-search', 'test-runner']);
  });

  it('appends Skill to existing allowed_tools list when node has both', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-skills-tools',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              skills: ['codebase-search'],
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
    // skills and allowed_tools are both in nodeConfig — provider merges internally
    expect(nodeConfig?.skills).toEqual(['codebase-search']);
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('fails the run before any node runs when a later node names skills on a provider without the capability', async () => {
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'dag-codex-skills',
            nodes: [
              { id: 'first', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
              {
                id: 'second',
                kind: 'agent',
                source: { kind: 'command', name: 'my-cmd' },
                depends_on: ['first'],
                provider: 'codex',
                skills: ['codebase-search'],
              },
            ],
          },
          workflowRun: makeWorkflowRun(),
        })
      )
    ).rejects.toThrow("Node 'second' (provider 'codex') names skills");
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('fails the run before any node runs when a later node names mcp on a provider without the capability', async () => {
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'dag-pi-mcp',
            nodes: [
              { id: 'first', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
              {
                id: 'second',
                kind: 'agent',
                source: { kind: 'command', name: 'my-cmd' },
                depends_on: ['first'],
                provider: 'pi',
                mcp: 'mcp.json',
              },
            ],
          },
          workflowRun: makeWorkflowRun(),
        })
      )
    ).rejects.toThrow("Node 'second' (provider 'pi') names mcp");
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('runs a node whose optional mcp its provider cannot load, recording why', async () => {
    const store = createMockStore();
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-pi-optional-mcp',
          nodes: [
            {
              id: 'only',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'pi',
              mcp: { path: 'mcp.json', optional: true },
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(mockSendQueryDag.mock.calls[0][3]?.nodeConfig?.mcp).toBeUndefined();
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; data?: Record<string, unknown> }
    );
    const completed = events.find(event => event.event_type === 'node_completed');
    expect(completed?.data?.mcp_unavailable).toEqual({
      path: 'mcp.json',
      reason: 'provider_unsupported',
    });
    const sent = platform.sendMessage.mock.calls.map(call => call[1]);
    expect(sent).toContain(
      "Node 'only' runs without its optional MCP servers (mcp.json): provider 'pi' cannot load MCP servers."
    );
  });

  it('runs a node with empty skills and plugins lists on a provider without those capabilities', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'dag-codex-empty-lists',
          nodes: [
            {
              id: 'only',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              skills: [],
              plugins: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
  });

  it('passes named plugins to sendQuery nodeConfig', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'dag-plugins',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              plugins: ['formatter@tools'],
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect((optionsArg.nodeConfig as Record<string, unknown>).plugins).toEqual(['formatter@tools']);
  });

  it('fails the run before any node runs when a later node names plugins on a provider without the capability', async () => {
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'dag-plugins-pi',
            nodes: [
              { id: 'first', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
              {
                id: 'second',
                kind: 'agent',
                source: { kind: 'command', name: 'my-cmd' },
                depends_on: ['first'],
                provider: 'pi',
                plugins: ['formatter@tools'],
              },
            ],
          },
          workflowRun: makeWorkflowRun(),
        })
      )
    ).rejects.toThrow("Node 'second' (provider 'pi') names plugins");
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('passes agents to sendQuery nodeConfig when node has inline agents', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const agentsMap = {
      'brief-gen': {
        description: 'Summarises an issue',
        prompt: 'You are concise.',
        model: 'haiku',
        tools: ['Bash', 'Read'],
      },
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-agents',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              agents: agentsMap,
            },
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.agents).toEqual(agentsMap);
  });

  it('warns user when Codex DAG node has inline agents', async () => {
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
          name: 'dag-codex-agents',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              agents: {
                'brief-gen': { description: 'd', prompt: 'p' },
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
      "Warning: Node 'review' uses agents but codex doesn't support it — this will be ignored."
    );
  });
});

describe('executeDagWorkflow -- Claude SDK advanced options', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-sdk-opts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
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

  it('fails node when SDK returns error_max_budget_usd result', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_max_budget_usd',
        failure: { class: 'budget_exceeded', evidence: 'error_max_budget_usd' },
        sessionId: 'sid',
      };
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
          name: 'budget-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              maxBudgetUsd: 2.5,
            },
          ],
        },
        workflowRun,
      })
    );

    expect(
      (store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it('error message includes cost cap when maxBudgetUsd is set', async () => {
    // 'ok' runs first (no deps), then 'capped' runs after (depends_on: ['ok'])
    // This ensures both nodes run — 'ok' succeeds, 'capped' hits the budget cap
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // First call: 'ok' node succeeds
        yield { type: 'agent_message_chunk', text: 'done' };
        yield { type: 'result', sessionId: 'sid1' };
      } else {
        // Second call: 'capped' node hits budget cap
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_max_budget_usd',
          failure: { class: 'budget_exceeded', evidence: 'error_max_budget_usd' },
          sessionId: 'sid2',
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
          name: 'budget-msg-test',
          nodes: [
            { id: 'ok', kind: 'agent', source: { kind: 'inline', prompt: 'do work first' } },
            {
              id: 'capped',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              maxBudgetUsd: 2.5,
              depends_on: ['ok'],
            },
          ],
        },
        workflowRun,
      })
    );

    // The cap is recorded against the node that carried it, with the configured
    // amount — not merely "some message mentioned $2.50".
    const capped = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'capped'
    );
    expect(capped?.data?.error).toBe("Node 'capped' exceeded cost cap of $2.50.");
  });

  it('fails node when SDK returns error_during_execution result', async () => {
    // Regression test for #1208: previously we only failed on error_max_budget_usd
    // and silently broke on all other isError subtypes, letting failed nodes
    // masquerade as successes with empty output.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Tool call failed: permission denied'],
        sessionId: 'sid-err',
        cost: 0.04,
        tokens: { input: 70, output: 7, cacheRead: 30, cacheWrite: 0 },
      };
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
          name: 'err-exec-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
      })
    );

    // The node_failed event should carry the subtype and SDK errors detail
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('error_during_execution');
    expect(failedData.error).toContain('permission denied');
    expect(failedData.cost_usd).toBe(0.04);
    expect(failedData.tokens).toEqual({
      input: 70,
      output: 7,
      cacheRead: 30,
      cacheWrite: 0,
    });
    expect(runUsageWrites(store)).toEqual([
      {
        total_cost_usd: 0.04,
        total_tokens_in: 70,
        total_tokens_out: 7,
        total_cache_read_tokens: 30,
        total_cache_write_tokens: 0,
      },
    ]);
  });

  it('does NOT fail node when SDK returns isError: true + errorSubtype: success', async () => {
    // Regression test for #1425: stop_sequence terminations under the Claude
    // SDK contract carry is_error: true + subtype: 'success'. The provider
    // normalises this, but the executor keeps an explicit guard so a future
    // provider regression or a third-party IAgentProvider that forwards the
    // SDK pair raw cannot reintroduce the "SDK returned success" false-failure.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'classified output' };
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'success',
        stopReason: 'end_turn',
        sessionId: 'sid-stop',
      };
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
          name: 'success-stop-seq-test',
          nodes: [{ id: 'classify', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents).toHaveLength(0);

    const completeCalls = (store.completeWorkflowRun as ReturnType<typeof mock>).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
  });

  it('forwards workflow-level effort to node when no per-node override', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'workflow-effort-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          effort: 'high',
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('high');
  });

  it('per-node effort overrides workflow-level effort', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'node-effort-override-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              effort: 'max',
            },
          ],
          effort: 'low',
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('max');
  });

  // #2556 inverted this: `effort:` used to be treated as Claude-only and warned
  // about on a Codex node. It is now the one spelling and reaches Codex, so the
  // warning would be false and the value must actually be applied.
  it('applies node-level effort on a Codex node without warning', async () => {
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
          name: 'codex-claude-opts-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              provider: 'codex',
              effort: 'high',
            },
          ],
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(
      messages.find(m => m.includes('effort') && m.includes("doesn't support"))
    ).toBeUndefined();

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('high');
  });

  it('applies workflow-level effort to a Codex node', async () => {
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
          name: 'codex-workflow-effort-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          effort: 'xhigh',
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('xhigh');

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBe('xhigh');
  });

  it('applies the node-level effort; the deprecated field is inert at this layer', async () => {
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
        workflow: loaderBypassingWorkflow({
          name: 'codex-node-effort-beats-deprecated-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              effort: 'minimal',
            },
          ],
          modelReasoningEffort: 'high',
        }),
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('minimal');
  });

  it('forwards workflow-level webSearchMode to a Codex node', async () => {
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
          name: 'codex-workflow-options-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          // #2556: the loader translates `modelReasoningEffort:` into `effort:`,
          // so the executor only ever sees the canonical field. `webSearchMode:`
          // keeps its Codex gate and its assistantConfig home.
          effort: 'minimal',
          webSearchMode: 'live',
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    const assistantConfig = optionsArg?.assistantConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('minimal');
    expect(assistantConfig?.webSearchMode).toBe('live');
  });

  it('workflow-level effort beats a preset-routed effort, and node_started reports the applied value', async () => {
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
          name: 'codex-workflow-beats-preset-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
            },
          ],
          effort: 'xhigh',
        },
        workflowRun,
        aiProfile,
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('xhigh');

    // The write must land BEFORE resolvedEffort is captured, or the audit trail and
    // console report an effort the node did not run at.
    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBe('xhigh');
  });

  it('workflow-level modelReasoningEffort does not strip preset effort from a Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('claude', {
      repoTiers: {
        medium: { provider: 'claude', model: 'sonnet', effort: 'medium' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: loaderBypassingWorkflow({
          name: 'mixed-provider-preset-effort-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
            },
          ],
          // A definition that still carries the deprecated field — only a
          // loader-bypassing caller can produce one. It affects nothing: the
          // executor never reads it (the loader translates it away).
          modelReasoningEffort: 'high',
        }),
        workflowRun,
        aiProfile,
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    const assistantConfig = optionsArg?.assistantConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('medium');
    expect(assistantConfig?.modelReasoningEffort).toBeUndefined();
  });

  it('warns when workflow-level webSearchMode lands on a non-Codex node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'codex-options-on-claude-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          webSearchMode: 'live',
        },
        workflowRun,
      })
    );

    expect(deliveredMessages(platform)).toContain(
      "Warning: Node 'step1' uses webSearchMode but claude doesn't support it — this will be ignored."
    );

    // Nothing meaningless is written onto a provider that cannot read it.
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const assistantConfig = optionsArg?.assistantConfig as Record<string, unknown>;
    expect(assistantConfig?.webSearchMode).toBeUndefined();
  });

  it('ignores modelReasoningEffort entirely — the executor has no deprecated-field path', async () => {
    // #2556 resolves the deprecation in the LOADER: `modelReasoningEffort:` is
    // translated into `effort:` and never reaches here. Passing both directly to
    // `executeDagWorkflow` is something only a loader-bypassing caller can do,
    // and it pins the absence of any residual Codex branch for reasoning depth —
    // the executor applies `effort:` and does not look at the old field.
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
        workflow: loaderBypassingWorkflow({
          name: 'codex-effort-telemetry-test',
          nodes: [{ id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          effort: 'max',
          modelReasoningEffort: 'low',
        }),
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    const assistantConfig = optionsArg?.assistantConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('max');
    expect(assistantConfig?.modelReasoningEffort).toBeUndefined();

    const createEventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const nodeStartedCall = createEventCalls.find(([arg]) => arg.event_type === 'node_started');
    expect(nodeStartedCall?.[0].data?.effort).toBe('max');
  });

  it('warns when a node in a Codex workflow resolves away to Claude via a tier', async () => {
    // The mixed-provider direction: the workflow-level provider IS codex, so a check
    // against the CONFIGURED provider would stay silent. Only the resolved provider
    // reveals that this node cannot read `webSearchMode`.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const aiProfile = buildAiProfile('codex', {
      repoTiers: {
        medium: { provider: 'claude', model: 'sonnet' },
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'codex-workflow-node-resolves-to-claude-test',
          nodes: [
            {
              id: 'step1',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'medium',
            },
          ],
          webSearchMode: 'live',
        },
        workflowRun,
        workflowProvider: 'codex',
        aiProfile,
      })
    );

    expect(mockGetAgentProviderDag.mock.calls[0][0]).toBe('claude');

    expect(deliveredMessages(platform)).toContain(
      "Warning: Node 'step1' uses webSearchMode but claude doesn't support it — this will be ignored."
    );

    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const assistantConfig = optionsArg?.assistantConfig as Record<string, unknown>;
    expect(assistantConfig?.webSearchMode).toBeUndefined();
  });
});

describe('resolveNodeMcp', () => {
  let testDir: string;
  const claude = getProviderCapabilities('claude');
  const pi = getProviderCapabilities('pi');

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcp-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('hands no path to the provider when the node declares no mcp', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    expect(await resolveNodeMcp(undefined, claude, testDir)).toEqual({ kind: 'none' });
  });

  it('hands a required path to the provider even when the file is missing', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    expect(await resolveNodeMcp('missing.json', claude, testDir)).toEqual({
      kind: 'missing',
      path: join(testDir, 'missing.json'),
      servers: new Set(),
      diagnostic: missingMcpConfigMessage('missing.json', [join(testDir, 'missing.json')]),
    });
  });

  it('loads an optional declaration whose file exists, with its server names', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    const absolutePath = join(testDir, 'abs.json');
    await writeFile(absolutePath, JSON.stringify({ foo: {}, bar: {} }));
    const result = await resolveNodeMcp(
      { path: absolutePath, optional: true },
      claude,
      '/nonexistent/cwd'
    );
    expect(result).toEqual({ kind: 'load', path: absolutePath, servers: new Set(['foo', 'bar']) });
  });

  it('loads an optional home config beside its YAML when the checkout has none', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    const cwd = join(testDir, 'checkout');
    const yamlDir = join(testDir, 'home', 'workflows', 'nested');
    await mkdir(cwd, { recursive: true });
    await mkdir(yamlDir, { recursive: true });
    await writeFile(
      join(yamlDir, 'home.yaml'),
      'name: home-mcp\nnodes:\n  - id: check\n    prompt: Check\n    mcp:\n      path: servers.json\n      optional: true\n'
    );
    await writeFile(join(yamlDir, 'servers.json'), '{"home-server":{"command":"example"}}');

    const result = await resolveNodeMcp(
      { path: 'servers.json', optional: true },
      claude,
      cwd,
      yamlDir
    );

    expect(result).toEqual({
      kind: 'load',
      path: join(yamlDir, 'servers.json'),
      servers: new Set(['home-server']),
    });
    if (result.kind !== 'load') throw new Error('Missing optional home MCP config');
    expect((await loadMcpConfig(result.path, cwd)).serverNames).toEqual(['home-server']);
  });

  it('withholds an optional declaration whose file does not exist', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    expect(await resolveNodeMcp({ path: 'missing.json', optional: true }, claude, testDir)).toEqual(
      {
        kind: 'unavailable',
        fullPath: join(testDir, 'missing.json'),
        record: { path: 'missing.json', reason: 'config_missing' },
        diagnostic: missingMcpConfigMessage('missing.json', [join(testDir, 'missing.json')]),
      }
    );
  });

  it('withholds an optional declaration on a provider without MCP, naming its servers', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ posthog: {} }));
    const result = await resolveNodeMcp({ path: 'mcp.json', optional: true }, pi, testDir);
    expect(result).toMatchObject({
      kind: 'unavailable',
      record: { path: 'mcp.json', reason: 'provider_unsupported', servers: ['posthog'] },
    });
  });

  it('still hands a broken optional file to the provider, which reports it', async () => {
    const { resolveNodeMcp } = await import('./provider-resolution');
    await writeFile(join(testDir, 'broken.json'), '{ not-json');
    expect(await resolveNodeMcp({ path: 'broken.json', optional: true }, claude, testDir)).toEqual({
      kind: 'load',
      path: join(testDir, 'broken.json'),
      servers: new Set(),
    });
  });
});

// ---------------------------------------------------------------------------
// MCP plugin-noise filtering — end-to-end through executeDagWorkflow
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- home MCP paths', () => {
  let testDir: string;
  let yamlDir: string;
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dag-home-mcp-'));
    yamlDir = join(testDir, 'home', 'workflows', 'nested');
    setMockWorkflowHome(join(testDir, 'home', 'workflows'));
    await mkdir(yamlDir, { recursive: true });
    mockSendQueryDag.mockClear();
  });
  afterEach(async () => {
    setMockWorkflowHome('/nonexistent/home/workflows');
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'sess' };
    });
    await removeTempTree(testDir);
  });

  async function discoverHome(
    provider: string,
    sourceRoots?: ExecuteDagWorkflowOptions['workflowSourceRoots']
  ) {
    await writeFile(
      join(yamlDir, 'home.yaml'),
      `name: home-mcp
description: Home MCP
provider: ${provider}
nodes:
  - id: check
    prompt: Check
    mcp: servers.json
`
    );
    const catalog = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
      sourceRoots,
    });
    expect(catalog.errors).toEqual([]);
    const entry = catalog.workflows.find(e => e.workflow.name === 'home-mcp');
    if (!entry) throw new Error('Missing home workflow');
    return entry.workflow;
  }

  it.each([
    ['claude', ''],
    ['claude', 'nested'],
    ['claude', 'pack/flow'],
    ['codex', 'nested'],
  ])('hands the selected home config to the real loader for %s in %s', async (provider, subdir) => {
    yamlDir = join(mockWorkflowHome, subdir);
    await mkdir(yamlDir, { recursive: true });
    await writeFile(join(yamlDir, 'servers.json'), '{"home-server":{"command":"example"}}');
    const workflow = await discoverHome(provider);
    const loaded: string[][] = [];
    mockSendQueryDag.mockImplementation(async function* (_prompt, cwd, _session, options) {
      const path = options?.nodeConfig?.mcp;
      expect(path).toBe(join(yamlDir, 'servers.json'));
      if (!path) throw new Error('Missing provider MCP path');
      loaded.push((await loadMcpConfig(path, cwd)).serverNames);
      yield {
        type: 'mcp_server_status',
        server: 'home-server',
        status: 'failed',
        error: 'timeout',
      };
      yield { type: 'mcp_server_status', server: 'ambient', status: 'failed' };
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'sess' };
    });
    const platform = createMockPlatform();
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun(),
      })
    );
    expect(loaded).toEqual([['home-server']]);
    const sent = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls.map(
      c => c[1]
    );
    expect(sent).toContain('MCP server connection failed: home-server (failed): timeout');
    expect(sent.some(text => text.includes('ambient'))).toBe(false);
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it.each(['home', 'project'] as const)(
    'keeps required missing %s MCP classified and unretried, with all candidates',
    async source => {
      const homeWorkflow = await discoverHome('claude');
      const workflow =
        source === 'home'
          ? homeWorkflow
          : ({
              name: 'project',
              description: 'Project declaration',
              nodes: [
                {
                  id: 'check',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'Check' },
                  mcp: 'servers.json',
                },
              ],
            } satisfies WorkflowDefinition);
      let evidence: string | undefined;
      mockSendQueryDag.mockImplementation(async function* (_prompt, cwd, _session, options) {
        try {
          await loadMcpConfig(options!.nodeConfig!.mcp!, cwd);
          throw new Error('Expected missing config');
        } catch (error) {
          if (!(error instanceof Error) || !('failureClass' in error)) throw error;
          expect(error.failureClass).toBe('misconfigured');
          evidence = error.message;
          yield {
            type: 'result',
            isError: true,
            errors: [error.message],
            failure: { class: 'misconfigured', evidence: error.message },
          };
        }
      });
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow,
          workflowRun: makeWorkflowRun(),
        })
      );
      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      const failed = store.createWorkflowEvent.mock.calls
        .map(([e]) => e)
        .find(e => e.event_type === 'node_failed');
      expect(failed?.data?.provider_failure).toEqual({ class: 'misconfigured', evidence });
      expect(failed?.data?.failure_kind).toBe('fatal');
      const candidates = [
        join(testDir, 'servers.json'),
        ...(source === 'home' ? [join(yamlDir, 'servers.json')] : []),
      ];
      expect(failed?.data?.error).toContain(missingMcpConfigMessage('servers.json', candidates));
      expect(store.failWorkflowRun).toHaveBeenCalled();
    }
  );

  it('runs rediscovered captured home MCP after live removal, with checkout still first', async () => {
    await writeFile(join(yamlDir, 'servers.json'), '{"captured":{"command":"example"}}');
    await discoverHome('claude');
    const capture = await captureWorkflowSource({
      providers: providerRegistry,
      sourceRoot: testDir,
      captureRoot: join(testDir, 'capture'),
    });
    const roots = capturedSourceRoots(capture.anchor);
    await removeTempTree(join(testDir, 'home'));
    for (const checkoutWins of [false, false, true]) {
      if (checkoutWins)
        await writeFile(join(testDir, 'servers.json'), '{"checkout":{"command":"example"}}');
      const catalog = await discoverWorkflows(testDir, {
        providers: providerRegistry,
        loadDefaults: false,
        sourceRoots: roots,
      });
      expect(catalog.errors).toEqual([]);
      const entry = catalog.workflows.find(e => e.workflow.name === 'home-mcp');
      if (!entry) throw new Error('Missing captured workflow');
      const loaded: string[][] = [];
      mockSendQueryDag.mockImplementation(async function* (_prompt, cwd, _session, options) {
        const path = options?.nodeConfig?.mcp;
        expect(path).toBe(
          checkoutWins
            ? join(testDir, 'servers.json')
            : join(roots.globalWorkflows, 'nested', 'servers.json')
        );
        if (!path) throw new Error('Missing provider MCP path');
        loaded.push((await loadMcpConfig(path, cwd)).serverNames);
        yield { type: 'agent_message_chunk', text: 'ok' };
        yield { type: 'result', sessionId: 'sess' };
      });
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: entry.workflow,
          workflowRun: makeWorkflowRun(),
          workflowSourceRoots: roots,
        })
      );
      expect(loaded).toEqual([[checkoutWins ? 'checkout' : 'captured']]);
      expect(store.completeWorkflowRun).toHaveBeenCalled();
    }
  });

  it('refuses home config capture tampering before a later node reads it', async () => {
    await writeFile(join(yamlDir, 'servers.json'), '{"home":{"command":"example"}}');
    await discoverHome('claude');
    const capture = await captureWorkflowSource({
      providers: providerRegistry,
      sourceRoot: testDir,
      captureRoot: join(testDir, 'capture'),
    });
    const roots = capturedSourceRoots(capture.anchor);
    const workflow = await discoverHome('claude', roots);
    const homeNode = workflow.nodes[0];
    const capturedDir = readHomeMcpDirectory(homeNode);
    if (!capturedDir) throw new Error('Missing captured YAML directory');
    const nodes: DagNode[] = [
      {
        id: 'tamper',
        kind: 'exec',
        runtime: 'bun',
        script: `Bun.write(${JSON.stringify(join(capturedDir, 'servers.json'))}, '{}')`,
      },
      { ...homeNode, depends_on: ['tamper'] },
    ];
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: { ...workflow, nodes },
        workflowRun: makeWorkflowRun(),
        workflowSourceRoots: roots,
      })
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const failed = store.createWorkflowEvent.mock.calls
      .map(([e]) => e)
      .filter(e => e.event_type === 'node_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data?.error).toContain('captured source has changed');
  });
});

describe('executeDagWorkflow -- MCP failure filtering', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'cmd prompt');

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

  async function runWithEvents(
    events: MessageChunk[],
    nodeMcp?: NodeMcp,
    store: MockWorkflowStore = createMockStore()
  ): Promise<IWorkflowPlatform> {
    mockSendQueryDag.mockImplementation(async function* () {
      yield* events;
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'sess' };
    });

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-mcp-filter',
        cwd: testDir,
        workflow: {
          name: 'mcp-filter-test',
          nodes: [
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              ...(nodeMcp ? { mcp: nodeMcp } : {}),
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );
    return platform;
  }

  function nodeRows(
    store: MockWorkflowStore
  ): { event_type: string; data?: Record<string, unknown> }[] {
    return (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(call => call[0] as { event_type: string; data?: Record<string, unknown> })
      .filter(event => event.event_type.startsWith('node_'));
  }

  function mcpMessages(platform: IWorkflowPlatform): string[] {
    const calls = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls;
    return calls
      .map(c => c[1] as string)
      .filter(m => m.startsWith('MCP server connection failed:') || m.startsWith('⚠️'));
  }

  it('forwards only failures of servers the node configures, with their status', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithEvents(
      [
        {
          type: 'mcp_server_status',
          server: 'workflow-server',
          status: 'failed',
          error: 'timeout',
        },
        { type: 'mcp_server_status', server: 'telegram', status: 'failed' },
        { type: 'mcp_server_status', server: 'workflow-server', status: 'connected' },
      ],
      'mcp.json'
    );

    expect(mcpMessages(platform)).toEqual([
      'MCP server connection failed: workflow-server (failed): timeout',
    ]);
  });

  it.each([
    ['required', 'mcp.json'],
    ['optional', { path: 'mcp.json', optional: true }],
  ] as const)('hands a %s declaration whose file exists to the provider', async (_label, mcp) => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const store = createMockStore();
    await runWithEvents([], mcp, store);

    expect(mockSendQueryDag.mock.calls[0][3]?.nodeConfig?.mcp).toBe(join(testDir, 'mcp.json'));
    expect(nodeRows(store).every(row => row.data?.mcp_unavailable === undefined)).toBe(true);
  });

  it('runs an optional declaration whose file is missing without it, and records why', async () => {
    const store = createMockStore();
    const platform = await runWithEvents([], { path: 'absent.json', optional: true }, store);

    expect(mockSendQueryDag.mock.calls[0][3]?.nodeConfig?.mcp).toBeUndefined();
    const rows = nodeRows(store);
    expect(rows.map(row => row.event_type)).toEqual(['node_started', 'node_completed']);
    for (const row of rows) {
      expect(row.data?.mcp_unavailable).toEqual({ path: 'absent.json', reason: 'config_missing' });
    }
    const sent = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls.map(
      c => c[1] as string
    );
    expect(sent).toContain(
      `Node 'review' runs without its optional MCP servers (absent.json): ${missingMcpConfigMessage('absent.json', [join(testDir, 'absent.json')])}.`
    );
  });

  it('forwards a failure of a server declared inside the mcpServers wrapper', async () => {
    await writeFile(
      join(testDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'workflow-server': {} } })
    );
    const platform = await runWithEvents(
      [{ type: 'mcp_server_status', server: 'workflow-server', status: 'failed' }],
      { path: 'mcp.json', optional: true }
    );

    expect(mcpMessages(platform)).toEqual([
      'MCP server connection failed: workflow-server (failed)',
    ]);
  });

  it('forwards a configured server that needs authentication', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithEvents(
      [{ type: 'mcp_server_status', server: 'workflow-server', status: 'needs_auth' }],
      'mcp.json'
    );

    expect(mcpMessages(platform)).toEqual([
      'MCP server connection failed: workflow-server (needs_auth)',
    ]);
  });

  it('suppresses everything when node has no mcp: config (all failures are plugin noise)', async () => {
    const platform = await runWithEvents([
      { type: 'mcp_server_status', server: 'telegram', status: 'failed' },
    ]);

    expect(mcpMessages(platform)).toEqual([]);
  });

  it('shows a provider warning with a ⚠️ prefix', async () => {
    const platform = await runWithEvents([
      {
        type: 'warning',
        code: 'claude.model_mcp_unsupported',
        message: 'Haiku does not support MCP',
      },
    ]);

    expect(mcpMessages(platform)).toEqual(['⚠️ Haiku does not support MCP']);
  });

  it('in batch mode, sends the reply batched before a warning ahead of it', async () => {
    const platform = await runWithEvents([
      { type: 'agent_message_chunk', text: 'Plan written.' },
      { type: 'warning', code: 'pi.extension_notify', message: 'pi extension info: Open URL' },
    ]);

    const sent = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls.map(
      c => c[1] as string
    );
    const replyAt = sent.indexOf('Plan written.');
    const warningAt = sent.indexOf('⚠️ pi extension info: Open URL');
    expect(replyAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeGreaterThan(replyAt);
    expect(sent.at(warningAt + 1)).toBe('ok');
  });
});

describe('provider resolution -- regression for #1610', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
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

  it('node with no provider annotation routes to workflowProvider (codex), not to model-implied provider', async () => {
    // Regression: a node with model: opus[1m] but no provider: must route to
    // workflowProvider ('codex' when defaultAssistant: codex), not to 'claude'.
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
        conversationId: 'conv-provider',
        cwd: testDir,
        // Node has model: opus[1m] but NO provider: — must inherit workflowProvider
        workflow: {
          name: 'provider-regression',
          nodes: [
            {
              id: 'implement',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'opus[1m]',
            },
          ],
        },
        workflowRun,
        // Simulates defaultAssistant: codex.
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    // getAgentProvider must have been called with 'codex', not 'claude'
    expect(mockGetAgentProviderDag).toHaveBeenCalledWith('codex');
    expect(mockGetAgentProviderDag).not.toHaveBeenCalledWith('claude');
  });

  it('node with explicit provider: claude routes to claude even when workflowProvider is codex', async () => {
    // When provider: claude is set on the node, it must override workflowProvider.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-provider',
        cwd: testDir,
        // Node has both model: opus[1m] AND provider: claude
        workflow: {
          name: 'provider-explicit',
          nodes: [
            {
              id: 'implement',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              model: 'opus[1m]',
              provider: 'claude',
            },
          ],
        },
        workflowRun,
        workflowProvider: 'codex',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    // getAgentProvider must have been called with 'claude'
    expect(mockGetAgentProviderDag).toHaveBeenCalledWith('claude');
  });
});

describe('executeDagWorkflow -- a workflow-level provider/model conflict is reported once', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'sid' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('sends one message for a conflict the author declared once, not one per node', async () => {
    // The collapse writes the workflow's `provider` AND its tier `model` onto every node
    // (#1764), so a single authoring mistake reaches `resolveNodeProviderAndModel` N
    // times. Before de-duplication that was N identical chat warnings.
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [
          'conflict',
          // Each node is already parsed (flat -> resolved) — do NOT also route the
          // whole object through workflowDefinitionSchema.parse(): its `nodes` field
          // re-validates against the FLAT authored schema, which an already-resolved
          // DagNode (kind/source) no longer satisfies (#2486).
          {
            name: 'conflict',
            description: 'conflict',
            provider: 'claude',
            model: 'large',
            nodes: [
              dagNodeSchema.parse({ id: 'a', prompt: 'a' }),
              dagNodeSchema.parse({ id: 'b', prompt: 'b', depends_on: ['a'] }),
              dagNodeSchema.parse({ id: 'c', prompt: 'c', depends_on: ['b'] }),
            ],
          },
        ],
      ])
    );
    expect(errors).toEqual([]);

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform,
        conversationId: 'conv-conflict',
        cwd: testDir,
        workflow: ready(workflows.get('conflict')!),
        workflowRun: makeWorkflowRun('conflict-run', { workflow_name: 'conflict' }),
        aiProfile: buildAiProfile('claude', {
          repoTiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        }),
      })
    );

    const conflictMessages = platform.sendMessage.mock.calls
      .map(c => c[1])
      .filter(m => typeof m === 'string' && m.includes("resolves to provider 'codex'"));
    expect(conflictMessages).toHaveLength(1);
    // All three nodes still RESOLVED to codex — only the reporting is de-duplicated.
    expect(mockSendQueryDag.mock.calls).toHaveLength(3);
  });
});
