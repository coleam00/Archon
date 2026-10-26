import { expect, mock, spyOn, test } from 'bun:test';
import {
  DEFAULT_PROVIDER_CAPS,
  makeCodebase,
  makeDispatchConversation,
  makeForegroundPlatform,
  makeIsolationEnvironment,
  makePlatform,
  makeResumableRun,
  mockAdoptionMetadata,
  mockCreateWorkflowRun,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetOrCreateConversation,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockListCodebases,
  mockPrepareWorkflowSource,
  mockResolveWorkflowAdoption,
  mockResumedEnvironment,
  mockSendQuery,
  mockStartRunLiveOwner,
  mockValidateAndResolveIsolation,
  operator,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';
import type { setupRoutingTests } from './workflow-dispatch-adoption';
export function registerResumeSelectionTests(fixture: ReturnType<typeof setupRoutingTests>) {
  test('adopt and supersede together refuse before dispatch', async () => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
    const resolveAdoption = mockResolveWorkflowAdoption.getMockImplementation();
    if (!resolveAdoption) throw new Error('Missing adoption implementation');
    mockResolveWorkflowAdoption.mockResolvedValue({
      adoptedRun: makeResumableRun({ id: 'adopted-run', status: 'completed' }),
      lane: { kind: 'in-place' },
    });
    mockPrepareWorkflowSource.mockClear();
    const platform = makeForegroundPlatform();
    try {
      await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
        actor: operator,
        workflowAdoptRunId: 'adopted-run',
        workflowSupersedesRunId: 'replaced-run',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('adoptRunId and supersedesRunId are mutually exclusive')
      );
      expect(mockResolveWorkflowAdoption).not.toHaveBeenCalled();
      expect(mockHydrateResumableRun).not.toHaveBeenCalled();
      expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
      expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
      expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    } finally {
      mockResolveWorkflowAdoption.mockImplementation(resolveAdoption);
    }
  });

  test.each([
    { label: 'implicit continuation of a paused run', explicit: false },
    { label: 'explicit resume of a failed run', explicit: true },
  ])('supersede is refused before $label', async ({ explicit }) => {
    const run = makeResumableRun({ status: explicit ? 'failed' : 'paused' });
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(
      fixture.makeWorkflowResult(explicit ? { resumeRun: run } : {})
    );
    if (!explicit) mockFindResumableRunByParentConversation.mockResolvedValueOnce(run);
    mockPrepareWorkflowSource.mockClear();
    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining(
        `Cannot supersede run 'replaced-run': this conversation already continues run '${run.id}' (${run.status}). Resume or abandon that run first`
      )
    );
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(mockPrepareWorkflowSource).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test.each([false, true])('fresh supersede records provenance (force=%s)', async force => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult({ force }));
    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowRun.mock.calls[0][0]).toMatchObject({
      adopted_from_run_id: 'replaced-run',
      metadata: { continuation: { mode: 'supersede' } },
    });
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][7]).toMatchObject({
      adoptedFromRunId: 'replaced-run',
      continuationMode: 'supersede',
    });
  });

  test('fresh background supersede forwards provenance to dispatch', async () => {
    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
    await handleMessage(makePlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowSupersedesRunId: 'replaced-run',
    });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ supersedesRunId: 'replaced-run' }),
      expect.objectContaining({ name: 'test-workflow' })
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('adopt is refused when the workflow opts out of worktrees', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    const noWorktreeResult = fixture.makeWorkflowResult({ args: 'test message' });
    if (noWorktreeResult.workflow.kind !== 'start') throw new Error('expected start request');
    noWorktreeResult.workflow.definition.worktree = { enabled: false };
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(noWorktreeResult));
    mockResolveWorkflowAdoption.mockImplementationOnce(() =>
      Promise.resolve({
        adoptedRun: makeResumableRun({ id: 'prior-run', status: 'completed' }),
        lane: {
          kind: 'reuse-worktree',
          environment: makeIsolationEnvironment({ working_path: '/wt/adopted' }),
        },
      })
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', {
      actor: operator,
      workflowAdoptRunId: 'prior-run',
    });

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('disables worktrees')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('failed_resume_user_prompted: failed runs are not auto-resumed', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun())
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior failed run of **test-workflow**')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow resume resumable-run-1')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow abandon resumable-run-1')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow run test-workflow --force "test message"')
    );
  });

  test('failed_resume_user_prompted: stale running orphan gates with status-accurate copy', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    // findResumableRunByParentConversation also surfaces stale 'running' orphans,
    // not just 'failed' runs — the prompt must not mislabel them as "failed".
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(makeResumableRun({ status: 'running' }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    // Gate still fires (no silent auto-resume) ...
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('/workflow resume resumable-run-1')
    );
    // ... but the copy reflects the real status, not "failed".
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior interrupted run of **test-workflow**')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Discard the interrupted run')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('leave the interrupted run as-is')
    );
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('failed run')
    );
  });

  test('failed_resume_user_prompted: prompt includes normalized truncated prior prompt preview', async () => {
    const priorMessage = `line one\n${'x'.repeat(220)}`;
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'resumable-run-preview',
          user_message: priorMessage,
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const prompt = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain(`> line one ${'x'.repeat(151)}…`);
    expect(prompt).not.toContain('\nline one\n');
  });

  test('failed_resume_user_prompted: escapes backslash, double quote, and backtick in suggested commands', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ args: 'fix \\ path "quoted" `tick`' }))
    );
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          id: 'resumable-run-escape',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    const prompt = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain('/workflow run test-workflow "fix \\\\ path \\"quoted\\" \\`tick\\`"');
    expect(prompt).toContain(
      '/workflow run test-workflow --force "fix \\\\ path \\"quoted\\" \\`tick\\`"'
    );
  });

  test('--force flag: skips resume detection and dispatches a fresh run', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ force: true }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow --force', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/test/cwd');
  });

  test('resume request hydrates the requested run without latest-run lookup', async () => {
    mockAdoptionMetadata.mockClear();
    mockResumedEnvironment.mockResolvedValueOnce(makeIsolationEnvironment());
    const requestedRun = makeResumableRun({
      id: 'old-run',
      user_message: 'requested prompt',
      working_path: '/repos/test-repo/worktrees/old',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ resumeRun: requestedRun }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume old-run', { actor: operator });

    expect(mockAdoptionMetadata.mock.calls).toEqual([
      [
        'env-1',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-1' }),
      ],
    ]);
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'old-run' }),
      undefined
    );
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/old');
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Found a prior failed run')
    );
  });

  test('resume request reports requested run with missing working path', async () => {
    const requestedRun = makeResumableRun({
      id: 'old-run-missing-path',
      user_message: 'requested prompt',
      working_path: null,
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ resumeRun: requestedRun }))
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow resume old-run-missing-path', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Cannot resume old-run-missing-path: missing working path.'
    );
  });

  for (const entry of ['slash command', 'batch invocation', 'stream invocation'] as const) {
    for (const [label, actor, starter, role, allowed] of [
      ['other member', { kind: 'user', userId: 'member-b' }, 'starter-a', 'member', false],
      ['unidentified', { kind: 'unidentified' }, 'starter-a', undefined, false],
      ['null starter', { kind: 'user', userId: 'member-b' }, null, 'member', false],
      ['starter', { kind: 'user', userId: 'starter-a' }, 'starter-a', 'member', true],
      ['admin', { kind: 'user', userId: 'admin-b' }, 'starter-a', 'admin', true],
      ['operator', { kind: 'operator' }, null, undefined, true],
    ] as const) {
      test(`implicit continuation authorization: ${entry}, ${label}`, async () => {
        const users = await import('../../db/users');
        const lookup = spyOn(users, 'getUserById').mockResolvedValue(
          role
            ? {
                id: actor.kind === 'user' ? actor.userId : 'unused',
                role,
                display_name: null,
                email: null,
                created_at: new Date(),
                updated_at: new Date(),
              }
            : null
        );
        const run = makeResumableRun({ status: 'paused', user_id: starter });
        mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
        mockGetCodebase.mockResolvedValueOnce(makeCodebase());
        mockFindResumableRunByParentConversation.mockResolvedValueOnce(run);
        mockValidateAndResolveIsolation.mockClear();
        const providers = await import('@archon/providers');
        const caps = providers.getProviderCapabilities as ReturnType<typeof mock>;
        caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: true });
        const platform = makeForegroundPlatform();
        if (entry === 'slash command')
          mockHandleCommand.mockResolvedValueOnce(fixture.makeWorkflowResult());
        else {
          mockListCodebases.mockResolvedValue([makeCodebase()]);
          platform.getStreamingMode.mockReturnValue(
            entry === 'stream invocation' ? 'stream' : 'batch'
          );
          mockSendQuery.mockImplementationOnce(async function* (_prompt, _cwd, _session, options) {
            const tool = options?.nativeTools?.find(t => t.name === 'invoke_workflow');
            if (!tool) throw new Error('Missing workflow launch tool');
            const result = await tool.handler({
              workflow: 'test-workflow',
              project: 'test-repo',
              prompt: 'Continue the workflow',
            });
            expect(result).toContain('Queued');
            yield { type: 'agent_message_chunk', text: 'Continuing.' };
            yield { type: 'result', sessionId: 'session-1' };
          });
        }
        try {
          await handleMessage(
            platform,
            'conv-1',
            entry === 'slash command' ? '/workflow run test-workflow' : 'Continue the workflow',
            { actor }
          );
          if (allowed) {
            expect(mockStartRunLiveOwner).toHaveBeenCalledWith(run.id);
            expect(mockHydrateResumableRun).toHaveBeenCalled();
            expect(mockExecuteWorkflow).toHaveBeenCalled();
          } else {
            expect(platform.sendMessage).toHaveBeenCalledWith(
              'conv-1',
              expect.stringContaining(
                starter
                  ? 'Only the user who started this run or an admin'
                  : 'This run has no recorded starter'
              )
            );
            expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
            expect(mockHydrateResumableRun).not.toHaveBeenCalled();
            expect(mockExecuteWorkflow).not.toHaveBeenCalled();
            expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
          }
        } finally {
          lookup.mockRestore();
          caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
        }
      });
    }
  }

  test('foreground_resume_detected: preserves origin when a paused run exists', async () => {
    // Regression for the foreground-resume branch: when
    // findResumableRunByParentConversation returns a paused run, the
    // orchestrator must hydrate it (single DB roundtrip — no second
    // findResumableRun) and hand the resumed run + priorCompletedNodes to
    // executeWorkflow via opts.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(
      Promise.resolve(makeCodebase({ default_branch: 'develop' }))
    );
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          status: 'paused',
        })
      )
    );

    const platform = makeForegroundPlatform();
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow', { actor: operator });

    expect(mockHydrateResumableRun).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd (position 3) should come from the resumable run's working_path.
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/feature');
    // Resume payload lives on the opts bag (the trailing arg).
    const opts = callArgs[callArgs.length - 1] as {
      baseBranch?: string;
      preCreatedRun?: { id: string };
      priorCompletedNodes?: Map<string, string>;
    };
    expect(callArgs[6]).toMatchObject({
      conversationId: 'conv-1',
      parentConversationId: 'conv-1',
    });
    // Resume dispatch carries the codebase default as the $BASE_BRANCH fallback too.
    expect(opts.baseBranch).toBe('develop');
    expect(opts.preCreatedRun?.id).toBe('resumable-run-1');
    expect(opts.priorCompletedNodes?.size).toBeGreaterThan(0);
  });

  test('a plain workflow run does not consume an attention pause', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(fixture.makeWorkflowResult()));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve(
        makeResumableRun({
          status: 'paused',
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'rerun-ci',
              kind: 'attention',
              waitingSince: '2026-09-01T10:00:00.000Z',
              message: 'Re-run the failing check, then resume.',
            },
          },
        })
      )
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', '/workflow run test-workflow', {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).toHaveBeenCalled();
    expect(mockHydrateResumableRun).not.toHaveBeenCalled();
  });

  test('an explicit workflow resume consumes an attention pause', async () => {
    const requestedRun = makeResumableRun({
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-09-01T10:00:00.000Z',
          message: 'Re-run the failing check, then resume.',
        },
      },
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeCodebase()));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve(fixture.makeWorkflowResult({ resumeRun: requestedRun }))
    );

    await handleMessage(makeForegroundPlatform(), 'conv-1', `/workflow resume ${requestedRun.id}`, {
      actor: operator,
    });

    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: requestedRun.id }),
      undefined
    );
  });
}
