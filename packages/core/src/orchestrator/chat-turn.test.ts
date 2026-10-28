// @archon-test-isolated
/** Covers chat-turn.ts, mostly through `handleMessage`; shared mocks live in `../test/orchestrator-agent-harness`. */
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { IPlatformAdapter } from '../types';
import {
  canonicalizeProjectPath,
  makeCodebase,
  makeConfig,
  makeConversation,
  makeMessage,
  makeNamedCodebase,
  makePlatform,
  makeSession,
  mockAddMessage,
  mockCaptureChatTurn,
  mockCreateCodebase,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockFindResumableRunByParentConversation,
  mockGetCodebase,
  mockGetCodebaseEnvVars,
  mockGetOrCreateConversation,
  mockGetPausedWorkflowRun,
  mockGetRecentWorkflowResultMessages,
  mockHandleCommand,
  mockListCodebases,
  mockLoadConfig,
  mockLogger,
  mockParseCommand,
  mockRegisterFolder,
  mockRegisterRepository,
  mockSendQuery,
  mockTransitionSession,
  mockUpdateConversation,
  mockUpdateSession,
  operator,
} from '../test/orchestrator-agent-harness';
import { handleMessage } from './orchestrator-agent';

// ─── Stale session ID clearing on error_during_execution ────────────────────

