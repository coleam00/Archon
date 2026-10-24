import { expect, mock, test } from 'bun:test';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import {
  CAPTURED_SOURCE_ROOTS,
  makeCodebase,
  makeDispatchConversation,
  makeForegroundPlatform,
  makePlatform,
  makeResumableRun,
  mockCloseRunLiveOwner,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetOrCreateConversation,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockInspectResumableRun,
  mockLogger,
  mockResolveContinuationWorkflow,
  mockStartRunLiveOwner,
  mockWithRunLiveOwner,
  operator,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';
import type { setupRoutingTests } from './workflow-dispatch-adoption';
export function registerResumeInputTests(fixture: ReturnType<typeof setupRoutingTests>) {
  test('an IMPLICIT auto-resume of a required-input workflow is not re-gated', async () => {
    // The dangerous case: a plain `/workflow run <name>` (a start request) on a
    // workflow with a paused run. `dispatchOrchestratorWorkflow` auto-detects that run
    // for every platform, so gating only against an EXPLICIT resume refused a legitimate
    // continuation — the run row already holds its validated inputs, and a user saying
    // "run it" again supplies nothing. Reachable from chat and from a repeat
    // POST /api/workflows/:name/run that reuses a conversation id.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-resume-1',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('implicit-resume-1');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][3]).toBe('/repos/test-repo/worktrees/paused');
  });

  test('tells the caller when supplied inputs could not be applied to an auto-resumed run', async () => {
    // The resume replays its own row's inputs; values supplied on this call cannot
    // reach it. Accepting them and silently running something else is the failure this
    // guards — the caller gets a 200 and no way to tell their values were dropped.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-resume-2',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowInputs: { diff: 'D-new' },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('not applied');
    expect(sent).toContain('diff');
    expect(sent).toContain('implicit-resume-2');
    // Names only — a supplied value is user content and must never be echoed back.
    expect(sent).not.toContain('D-new');
    // The resume still proceeds; the run holds real work and a worktree.
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('tells the caller when model bindings could not be applied to an auto-resumed run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-model-resume',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowModelOverrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('were not applied');
    expect(sent).toContain('@planner, large');
    expect(sent).toContain('implicit-model-resume');
    expect(sent).not.toContain('openai/gpt-5.6');
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow.mock.calls[0]?.[7]?.modelOverrideLayer).toBeUndefined();
  });

  test('refuses a new run config when the command would auto-resume existing work', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'implicit-config-resume',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowRunConfig: {
        source: { kind: 'http', label: 'inline' },
        layer: { docsPath: 'handbook' },
      },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('a new run config cannot be applied');
    expect(sent).toContain('force a fresh run');
    expect(mockInspectResumableRun).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('uses the actual state when explicit resume ignores supplied model bindings', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(
        fixture.makeWorkflowResult({
          resumeRun: makeResumableRun({ id: 'failed-model-resume', status: 'failed' }),
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume failed-model-resume', {
      actor: operator,
      workflowModelOverrides: { tiers: { large: 'openai/gpt-5.6' } },
    });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('Resuming the failed run');
    expect(sent).not.toContain('Resuming the paused run');
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('re-raises the deferred input error when hydration finds nothing to resume', async () => {
    // The gate defers a contract violation while a continuation looks possible. This is
    // the ONE branch where that prediction turns out wrong — hydration returns null, so
    // a FRESH run row gets created after all — and the deferred error has to come back.
    // Without the re-raise, a required-input workflow would silently start with the
    // input never supplied and never validated: neither a safe refusal nor a real resume.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'nothing-to-resume-1',
          working_path: '/repos/test-repo/worktrees/paused',
          status: 'paused',
        })
      )
    );
    // Nothing worth resuming → the fresh-run fallthrough.
    mockHydrateResumableRun.mockReturnValueOnce(Promise.resolve(null));
    const capturedWorkflow = makeTestResolvedWorkflow({
      name: 'test-workflow',
      inputs: { diff: { required: true } },
    });
    mockResolveContinuationWorkflow.mockResolvedValueOnce({
      workflow: capturedWorkflow,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: capturedWorkflow, source: 'project' }],
      errors: [],
    });

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    // Must NOT reach the generic "starting fresh in the same worktree" dispatch.
    expect(sent).not.toContain('starting fresh in the same worktree');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('nothing-to-resume-1');
    expect(mockCloseRunLiveOwner).toHaveBeenCalledTimes(1);
    expect(mockWithRunLiveOwner).not.toHaveBeenCalled();
  });

  test('reports a deferred input error on a lost resume race when values were supplied', async () => {
    // The last exit that can abandon the dispatch after the gate deferred. The caller
    // supplied an undeclared key, so the violation is about something they actually did
    // and is worth surfacing — it is never re-raised anywhere else on this path.
    const platform = makePlatform();
    await fixture.dispatchLosingResumeRace(platform, { stlye: 'terse' });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('already being resumed');
    expect(sent).toContain('stlye');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('stays quiet about the deferred error on a lost race when nothing was supplied', async () => {
    // With nothing supplied the deferred violation is just "you must supply X", which is
    // moot when nothing will run. Appending it unconditionally produced nonsense on chat:
    // a demand to pass `--input`, immediately followed by a note that chat cannot, tacked
    // onto a message whose first line is already "No action taken".
    const platform = makePlatform();
    await fixture.dispatchLosingResumeRace(platform);

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('already being resumed');
    expect(sent).not.toContain('--input');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('a resume refused for capacity says so and starts no fresh run', async () => {
    const { WorkflowResourceBusyError } = await import('../../db/workflows');
    const platform = makePlatform();
    await fixture.dispatchLosingResumeRace(
      platform,
      undefined,
      new WorkflowResourceBusyError('raced-run-1', { kind: 'run', id: 'holder-1' }, 'paused')
    );

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain('**test-workflow** cannot resume yet.');
    expect(sent).toContain("resource owner 'holder-1' has priority. It stays paused");
    expect(sent).not.toContain('Error:');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'raced-run-1', refusal: 'paused' }),
      'orchestrator.resume_resource_busy'
    );
  });

  test('refuses immediately when the resumable run is not a continuation candidate', async () => {
    // A FAILED (non-paused) prior run is not continued — the user gets a
    // resume/abandon/force menu. Deferring the gate for that case swallowed the input
    // error entirely: the caller saw a generic menu and was never told which input was
    // wrong. Such an invocation must be refused up front, before isolation resolution.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ inputs: { diff: { required: true } } }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'failed-prior-1',
          working_path: '/repos/test-repo/worktrees/failed',
          status: 'failed',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // Refused at the gate, so the resume menu never rendered and no isolation ran.
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('a resume of a required-input workflow is not re-gated', async () => {
    // The row already carries inputs validated at creation; re-gating with nothing
    // supplied would make every such resume impossible — a regression this feature
    // would otherwise introduce.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(
        fixture.makeWorkflowResult({
          inputs: { diff: { required: true } },
          resumeRun: makeResumableRun({ status: 'paused' }),
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const sent = platform.sendMessage.mock.calls.map(c => String(c[1])).join('\n');
    expect(sent).not.toContain("requires input 'diff'");
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('web workflow with resumable run resumes foreground (not background)', async () => {
    // Pins the priority order: resume detection comes before the background-dispatch
    // gate. If a resumable run exists, web workflows must resume foreground rather
    // than dispatching a fresh background run, or they would lose the paused run's
    // worktree state.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'web-noninteractive-resume-1',
          working_path: '/repos/test-repo/worktrees/web-feature',
          status: 'paused',
        })
      )
    );

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/web-feature');
  });

  test('a background-default adapter workflow with resumable run resumes foreground (not background)', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'web-noninteractive-resume-1',
          working_path: '/repos/test-repo/worktrees/web-feature',
          status: 'paused',
        })
      )
    );

    const platform = { ...makePlatform(), getPlatformType: mock(() => 'matrix-chat') };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/web-feature');
  });

  test('calls executeWorkflow on a non-web foreground platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('chat resume: resumes a paused run on chat platform when one exists', async () => {
    // Regression for #1741: chat platforms (slack/telegram/discord/github) used
    // to skip the resume lookup entirely and always start a fresh run, losing
    // the prior worktree and re-asking approval questions indefinitely. The
    // resume lookup must now run for ALL platforms; if a prior run is paused
    // or failed-by-approval, executeWorkflow runs on the prior worktree with
    // hydrated state.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'chat-resume-run-1',
          working_path: '/repos/test-repo/worktrees/chat-feature',
          status: 'paused',
        })
      )
    );

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'telegram' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd (position 3) is the prior run's working_path, not a fresh resolution
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/chat-feature');
    const opts = callArgs[callArgs.length - 1] as {
      preCreatedRun?: { id: string };
      priorCompletedNodes?: Map<string, string>;
    };
    expect(opts.preCreatedRun?.id).toBe('chat-resume-run-1');
    expect(opts.priorCompletedNodes?.size).toBeGreaterThan(0);
  });

  test('scopes resume query to (workflow, conversation, codebase)', async () => {
    // Persistent chat conversation IDs (Telegram chat_id, Slack thread) can
    // accumulate runs from multiple projects. The resume lookup must include
    // codebase_id so a fresh invocation for project A never resumes a stale
    // run from project B.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockFindResumableRunByParentConversation).toHaveBeenCalledWith(
      'test-workflow',
      'conv-1-db',
      'codebase-1'
    );
  });

  test('starts fresh run when no resumable run exists on chat platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    // Default mock returns null — no resumable run

    const platform = {
      ...makeForegroundPlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'discord' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd comes from validateAndResolveIsolation (default '/test/cwd'), not a prior worktree
    expect(callArgs[3]).toBe('/test/cwd');
    const opts = callArgs[callArgs.length - 1] as {
      preCreatedRun?: unknown;
      priorCompletedNodes?: unknown;
    };
    expect(opts.preCreatedRun).toMatchObject({
      id: 'prepared-run-id',
      status: 'pending',
      working_path: null,
    });
    expect(opts.priorCompletedNodes).toBeUndefined();
  });
}
