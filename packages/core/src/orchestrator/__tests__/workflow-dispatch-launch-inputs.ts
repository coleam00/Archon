import { expect, mock, spyOn, test } from 'bun:test';
import {
  capturedSourceOwnerCalls,
  makeCodebase,
  makeDispatchConversation,
  makeForegroundPlatform,
  makePlatform,
  makeResumableRun,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockListResumableRunsByParentConversation,
  mockGetCodebase,
  mockGetOrCreateConversation,
  mockHandleCommand,
  mockParseCommand,
  mockStartWorkflow,
  mockValidateAndResolveIsolation,
  operator,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';
import type { setupRoutingTests } from './workflow-dispatch-adoption';
export function registerLaunchInputTests(fixture: ReturnType<typeof setupRoutingTests>) {
  test('calls dispatchBackgroundWorkflow for a fresh run on a background-default adapter', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    const platform = { ...makePlatform(), getPlatformType: mock(() => 'matrix-chat') };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Declared inputs supplied by the run route (#2554)
  // -------------------------------------------------------------------------

  test('context.workflowName starts that workflow with the message verbatim, never parsed as a command', async () => {
    // A message that would be a command, and would set --force, if it were parsed (#4159).
    const message = '/detach-project "acme" --force\n  keep this indent';
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockStartWorkflow.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: message }))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', message, {
      actor: operator,
      workflowName: 'test-workflow',
      workflowInputs: { diff: 'D1' },
    });

    expect(mockParseCommand).not.toHaveBeenCalled();
    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: makeDispatchConversation().id }),
      'test-workflow',
      message,
      false,
      platform
    );
    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as {
      originalMessage: string;
      inputs?: Record<string, string>;
    };
    expect(ctx.originalMessage).toBe(message);
    expect(ctx.inputs).toEqual({ diff: 'D1' });
  });

  test('threads context.workflowInputs into executeWorkflow for a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1' },
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const opts = mockExecuteWorkflow.mock.calls[0][7] as { inputs?: Record<string, string> };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  test('threads context.workflowInputs into dispatchBackgroundWorkflow — the console default path', async () => {
    // Fresh web runs never touch the executeWorkflow branches, so dropping
    // the map here would ship a console run form that silently does nothing.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1' },
    });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as {
      inputs?: Record<string, string>;
    };
    expect(ctx.inputs).toEqual({ diff: 'D1' });
  });

  test('a fresh run reads launch AI config from the registered checkout, not the conversation worktree', async () => {
    // The conversation already sits in a worktree holding only committed config; the
    // registered checkout carries an uncommitted codex selection.
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const loadConfig = mock(async (cwd?: string) => ({
      ...(await original.loadConfig(cwd)),
      assistant: cwd === '/repos/test-repo' ? 'codex' : 'claude',
    }));
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      loadConfig,
    }));
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeDispatchConversation({ cwd: '/worktrees/conv' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    try {
      await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
        actor: operator,
      });
      expect(loadConfig).toHaveBeenCalledWith('/repos/test-repo');
      expect(loadConfig).not.toHaveBeenCalledWith('/worktrees/conv');
      const opts = mockExecuteWorkflow.mock.calls[0]?.[7] as {
        preparedAiConfiguration?: { config: { assistant: string } };
      };
      expect(opts.preparedAiConfiguration?.config.assistant).toBe('codex');
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('foreground credential refusal stops before isolation or execution', async () => {
    const adapter = await import('../../workflows/store-adapter');
    const original = adapter.createWorkflowDeps();
    const factory = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original,
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async () => ({
        kind: 'api_key',
        getStatus: async () => ({ state: 'unusable', source: 'archon', evidence: 'cannot read' }),
      }),
    }));
    const platform = makeForegroundPlatform();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    try {
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: { kind: 'user', userId: 'origin' },
      });
      expect(platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n')).toContain(
        'credential cannot be used: cannot read'
      );
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
      (adapter.createWorkflowDeps as ReturnType<typeof mock>).mockImplementation(() => original);
    }
  });

  test('foreground forge refusal stops before isolation or execution, reading the registered checkout', async () => {
    const forgeAccess = await import('@archon/workflows/run-forge-access');
    const refusal = new forgeAccess.ForgeRequirementError('test-workflow', 'factory', [
      { reason: 'no_forge_remote', message: 'the checkout has no git remote' },
    ]);
    const assertForge = spyOn(forgeAccess, 'assertRunForgeAccess').mockRejectedValue(refusal);
    const platform = makeForegroundPlatform();
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeDispatchConversation({ cwd: '/worktrees/conv' }))
    );
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    try {
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });
      expect(assertForge.mock.calls[0]?.[3]).toMatchObject({
        cwd: '/repos/test-repo',
        settingsCwd: '/repos/test-repo',
      });
      expect(platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n')).toContain(
        '(no_forge_remote)'
      );
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    } finally {
      assertForge.mockRestore();
    }
  });

  test('a fresh foreground run starts with the inputs naming the repository the forge check judged', async () => {
    const forgeAccess = await import('@archon/workflows/run-forge-access');
    const assertForge = spyOn(forgeAccess, 'assertRunForgeAccess').mockResolvedValue({
      repo_host: 'github.com',
      repo_path: 'o/project',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    try {
      await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
        actor: operator,
      });
      const opts = mockExecuteWorkflow.mock.calls[0]?.[7] as { inputs?: unknown };
      expect(opts.inputs).toEqual({ repo_host: 'github.com', repo_path: 'o/project' });
    } finally {
      assertForge.mockRestore();
    }
  });

  test('threads context.workflowModelOverrides into a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: { tiers: { large: 'openai/gpt-5.6' } },
    });

    const opts = mockExecuteWorkflow.mock.calls[0][7] as { modelOverrideLayer?: unknown };
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  test('threads context.workflowModelOverrides into the console background path', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: { aliases: { '@planner': 'codex/gpt-5.6-sol' } },
    });

    const ctx = mockDispatchBackgroundWorkflow.mock.calls[0][0] as { modelOverrides?: unknown };
    expect(ctx.modelOverrides).toEqual({
      aliases: { '@planner': 'codex/gpt-5.6-sol' },
    });
  });

  test('threads context.workflowRunConfig into fresh foreground and background runs', async () => {
    const runConfig = {
      source: { kind: 'http' as const, label: 'inline' },
      layer: { docsPath: 'handbook' },
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.runConfig).toEqual(runConfig);

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });
    expect(mockDispatchBackgroundWorkflow.mock.calls[0]?.[0]?.runConfig).toEqual(runConfig);
  });

  test('refuses a required-input workflow when nothing is supplied, starting nothing', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    expect(sent).toContain('--input');
    expect(sent).not.toContain('reusable block');
  });

  // The run route's start: a workflow name and an empty message. The route has no rule of
  // its own, so this gate is what refuses it, with the text CLI admission also prints.
  test('refuses a run-route start with an empty message that misses a required input', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockStartWorkflow.mockReturnValueOnce(
      Promise.resolve(
        fixture.makeWorkflowResult({ args: '', inputs: { issue: { required: true } } })
      )
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '', { actor: operator, workflowName: 'test-workflow' });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'issue'");
  });

  test('hands the capture to a fresh foreground run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'hold:/capture', 'adopt', 'adopt']);
  });

  test('keeps holding the capture when the dispatch refuses after taking it', async () => {
    // The invocation gate fires AFTER the capture, so every refusal past that point has a
    // frozen tree to reclaim. Nothing starts, so nothing owns it.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'reclaim:/capture']);
  });

  test('a continuation takes no capture at all', async () => {
    // It executes the source its run already froze. Capturing here would freeze current
    // bytes the run never agreed to AND leave a staged tree nothing adopts.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockListResumableRunsByParentConversation.mockReturnValueOnce(
      Promise.resolve([makeResumableRun({ id: 'paused-run', status: 'paused' })])
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(prepareWorkflowSource).not.toHaveBeenCalled();
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  test('refuses an undeclared supplied key, starting nothing', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D1', stlye: 'terse' },
    });

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('stlye');
  });
}
