import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  deliveredMessages,
  makeWorkflowRun,
  minimalConfig,
  mockCodexCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import { buildAiProfile } from '../../../../model-validation';
import type { setupToolRestrictionsTests } from './agent-tool-config';

export function registerToolPromptTests(fixture: ReturnType<typeof setupToolRestrictionsTests>) {
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
        cwd: fixture.testDir,
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
        cwd: fixture.testDir,
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
        cwd: fixture.testDir,
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
        cwd: fixture.testDir,
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
        cwd: fixture.testDir,
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
}

export function registerPromptSubstitutionTests() {
  describe('executeDagWorkflow -- AI node prompt substitution failure', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-subst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
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
}