describe('stale session ID clearing on error_during_execution', () => {
  beforeEach(() => {
    mockUpdateSession.mockClear();
    mockTransitionSession.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockSendQuery.mockReset();
    mockLogger.warn.mockClear();
    mockGetRecentWorkflowResultMessages.mockReset();
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
  });

  for (const mode of ['stream', 'batch'] as const) {
    for (const status of ['failed', 'cancelled'] as const) {
      test(`${mode}: reports an unanswered ${status} tool without leaking output`, async () => {
        mockCaptureChatTurn.mockClear();
        mockSendQuery.mockImplementationOnce(async function* () {
          yield { type: 'agent_message_chunk', text: 'Starting the action.' };
          yield {
            type: 'tool_call_update',
            toolCallId: 'shell',
            status,
            output: 'private tool output',
          };
          yield { type: 'result', cost: 0.1, tokens: { input: 100, output: 10 } };
          yield { type: 'result', cost: 0.2, tokens: { input: 200, output: 20 } };
        });
        const platform = {
          ...makePlatform(),
          sendResultFooter: mock<NonNullable<IPlatformAdapter['sendResultFooter']>>(() =>
            Promise.resolve()
          ),
        };
        (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
        await handleMessage(platform, 'conv-1', 'launch the workflow', { actor: operator });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          expect.stringContaining('A tool failed or was cancelled')
        );
        expect(
          JSON.stringify((platform.sendMessage as ReturnType<typeof mock>).mock.calls)
        ).not.toContain('private tool output');
        expect(mockCaptureChatTurn).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'failed', tokensIn: 300, tokensOut: 30 })
        );
        expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
        expect(mockCaptureChatTurn.mock.calls[0]?.[0]?.costUsd).toBeCloseTo(0.3);
        const footer = platform.sendResultFooter.mock.calls[0]?.[1];
        expect(footer?.cost).toBeCloseTo(0.3);
        expect(footer?.tokens).toMatchObject({ input: 300, output: 30 });
      });

      test(`${mode}: assistant recovery takes precedence over a ${status} tool`, async () => {
        mockCaptureChatTurn.mockClear();
        mockSendQuery.mockImplementationOnce(async function* () {
          yield { type: 'tool_call_update', toolCallId: 'shell', status };
          yield {
            type: 'agent_message_chunk',
            text: 'The launch failed; please correct the workflow input.',
          };
        });
        const platform = makePlatform();
        (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
        await handleMessage(platform, 'conv-1', 'launch the workflow', { actor: operator });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          'The launch failed; please correct the workflow input.'
        );
        expect(mockCaptureChatTurn).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'completed' })
        );
      });
    }
  }

  test('handleStreamMode: clears session ID on error_during_execution result', async () => {
    // Simulate AI returning error_during_execution with a stale session ID
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        sessionId: 'stale-session-id',
      };
    });
    // transitionSession returns a session with an existing assistant_session_id
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({
        id: 'session-1',
        assistant_session_id: 'stale-session-id',
      })
    );

    const platform = makePlatform();
    // Use streaming mode
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    // updateSession should be called with null to clear the stale session ID
    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', null);
    // An error the provider did not confirm as a missing session is not retried.
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
  });

  test('handleBatchMode: clears session ID on error_during_execution result', async () => {
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        sessionId: 'stale-session-id',
      };
    });
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({
        id: 'session-1',
        assistant_session_id: 'stale-session-id',
      })
    );

    const platform = makePlatform();
    // batch is the default from makePlatform, but be explicit
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', null);
    // An error the provider did not confirm as a missing session is not retried.
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
  });

  const staleRejection = {
    type: 'result',
    isError: true,
    errorSubtype: 'error_during_execution',
    failure: { class: 'unknown', evidence: 'error_during_execution: evidence' },
    sessionId: 'stale-session-id',
    sessionNotFound: true,
  } as const;
  async function staleTurn(
    mode: 'stream' | 'batch',
    setup?: (platform: IPlatformAdapter) => void
  ): Promise<IPlatformAdapter> {
    mockCaptureChatTurn.mockClear();
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({ id: 'session-1', assistant_session_id: 'stale-session-id' })
    );
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
    setup?.(platform);
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    return platform;
  }
  const resumeArgs = (): unknown[] => mockSendQuery.mock.calls.map(call => call[2]);
  const errorReported = (): boolean =>
    mockLogger.warn.mock.calls.some(call => call[1] === 'ai_result_error');

  test.each(['stream', 'batch'] as const)(
    '%s mode: a stale resume completes the turn on a fresh session',
    async mode => {
      mockSendQuery
        .mockImplementationOnce(async function* () {
          yield staleRejection;
        })
        .mockImplementationOnce(async function* () {
          yield { type: 'agent_message_chunk', text: 'Fresh reply.' };
          yield { type: 'result', sessionId: 'fresh-id' };
        });
      const platform = await staleTurn(mode);

      expect(resumeArgs()).toEqual(['stale-session-id', undefined]);
      const updates = mockUpdateSession.mock.calls.map(call => call[1]);
      expect(updates.indexOf(null)).toBeGreaterThanOrEqual(0);
      expect(updates.indexOf(null)).toBeLessThan(updates.indexOf('fresh-id'));
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('could not be resumed')
      );
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Fresh reply.');
      expect(mockCaptureChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed' })
      );
      expect(errorReported()).toBe(false);
    }
  );

  test('a failed fresh-session notice does not stop the retry', async () => {
    mockSendQuery
      .mockImplementationOnce(async function* () {
        yield staleRejection;
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'Fresh reply.' };
        yield { type: 'result', sessionId: 'fresh-id' };
      });
    const platform = await staleTurn('stream', p => {
      (p.sendMessage as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('transport down'));
    });

    expect(resumeArgs()).toEqual(['stale-session-id', undefined]);
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Fresh reply.');
    expect(mockCaptureChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' })
    );
  });

  test.each(['stream', 'batch'] as const)(
    '%s mode: a stale rejection after output fails without a retry',
    async mode => {
      mockSendQuery.mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: 'Partial.' };
        yield staleRejection;
      });
      await staleTurn(mode);
      expect(resumeArgs()).toEqual(['stale-session-id']);
      expect(mockCaptureChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' })
      );
    }
  );

  test.each(['stream', 'batch'] as const)(
    '%s mode: a second stale rejection fails without another retry',
    async mode => {
      mockSendQuery.mockImplementation(async function* () {
        yield staleRejection;
      });
      await staleTurn(mode);
      expect(resumeArgs()).toEqual(['stale-session-id', undefined]);
      expect(mockCaptureChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' })
      );
      expect(errorReported()).toBe(true);
    }
  );

  test.each(['stream', 'batch'] as const)(
    '%s mode: a typed failure picks the advice from its class, not its words',
    async mode => {
      // The evidence reads like a usage limit; the provider classified an auth failure.
      mockSendQuery.mockImplementationOnce(async function* () {
        yield {
          type: 'result',
          isError: true,
          errors: ['usage limit reached · resets 4pm'],
          failure: { class: 'auth', evidence: 'usage limit reached · resets 4pm' },
        };
      });
      mockTransitionSession.mockResolvedValueOnce(
        makeSession({ id: 'session-1', assistant_session_id: null })
      );

      const platform = makePlatform();
      (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        (c: unknown[]) => c[1] as string
      );
      expect(
        sentMessages.some(m => m.startsWith('⚠️ The AI provider rejected its credentials'))
      ).toBe(true);
      expect(sentMessages.some(m => m.includes('AI usage limit reached'))).toBe(false);
    }
  );

  test('does NOT surface error to user on stop_sequence success (#1425)', async () => {
    // Regression test for #1425: stop_sequence terminations carry is_error:
    // true + subtype: 'success' under the Claude SDK contract. The Claude
    // provider normalises this so the orchestrator sees a clean MessageChunk
    // (no isError). This test locks in that contract — if a future change to
    // the orchestrator starts gating errors on stopReason itself, or if the
    // provider regresses, direct-chat users would once again see "Error:
    // success" surfaced via classifyAndFormatError.
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'classified' };
      // Post-fix shape from claude/result.ts: isError absent; stop_sequence maps to end_turn.
      yield {
        type: 'result',
        sessionId: 'sid-ok',
        stopReason: 'end_turn',
      };
    });
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({
        id: 'session-1',
        assistant_session_id: null,
      })
    );

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    // Session id should persist normally — the error path was not taken.
    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', 'sid-ok');
    // No user-facing error message should have been sent.
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    expect(sentMessages.some((m: string) => m.toLowerCase().includes('error'))).toBe(false);
  });

  test('does NOT surface error when a provider forwards raw SDK pair (defense-in-depth)', async () => {
    // Defense-in-depth: a third-party IAgentProvider that does not normalise
    // the SDK's stop_sequence-success pattern would yield isError: true +
    // errorSubtype: 'success'. The orchestrator guard must skip the error
    // path on subtype === 'success' so a non-Claude provider can't surface a
    // spurious error to the user via direct chat.
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'classified' };
      yield {
        type: 'result',
        sessionId: 'sid-ok',
        isError: true,
        errorSubtype: 'success',
        stopReason: 'end_turn',
      };
    });
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({
        id: 'session-1',
        assistant_session_id: null,
      })
    );

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', 'sid-ok');
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    expect(sentMessages.some((m: string) => m.toLowerCase().includes('error'))).toBe(false);
  });
});

