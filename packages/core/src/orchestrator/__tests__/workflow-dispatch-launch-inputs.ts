import { expect, mock, spyOn, test } from 'bun:test';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import {
  CAPTURED_SOURCE_ROOTS,
  capturedSourceOwnerCalls,
  makeCodebase,
  makeDispatchConversation,
  makeForegroundPlatform,
  makePlatform,
  makeResumableRun,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetOrCreateConversation,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockInspectResumableRun,
  mockParseCommand,
  mockStartWorkflow,
  mockValidateAndResolveIsolation,
  operator,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';
import type { setupRoutingTests } from './workflow-dispatch-adoption';
export function registerLaunchInputTests(fixture: ReturnType<typeof setupRoutingTests>) {
  test('foreground_resume_detected: falls through to fresh run when hydration returns null', async () => {
    // When findResumableRunByParentConversation returns a run but
    // hydrateResumableRun finds nothing worth resuming (zero completed nodes,
    // no interactive-loop state), the orchestrator must NOT throw — it sends
    // a user-visible notice and starts a fresh run on the same worktree.
    // (#2686) The fresh run row must freeze its OWN workflow source — not
    // inherit the prior run's frozen graph against live commands/scripts.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(
      Promise.resolve(makeCodebase({ default_branch: 'develop' }))
    );
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd still points at the prior run's worktree.
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/feature');
    // Opts bag carries no resume payload — fresh run.
    const opts = callArgs[callArgs.length - 1] as {
      baseBranch?: string;
      preCreatedRun?: unknown;
      priorCompletedNodes?: unknown;
      preparedSource?: { anchor?: { root?: string }; manifest?: { captured_at?: string } };
    };
    expect(callArgs[6]).toMatchObject({
      conversationId: 'conv-1-db',
      parentConversationId: 'conv-1-db',
    });
    // The fresh-run-in-same-worktree branch still threads the codebase default.
    expect(opts.baseBranch).toBe('develop');
    expect(opts.preCreatedRun).toBeUndefined();
    expect(opts.priorCompletedNodes).toBeUndefined();
    // (#2686) This is the key regression assertion: the fresh run row carries
    // the captured source so its run row records `workflow_source` from this
    // moment, not the prior run's frozen bytes. Before the fix, `preparedSource`
    // was undefined here because the outer `if (!willContinueExistingRun)` block
    // was skipped.
    expect(opts.preparedSource).toBeDefined();
    expect(opts.preparedSource?.anchor?.root).toBe('/capture');
    expect(opts.preparedSource?.manifest?.captured_at).toBe('2026-08-21T00:00:00.000Z');
  });

  test('applies a run config when a resume candidate hydrates to a fresh run', async () => {
    const runConfig = {
      source: { kind: 'http' as const, label: 'inline' },
      layer: { docsPath: 'handbook' },
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ id: 'empty-config-run', status: 'paused' }))
    );
    mockInspectResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: runConfig,
    });

    expect(mockInspectResumableRun).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.runConfig).toEqual(runConfig);
    expect(platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n')).not.toContain(
      'a new run config cannot be applied'
    );
  });

  test('foreground_resume_detected: fresh-run-in-same-worktree refuses with the capture-failure message when prepareWorkflowSource rejects (#2686)', async () => {
    // The new capture call inside the resume-null fallback introduces a SECOND call site
    // of `captureFreshSource(...)` whose failure path is unexercised by the success-only
    // test above. A regression that drops `if (!captured) return;` or reorders the
    // user-visible notice would land uncaught without this test — `executeWorkflow`
    // would be called against an undefined capture and the user would see the generic
    // "starting fresh in the same worktree" notice instead of the capture-failure one.
    //
    // Note on the lifecycle: `captureFreshSource` calls `owner.hold` AFTER
    // `prepareWorkflowSource` returns, so a `prepareWorkflowSource` rejection skips
    // the hold entirely (no reclaim because nothing was held). The
    // `['hold:/capture', 'reclaim:/capture']` shape is exercised separately by the
    // "keeps holding the capture when the dispatch refuses after taking it" test
    // above — that one runs `prepareWorkflowSource` cleanly and trips a gate AFTER
    // the hold.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    (prepareWorkflowSource as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(new Error('disk full'))
    );

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    // No run started against an undefined capture.
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // The user-visible failure notice names the workflow and the underlying error.
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain(
      'Could not capture the workflow source for **test-workflow**: disk full'
    );
    // The generic "starting fresh in the same worktree" notice must NOT fire — that
    // would mislead the user into thinking a fresh run started when none did.
    expect(sent).not.toContain('starting fresh in the same worktree');
    // The capture was never held (rejection landed BEFORE `owner.hold`), so the
    // owner has nothing to reclaim.
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  test('foreground_resume_detected: fresh-run-in-same-worktree captures and executes the FRESHLY captured graph (#2686)', async () => {
    // (#2686) Regression for the mixed-vintage shape: when a paused run had nothing to
    // resume, the orchestrator must capture source here and execute the freshly resolved
    // graph — not the prior run's frozen definition against live command/script bytes.
    // Before the fix, the outer `if (!willContinueExistingRun)` block was skipped because
    // `willContinueExistingRun` was true, leaving `preparedSource` undefined and the
    // executor in `source_unprepared_live` mode against the prior run's frozen graph.
    const { prepareWorkflowSource } = await import('@archon/workflows/run-source');
    const freshWorkflow = makeTestResolvedWorkflow({
      name: 'test-workflow',
      description: 'freshly captured from disk',
    });
    // Capture returns a non-empty scope so the helper actually re-resolves the workflow.
    (prepareWorkflowSource as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.resolve({
        runId: 'prepared-run-id',
        origin: '/origin',
        manifest: {
          version: 1,
          engine_version: 'test',
          origin: '/origin',
          captured_at: '2026-08-21T00:00:00.000Z',
          digest: 'test-digest',
          file_count: 1,
          byte_count: 1,
          scopes: ['project'],
        },
        anchor: CAPTURED_SOURCE_ROOTS.anchor,
        roots: {
          project: '/capture/project',
          globalWorkflows: '/capture/global/workflows',
          globalCommands: '/capture/global/commands',
          globalScripts: '/capture/global/scripts',
          bundledWorkflows: '/capture/bundled/workflows',
          bundledCommands: '/capture/bundled/commands/defaults',
          kind: 'captured',
          anchor: CAPTURED_SOURCE_ROOTS.anchor,
        },
      })
    );
    // Discovery off the FRESH capture returns a workflow distinct from the one the
    // resume-input would otherwise feed executeWorkflow. If the orchestrator handed
    // `executeWorkflow` the wrong graph, the description below would mismatch.
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'test-workflow' })],
        errors: [],
      })
    );
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [{ workflow: freshWorkflow, source: 'project' }],
        errors: [],
      })
    );

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'empty-prior-run',
          status: 'paused',
        })
      )
    );
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(prepareWorkflowSource).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // The workflow argument (position 4) is the freshly resolved graph, NOT the
    // resume-input graph. Before the fix this was the prior run's frozen graph.
    expect(callArgs[4]).toBe(freshWorkflow);
    // A fresh run records launch AI config prepared here, not in the prior run's worktree.
    expect(
      (callArgs[7] as { preparedAiConfiguration?: unknown }).preparedAiConfiguration
    ).toBeDefined();
    // Capture lifecycle: hold then adopt — the prior branch's `if (preparedSource)
    // owner.adopt()` is now a live guard, not inert.
    expect(capturedSourceOwnerCalls).toEqual(['hold:/capture', 'adopt']);
    // The user-visible notice still fires.
    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('starting fresh in the same worktree');
  });

  test('calls dispatchBackgroundWorkflow for a fresh run on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

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
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ id: 'paused-run', status: 'paused' }))
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