// ─── Assistant prose has no side effects ───────────────────────────────────────

describe('assistant command examples are ordinary text', () => {
  beforeEach(() => {
    mockSendQuery.mockReset();
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockDispatchBackgroundWorkflow.mockClear();
    mockExecuteWorkflow.mockClear();
    mockTransitionSession.mockClear();
    mockGetRecentWorkflowResultMessages.mockReset();
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
    mockLoadConfig.mockReset();
    mockLoadConfig.mockImplementation(() => Promise.resolve(makeConfig()));
    mockGetPausedWorkflowRun.mockReset();
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
    mockFindResumableRunByParentConversation.mockReset();
    mockFindResumableRunByParentConversation.mockImplementation(() => Promise.resolve(null));
    mockParseCommand.mockReset();
    mockCreateCodebase.mockClear();
    mockRegisterRepository.mockClear();
  });

  for (const nativeTools of [false, true]) {
    for (const mode of ['stream', 'batch'] as const) {
      test(`harmless command prose: ${mode}, nativeTools=${nativeTools}`, async () => {
        const providers = await import('@archon/providers');
        const caps = providers.getProviderCapabilities as ReturnType<typeof mock>;
        const baseline = caps();
        caps.mockReturnValue({ ...baseline, nativeTools });
        const codebase = makeNamedCodebase('my-project');
        mockListCodebases.mockResolvedValue([codebase]);
        mockDiscoverWorkflowsWithConfig.mockResolvedValue({
          workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
          errors: [],
        });
        mockCaptureChatTurn.mockClear();
        mockRegisterFolder.mockClear();
        mockUpdateSession.mockClear();
        const chunks = [
          'Example:\n/invoke-work',
          String.raw`flow assist --project my-project --prompt "Fix the \"login\" bug"` + '\n',
          '/register-project --folder demo "/tmp/with spaces"\n',
          'Following answer.',
        ];
        mockSendQuery.mockImplementationOnce(async function* () {
          for (const text of chunks)
            yield { type: 'agent_message_chunk', text, continuesPreviousBlock: true };
          yield {
            type: 'tool_call',
            toolCallId: 'example',
            name: 'Bash',
            rawInput: { command: 'pwd' },
          };
          yield {
            type: 'tool_call_update',
            toolCallId: 'example',
            status: 'completed',
            output: 'done',
          };
          yield { type: 'warning', code: 'test_warning', message: 'Provider warning' };
          yield { type: 'result', sessionId: 'example-session' };
        });
        const platform = {
          ...makePlatform(),
          emitRetract: mock(async () => {}),
          sendStructuredEvent: mock<NonNullable<IPlatformAdapter['sendStructuredEvent']>>(
            async () => {}
          ),
        };
        platform.getStreamingMode.mockReturnValue(mode);
        try {
          await handleMessage(platform, 'conv-1', 'Explain these commands', { actor: operator });
          const output = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
            .map(c => c[1])
            .join('');
          expect(output).toContain(chunks.join(''));
          expect(output).toContain('Provider warning');
          expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
          expect(mockExecuteWorkflow).not.toHaveBeenCalled();
          expect(mockRegisterFolder).not.toHaveBeenCalled();
          expect(mockRegisterRepository).not.toHaveBeenCalled();
          expect(platform.emitRetract).not.toHaveBeenCalled();
          if (mode === 'stream') {
            expect(output).toContain('Bash');
            expect(platform.sendStructuredEvent.mock.calls.map(c => c[1].type)).toEqual([
              'tool_call',
              'tool_call_update',
              'result',
            ]);
          }
          expect(mockUpdateSession).toHaveBeenCalledWith('session-1', 'example-session');
          expect(mockCaptureChatTurn).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'completed' })
          );
        } finally {
          caps.mockReturnValue(baseline);
        }
      });
    }
  }
});

// ─── Chat turn telemetry (PR #1944 review T2) ────────────────────────────────

describe('chat turn telemetry', () => {
  beforeEach(() => {
    mockCaptureChatTurn.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetPausedWorkflowRun.mockReset();
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockExecuteWorkflow.mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockSendQuery.mockClear();
    mockUpdateConversation.mockClear();
    // Restore the default plain-chat AI response
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'test response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  test.each([
    [' tool output\n\nFinal answer', 'Final answer'],
    [' tool output', '🔧 Running tool output'],
  ])('batch keeps block identity across a warning: %j', async (tail, expected) => {
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '🔧 Running' };
      yield { type: 'warning', code: 'pi.extension_notify', message: 'Waiting' };
      yield { type: 'agent_message_chunk', text: tail, continuesPreviousBlock: true };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(platform.sendMessage).toHaveBeenNthCalledWith(1, 'conv-1', '⚠️ Waiting');
    expect(platform.sendMessage).toHaveBeenLastCalledWith('conv-1', expected);
  });

  test('batch truncation preserves a real answer in a warning-split indicator block', async () => {
    const answers = Array.from({ length: 19 }, (_, i) => `Answer ${i + 1}`);
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '🔧 Running' };
      yield { type: 'warning', code: 'pi.extension_notify', message: 'Waiting' };
      yield { type: 'agent_message_chunk', text: ' tool output', continuesPreviousBlock: true };
      yield { type: 'agent_message_chunk', text: '\n\nFinal answer', continuesPreviousBlock: true };
      for (const text of answers) yield { type: 'agent_message_chunk', text };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
    expect(platform.sendMessage).toHaveBeenNthCalledWith(1, 'conv-1', '⚠️ Waiting');
    expect(platform.sendMessage).toHaveBeenLastCalledWith(
      'conv-1',
      ['Final answer', ...answers].join('\n\n---\n\n')
    );
  });

  test.each([
    [18, 1],
    [19, 1],
    [20, 1],
    [21, 1],
    [19, 25],
  ])(
    'batch truncation keeps indicator continuations hidden with %i later blocks and %i fragments',
    async (count, fragments) => {
      const answers = Array.from({ length: count }, (_, i) => `Answer ${i + 1}`);
      mockSendQuery.mockImplementationOnce(async function* () {
        yield { type: 'agent_message_chunk', text: '🔧 Running' };
        yield { type: 'warning', code: 'pi.extension_notify', message: 'Waiting' };
        for (let i = 0; i < fragments; i++) {
          yield { type: 'agent_message_chunk', text: ' tool output', continuesPreviousBlock: true };
        }
        for (const text of answers) yield { type: 'agent_message_chunk', text };
      });
      const platform = makePlatform();
      (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
      expect(platform.sendMessage).toHaveBeenNthCalledWith(1, 'conv-1', '⚠️ Waiting');
      expect(platform.sendMessage).toHaveBeenLastCalledWith(
        'conv-1',
        answers.slice(-20).join('\n\n---\n\n')
      );
    }
  );

  test('captures exactly one completed chat turn for a plain conversation', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello there', { actor: operator });

    expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
    expect(mockCaptureChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'web',
        provider: 'claude',
        outcome: 'completed',
        durationMs: expect.any(Number),
      })
    );
  });

  test('passes provider-reported usage through to the chat turn capture', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'answer' };
      yield {
        type: 'result',
        sessionId: 'session-1',
        cost: 0.042,
        tokens: { input: 1200, output: 340 },
      };
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
    expect(mockCaptureChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'completed',
        costUsd: 0.042,
        tokensIn: 1200,
        tokensOut: 340,
      })
    );
  });

  test.each(['batch', 'stream'] as const)(
    'sums cost and tokens over every result of a %s turn',
    async mode => {
      mockGetOrCreateConversation.mockReturnValueOnce(
        Promise.resolve(makeConversation({ codebase_id: null }))
      );
      mockSendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'answer' };
        yield { type: 'result', cost: 0.1, tokens: { input: 100, output: 10 } };
        yield { type: 'result', cost: 0.2, tokens: { input: 200, output: 20 } };
      });
      const platform = {
        ...makePlatform(),
        getStreamingMode: mock<IPlatformAdapter['getStreamingMode']>(() => mode),
        sendResultFooter: mock<NonNullable<IPlatformAdapter['sendResultFooter']>>(() =>
          Promise.resolve()
        ),
      };
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
      const footer = platform.sendResultFooter.mock.calls[0]?.[1];
      expect(footer?.cost).toBeCloseTo(0.3);
      expect(footer?.tokens).toMatchObject({ input: 300, output: 30 });
      expect(mockCaptureChatTurn.mock.calls[0]?.[0]).toMatchObject({
        tokensIn: 300,
        tokensOut: 30,
      });
      expect(mockCaptureChatTurn.mock.calls[0]?.[0]?.costUsd).toBeCloseTo(0.3);
    }
  );

  test('omits usage on the chat turn capture when the provider reports none', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello again', { actor: operator });

    expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
    const arg = mockCaptureChatTurn.mock.calls[0]?.[0];
    expect(arg?.costUsd).toBeUndefined();
    expect(arg?.tokensIn).toBeUndefined();
    expect(arg?.tokensOut).toBeUndefined();
  });

  for (const mode of ['stream', 'batch'] as const) {
    for (const exit of ['result', 'throw'] as const) {
      test.each(['known', 'unknown', 'none'] as const)(
        `${mode}: retains %s usage on a provider ${exit} failure`,
        async usage => {
          mockSendQuery.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'partial' };
            if (usage !== 'none') {
              yield { type: 'result', cost: 0.125, tokens: { input: 100, output: 10 } };
            }
            if (usage === 'unknown') yield { type: 'result', tokensUnknown: true };
            if (exit === 'throw') throw new Error('provider subprocess exited');
            yield { type: 'result', isError: true, errorSubtype: 'error_max_turns' };
          });
          const platform = makePlatform();
          platform.getStreamingMode.mockReturnValue(mode);
          await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

          expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
          expect(mockCaptureChatTurn).toHaveBeenCalledWith(
            expect.objectContaining({
              platform: 'web',
              provider: 'claude',
              outcome: 'failed',
              durationMs: expect.any(Number),
              costUsd: usage === 'none' ? undefined : 0.125,
              tokensIn: usage === 'known' ? 100 : undefined,
              tokensOut: usage === 'known' ? 10 : undefined,
            })
          );
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'conv-1',
            expect.stringContaining(
              exit === 'throw' ? 'provider subprocess exited' : 'error_max_turns'
            )
          );
        }
      );
    }
    test.each([false, true])(
      `${mode}: includes error-result usage once (tokensUnknown=%s)`,
      async tokensUnknown => {
        mockSendQuery.mockImplementation(async function* () {
          yield { type: 'result', cost: 0.125, tokens: { input: 100, output: 10 } };
          yield {
            type: 'result',
            isError: true,
            errorSubtype: 'error_max_turns',
            cost: 0.25,
            tokens: { input: 200, output: 20 },
            ...(tokensUnknown ? { tokensUnknown: true as const } : {}),
          };
        });
        const platform = makePlatform();
        platform.getStreamingMode.mockReturnValue(mode);
        await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

        expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
        expect(mockCaptureChatTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: 'failed',
            costUsd: 0.375,
            tokensIn: tokensUnknown ? undefined : 300,
            tokensOut: tokensUnknown ? undefined : 30,
          })
        );
      }
    );
  }
});

// ─── Message persistence for non-web platforms (regression for #1182) ────────

describe('message persistence for non-web platforms', () => {
  beforeEach(() => {
    mockAddMessage.mockReset();
    mockAddMessage.mockImplementation((conversationId, role, content) =>
      Promise.resolve(makeMessage({ conversation_id: conversationId, role, content }))
    );
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockGetCodebaseEnvVars.mockReset();
    mockLoadConfig.mockReset();
    mockSendQuery.mockClear();

    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ id: 'conv-db-id', platform_conversation_id: 'conv-1' }))
    );
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockGetCodebaseEnvVars.mockImplementation(() => Promise.resolve({}));
    mockLoadConfig.mockImplementation(() => Promise.resolve(makeConfig()));
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'hello back' };
      yield { type: 'result', sessionId: 'sess-1' };
    });
  });

  test('persists user + assistant messages for non-web platform (batch mode)', async () => {
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'github'),
      getStreamingMode: mock(() => 'batch' as const),
    };

    await handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator });

    // Inbound user message must land in the DB so the Web UI history is non-empty.
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'user',
      'what is this repo?',
      undefined,
      undefined
    );
    // Outbound assistant reply must also be persisted (matches what was sent).
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'assistant',
      expect.stringContaining('hello back')
    );
    expect(mockAddMessage).toHaveBeenCalledTimes(2);
  });

  test('persists user + assistant messages for non-web platform (stream mode)', async () => {
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'hello ' };
      yield { type: 'agent_message_chunk', text: 'back' };
      yield { type: 'result', sessionId: 'sess-1' };
    });
    const platform = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'telegram'),
      getStreamingMode: mock(() => 'stream' as const),
    };

    await handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator });

    expect(platform.sendMessage.mock.calls).toEqual([
      ['conv-1', 'hello '],
      ['conv-1', 'back'],
    ]);
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'user',
      'what is this repo?',
      undefined,
      undefined
    );
    expect(mockAddMessage).toHaveBeenCalledWith('conv-db-id', 'assistant', 'hello back');
    expect(mockAddMessage).toHaveBeenCalledTimes(2);
  });

  for (const mode of ['stream', 'batch'] as const) {
    for (const owner of ['core', 'adapter'] as const) {
      test(`new adapter ${owner} persistence in ${mode} mode`, async () => {
        const platform: IPlatformAdapter = {
          ...makePlatform(),
          capabilities: { messagePersistence: owner, defaultWorkflowDispatch: 'foreground' },
          getPlatformType: () => 'matrix-chat',
          getStreamingMode: () => mode,
        };
        await handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator });
        expect(mockAddMessage).toHaveBeenCalledTimes(owner === 'core' ? 2 : 0);
        expect(platform.sendMessage).toHaveBeenCalled();
      });
    }
  }

  test('does NOT call addMessage for web platform (web adapter owns persistence)', async () => {
    const platform = makePlatform(); // makePlatform defaults getPlatformType to 'web'

    await handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  test('platform delivery is not blocked when persistence rejects', async () => {
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'github'),
      getStreamingMode: mock(() => 'batch' as const),
    };
    mockAddMessage.mockImplementation(() => Promise.reject(new Error('db down')));

    await expect(
      handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator })
    ).resolves.toBeUndefined();
    expect(platform.sendMessage).toHaveBeenCalled();
  });

  test('platform delivery is not blocked when persistence rejects (stream mode)', async () => {
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'telegram'),
      getStreamingMode: mock(() => 'stream' as const),
    };
    mockAddMessage.mockImplementation(() => Promise.reject(new Error('db down')));

    await expect(
      handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator })
    ).resolves.toBeUndefined();
    // Stream mode delivers chunks during the sendQuery loop — a DB failure must
    // not stop delivery, so the reply must still have reached the platform.
    expect(platform.sendMessage).toHaveBeenCalled();
  });

  test('passes userId to addMessage when context provides it', async () => {
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'github'),
      getStreamingMode: mock(() => 'batch' as const),
    };

    await handleMessage(platform, 'conv-1', 'what is this repo?', {
      actor: { kind: 'user', userId: 'user-abc' },
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'user',
      'what is this repo?',
      undefined,
      'user-abc'
    );
    // The assistant row is NULL-attributed by design — it must NOT carry userId.
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'assistant',
      expect.stringContaining('hello back')
    );
    expect(mockAddMessage).toHaveBeenCalledTimes(2);
  });

  test('does NOT persist a user row for a deterministic slash command (no orphan)', async () => {
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'github'),
      getStreamingMode: mock(() => 'batch' as const),
    };
    mockParseCommand.mockReturnValueOnce({ command: 'status', args: [] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({ success: true, message: 'status ok', workflow: undefined })
    );

    await handleMessage(platform, 'conv-1', '/status', { actor: operator });

    // Deterministic slash commands return before the AI dispatch, so persisting a
    // user row here would orphan it (no paired assistant row in the Web UI history).
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

test('direct explicit folder command uses the folder primitive and refuses an existing repo', async () => {
  mockParseCommand.mockReset();
  mockRegisterFolder.mockClear();
  mockListCodebases.mockResolvedValueOnce([]);
  mockParseCommand.mockReturnValueOnce({
    command: 'register-project',
    args: ['--folder', 'Platform', '/'],
  });
  const platform = makePlatform();
  await handleMessage(platform, 'conv-1', '/register-project --folder Platform /', {
    actor: operator,
  });
  expect(mockRegisterFolder).toHaveBeenCalledWith(await canonicalizeProjectPath('/'), 'Platform');
  mockRegisterFolder.mockClear();
  mockRegisterFolder.mockRejectedValueOnce(
    new Error('Project "Platform" is already registered as a repo')
  );
  mockListCodebases.mockResolvedValueOnce([
    { ...makeCodebase(), name: 'Platform', kind: 'repo', default_cwd: '/' },
  ]);
  mockParseCommand.mockReturnValueOnce({
    command: 'register-project',
    args: ['--folder', 'Platform', '/'],
  });
  await handleMessage(platform, 'conv-1', '/register-project --folder Platform /', {
    actor: operator,
  });
  expect(mockRegisterFolder).toHaveBeenCalledWith(await canonicalizeProjectPath('/'), 'Platform');
  const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
    .map(call => String(call[1]))
    .join('\n');
  expect(messages).toContain('already registered as a repo');
});

describe('explicit registration results', () => {
  beforeEach(() => {
    mockCreateCodebase.mockClear();
    mockRegisterRepository.mockClear();
    mockListCodebases.mockResolvedValue([]);
  });

  test('registers under the claimed name when the requested storage is taken', async () => {
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['app', '/path/app'],
    });
    mockRegisterRepository.mockResolvedValueOnce({
      codebaseId: 'repo-id',
      name: '_local/app-2',
      defaultCwd: await canonicalizeProjectPath('/path/app'),
      alreadyExisted: false,
    });
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/register-project app /path/app', { actor: operator });

    const defaultCwd = await canonicalizeProjectPath('/path/app');
    expect(mockRegisterRepository).toHaveBeenCalledWith(defaultCwd, { name: 'app' });
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      call => call[1] as string
    );
    expect(sent.some(msg => msg.includes('Project "_local/app-2" registered'))).toBe(true);
  });

  test('a repository registration refusal is reported without confirming a new project', async () => {
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['app', '/path/app'],
    });
    mockRegisterRepository.mockRejectedValueOnce(
      new Error('Project "acme/app" is already registered at /prod/app; use worktrees')
    );
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/register-project app /path/app', { actor: operator });
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(call => String(call[1]))
      .join('\n');
    expect(messages).toContain('already registered at /prod/app; use worktrees');
    expect(messages).not.toContain('registered successfully');
    expect(mockCreateCodebase).not.toHaveBeenCalled();
  });
});
