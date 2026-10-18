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
import { filterToolIndicators } from './chat-turn';

// ─── filterToolIndicators ─────────────────────────────────────────────────────

describe('filterToolIndicators', () => {
  test('returns empty string for empty array', () => {
    expect(filterToolIndicators([])).toBe('');
  });

  test('preserves non-tool-indicator text unchanged', () => {
    const result = filterToolIndicators(['This is a regular message.']);
    expect(result).toBe('This is a regular message.');
  });

  test('filters 🔧 (U+1F527) tool usage indicator', () => {
    const result = filterToolIndicators(['🔧 Running tool foo', 'The answer is 42.']);
    expect(result).not.toContain('🔧');
    expect(result).toContain('The answer is 42.');
  });

  test('filters 💭 (U+1F4AD) thinking indicator', () => {
    const result = filterToolIndicators([
      '💭 Thinking about the problem...',
      'Here is my response.',
    ]);
    expect(result).not.toContain('💭');
    expect(result).toContain('Here is my response.');
  });

  test('filters 📝 (U+1F4DD) writing indicator', () => {
    const result = filterToolIndicators(['📝 Writing file output.txt', 'Done writing.']);
    expect(result).not.toContain('📝');
    expect(result).toContain('Done writing.');
  });

  test('filters ✏️ (U+270F+FE0F) editing indicator', () => {
    const result = filterToolIndicators(['\u{270F}\u{FE0F} Editing main.ts', 'Edit complete.']);
    expect(result).not.toContain('\u{270F}');
    expect(result).toContain('Edit complete.');
  });

  test('filters 🗑️ (U+1F5D1+FE0F) deleting indicator', () => {
    const result = filterToolIndicators(['\u{1F5D1}\u{FE0F} Deleting temp file', 'File removed.']);
    expect(result).not.toContain('\u{1F5D1}');
    expect(result).toContain('File removed.');
  });

  test('filters 📂 (U+1F4C2) folder indicator', () => {
    const result = filterToolIndicators(['📂 Reading directory /src', 'Directory listed.']);
    expect(result).not.toContain('📂');
    expect(result).toContain('Directory listed.');
  });

  test('filters 🔍 (U+1F50D) search indicator', () => {
    const result = filterToolIndicators(['🔍 Searching for pattern', 'Search complete.']);
    expect(result).not.toContain('🔍');
    expect(result).toContain('Search complete.');
  });

  test('preserves emoji that is not a tool indicator', () => {
    const result = filterToolIndicators(['🎉 Deployment successful!']);
    expect(result).toContain('🎉 Deployment successful!');
  });

  test('preserves text that contains tool emoji but does not START with it', () => {
    // The regex requires the emoji at the START of the section
    const result = filterToolIndicators(['Here is a 🔧 wrench emoji mid-text.']);
    expect(result).toContain('🔧');
  });

  test('falls back to all messages when everything gets filtered out', () => {
    expect(filterToolIndicators(['🔧 Tool call one', '💭 Thinking...'])).toBe(
      '🔧 Tool call one\n\n---\n\n💭 Thinking...'
    );
  });

  test('drops the separator of a message that held only tool indicators', () => {
    expect(filterToolIndicators(['First part.', '🔧 Some tool usage here', 'Second part.'])).toBe(
      'First part.\n\n---\n\nSecond part.'
    );
  });

  test('handles multiple assistant messages joined with separator', () => {
    const messages = [
      'First part of the response.',
      '🔧 Some tool usage here',
      'Second part of the response.',
    ];
    const result = filterToolIndicators(messages);
    expect(result).toContain('First part of the response.');
    expect(result).toContain('Second part of the response.');
    expect(result).not.toContain('🔧 Some tool usage here');
  });

  test('sections within a single message are split by double newlines', () => {
    // A single message with embedded double-newline creates multiple sections
    const messages = ['Normal text.\n\n🔧 Tool output.\n\nMore normal text.'];
    const result = filterToolIndicators(messages);
    expect(result).toContain('Normal text.');
    expect(result).toContain('More normal text.');
    expect(result).not.toContain('🔧');
  });

  test('trims whitespace from the final output', () => {
    const result = filterToolIndicators(['  Regular text with leading spaces.  ']);
    expect(result).toBe('Regular text with leading spaces.');
  });

  test('handles empty strings in message array', () => {
    const result = filterToolIndicators(['', 'Actual content here.', '']);
    expect(result).toContain('Actual content here.');
  });
});

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
  });

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
      // Post-fix shape from claude/provider.ts: isError absent; stop_sequence maps to end_turn.
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

// ─── Multi-chunk command accumulation regression ──────────────────────────────

describe('handleMessage — multi-chunk command accumulation (regression)', () => {
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

  test('stream mode — register-project split across 3 chunks', async () => {
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['ExampleProject', '/.archon/workspaces/owner/repo/source'],
    });
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: "I'll register the project now.\n\n/register-project ",
      };
      yield { type: 'agent_message_chunk', text: 'ExampleProject ' };
      yield { type: 'agent_message_chunk', text: '"/.archon/workspaces/owner/repo/source"' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'register my project', { actor: operator });

    const expectedCwd = await canonicalizeProjectPath('/.archon/workspaces/owner/repo/source');
    expect(mockRegisterRepository).toHaveBeenCalledTimes(1);
    expect(mockRegisterRepository).toHaveBeenCalledWith(expectedCwd, { name: 'ExampleProject' });
    const allCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as [
      string,
      string,
    ][];
    // The confirmation echoes the path that was actually stored.
    expect(allCalls.some(([, msg]) => msg.includes(expectedCwd))).toBe(true);
  });

  test('batch mode — register-project split across 3 chunks', async () => {
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['ExampleProject', '/.archon/workspaces/owner/repo/source'],
    });
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: "I'll register the project now.\n\n/register-project ",
      };
      yield { type: 'agent_message_chunk', text: 'ExampleProject ' };
      yield { type: 'agent_message_chunk', text: '"/.archon/workspaces/owner/repo/source"' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'register my project', { actor: operator });

    const expectedCwd = await canonicalizeProjectPath('/.archon/workspaces/owner/repo/source');
    expect(mockRegisterRepository).toHaveBeenCalledTimes(1);
    expect(mockRegisterRepository).toHaveBeenCalledWith(expectedCwd, { name: 'ExampleProject' });
    const allCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as [
      string,
      string,
    ][];
    // The confirmation echoes the path that was actually stored.
    expect(allCalls.some(([, msg]) => msg.includes(expectedCwd))).toBe(true);
  });

  test('stream mode — invoke-workflow split across 2 chunks', async () => {
    mockListCodebases.mockReturnValueOnce(Promise.resolve([makeNamedCodebase('my-project')]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({ workflows: [makeTestWorkflowWithSource({ name: 'assist' })], errors: [] })
    );
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'Running the workflow now.\n\n/invoke-workflow ' };
      yield { type: 'agent_message_chunk', text: 'assist --project my-project' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'run assist on my-project', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('batch mode — invoke-workflow split across 2 chunks', async () => {
    mockListCodebases.mockReturnValueOnce(Promise.resolve([makeNamedCodebase('my-project')]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({ workflows: [makeTestWorkflowWithSource({ name: 'assist' })], errors: [] })
    );
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'Running the workflow now.\n\n/invoke-workflow ' };
      yield { type: 'agent_message_chunk', text: 'assist --project my-project' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'run assist on my-project', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('stream mode — invoke-workflow with --prompt split into a later chunk', async () => {
    // Regression: INVOKE_WORKFLOW_FULL_RE must not declare the command complete when
    // --project <token> arrives without a line terminator, because --prompt may follow
    // in the next chunk. Without this fix, commandFullyParsed fires early and the
    // --prompt chunk is never accumulated, causing synthesizedPrompt to be lost.
    mockListCodebases.mockReturnValueOnce(Promise.resolve([makeNamedCodebase('my-project')]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({ workflows: [makeTestWorkflowWithSource({ name: 'assist' })], errors: [] })
    );
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'Running assist.\n\n/invoke-workflow assist --project my-project ',
      };
      yield { type: 'agent_message_chunk', text: '--prompt "synthesized task description"' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'original user message', { actor: operator });

    // Workflow was dispatched with the synthesized prompt, not the original user message.
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessage: 'synthesized task description' }),
      expect.anything()
    );
  });

  test('batch mode — invoke-workflow with --prompt split into a later chunk', async () => {
    mockListCodebases.mockReturnValueOnce(Promise.resolve([makeNamedCodebase('my-project')]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({ workflows: [makeTestWorkflowWithSource({ name: 'assist' })], errors: [] })
    );
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: 'Running assist.\n\n/invoke-workflow assist --project my-project ',
      };
      yield { type: 'agent_message_chunk', text: '--prompt "synthesized task description"' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'original user message', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessage: 'synthesized task description' }),
      expect.anything()
    );
  });

  test('stream mode — an escaped quote in a split --prompt reaches the run intact', async () => {
    mockListCodebases.mockReturnValueOnce(Promise.resolve([makeNamedCodebase('my-project')]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({ workflows: [makeTestWorkflowWithSource({ name: 'assist' })], errors: [] })
    );
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: '/invoke-workflow assist --project my-project --prompt "Fix the \\"lo',
      };
      yield { type: 'agent_message_chunk', text: 'gin\\" bug and add tests"' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'original user message', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessage: 'Fix the "login" bug and add tests' }),
      expect.anything()
    );
  });

  test('stream mode — command in single chunk still works (non-regression)', async () => {
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['MyApp', '/path/to/app'],
    });
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '/register-project MyApp /path/to/app' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'register my app', { actor: operator });

    expect(mockRegisterRepository).toHaveBeenCalledWith(
      await canonicalizeProjectPath('/path/to/app'),
      { name: 'MyApp' }
    );
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
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '/register-project app /path/app' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'register my app', { actor: operator });

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

  test('stream mode — pre-command text is streamed, post-command chunks are suppressed', async () => {
    // The command chunk includes a trailing \n so REGISTER_PROJECT_FULL_RE fires on
    // that chunk alone (unquoted path + line terminator = fully parsed). commandFullyParsed
    // becomes true before the third chunk arrives, so " extra trailing" is never
    // accumulated and cannot corrupt the parsed path.
    mockParseCommand.mockReturnValueOnce({
      command: 'register-project',
      args: ['Foo', '/path'],
    });
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'Registering now:\n' };
      yield { type: 'agent_message_chunk', text: '/register-project Foo /path\n' };
      yield { type: 'agent_message_chunk', text: ' extra trailing' };
      yield { type: 'result', sessionId: 'sess-1' };
    });

    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'register foo', { actor: operator });

    const calls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls as [
      string,
      string,
    ][];
    const sentTexts = calls.map(([, msg]) => msg);
    // Pre-command text was streamed
    expect(sentTexts).toContain('Registering now:\n');
    // Command trigger chunk was NOT streamed
    expect(sentTexts).not.toContain('/register-project Foo /path\n');
    // Post-command chunk was NOT streamed (suppressed because commandFullyParsed=true)
    expect(sentTexts).not.toContain(' extra trailing');
    expect(mockRegisterRepository).toHaveBeenCalledWith(await canonicalizeProjectPath('/path'), {
      name: 'Foo',
    });
  });
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

  test('does NOT capture a chat turn when the AI routes to /invoke-workflow', async () => {
    // Guard for the "excluded by construction" claim: the routing turn that
    // dispatches a workflow must count as workflow_invoked, not as a chat turn.
    const codebase = makeNamedCodebase('my-project');
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '/invoke-workflow assist --project my-project' };
      yield { type: 'result', sessionId: 'session-1' };
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'run assist on my project', { actor: operator });

    // Positive control: the routing path actually ran — dispatch auto-attaches
    // the project to the conversation before isolation/execution.
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1-db', {
      codebase_id: 'id-my-project',
    });
    // …and the routing turn was NOT counted as a chat turn.
    expect(mockCaptureChatTurn).not.toHaveBeenCalled();
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

  test('captures a failed chat turn when the AI returns an error result', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'result', isError: true, errorSubtype: 'error_max_turns' };
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
    expect(mockCaptureChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'web',
        provider: 'claude',
        outcome: 'failed',
        durationMs: expect.any(Number),
      })
    );
  });

  test('a routed turn whose workflow dispatch throws is not a failed chat turn', async () => {
    const codebase = makeNamedCodebase('my-project');
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );
    mockSendQuery.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '/invoke-workflow assist --project my-project' };
      yield { type: 'result', sessionId: 'session-1' };
    });
    mockUpdateConversation.mockImplementationOnce(() =>
      Promise.reject(new Error('database is locked'))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'run assist on my project', { actor: operator });

    // Positive control: dispatch reached the write that failed.
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1-db', {
      codebase_id: 'id-my-project',
    });
    expect(mockCaptureChatTurn).not.toHaveBeenCalled();
  });

  for (const mode of ['stream', 'batch'] as const) {
    test(`captures exactly one failed chat turn when the provider throws mid-turn (${mode})`, async () => {
      mockGetOrCreateConversation.mockReturnValueOnce(
        Promise.resolve(makeConversation({ codebase_id: null }))
      );
      mockSendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'partial' };
        throw new Error('provider subprocess exited');
      });
      const platform = makePlatform();
      platform.getStreamingMode.mockImplementation(() => mode);

      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      expect(mockCaptureChatTurn).toHaveBeenCalledTimes(1);
      expect(mockCaptureChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'web', provider: 'claude', outcome: 'failed' })
      );
      // The user still hears about it from the outer handler.
      expect(platform.sendMessage).toHaveBeenCalled();
    });
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
    const platform: IPlatformAdapter = {
      ...makePlatform(),
      capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'foreground' } as const,
      getPlatformType: mock(() => 'telegram'),
      getStreamingMode: mock(() => 'stream' as const),
    };

    await handleMessage(platform, 'conv-1', 'what is this repo?', { actor: operator });

    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'user',
      'what is this repo?',
      undefined,
      undefined
    );
    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-db-id',
      'assistant',
      expect.stringContaining('hello back')
    );
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

for (const mode of ['stream', 'batch'] as const) {
  test(`${mode}: explicit folder command survives chunked quoted paths`, async () => {
    mockRegisterFolder.mockClear();
    mockListCodebases.mockResolvedValueOnce([]);
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '/register-project --folder ' };
      yield { type: 'agent_message_chunk', text: 'Platform ' };
      yield { type: 'agent_message_chunk', text: '"/path/with ' };
      yield { type: 'agent_message_chunk', text: 'spaces"\n' };
      yield { type: 'result', sessionId: 'folder-session' };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
    await handleMessage(platform, 'conv-1', 'register my directory as a folder project', {
      actor: operator,
    });
    expect(mockRegisterFolder).toHaveBeenCalledWith(
      await canonicalizeProjectPath('/path/with spaces'),
      'Platform'
    );
  });
}

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

for (const mode of ['stream', 'batch'] as const) {
  test(`${mode}: another registration command name cannot register a folder`, async () => {
    mockRegisterFolder.mockClear();
    mockCreateCodebase.mockClear();
    mockRegisterRepository.mockClear();
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: '/register-project-backup --folder Platform /\n' };
      yield { type: 'result', sessionId: 'other-command' };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
    await handleMessage(platform, 'conv-1', 'save project instructions', { actor: operator });
    expect(mockRegisterFolder).not.toHaveBeenCalled();
    expect(mockCreateCodebase).not.toHaveBeenCalled();
  });

  test(`${mode}: registration arguments cannot cross a line break`, async () => {
    mockRegisterFolder.mockClear();
    mockCreateCodebase.mockClear();
    mockRegisterRepository.mockClear();
    mockListCodebases.mockResolvedValueOnce([]);
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'agent_message_chunk',
        text: '/register-project\n--folder unintended /tmp\n/register-project --folder intended /tmp/intended\n',
      };
      yield { type: 'result', sessionId: 'line-boundary' };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
    await handleMessage(platform, 'conv-1', 'register my folder', { actor: operator });
    expect(mockRegisterFolder.mock.calls).toEqual([
      [await canonicalizeProjectPath('/tmp/intended'), 'intended'],
    ]);
    expect(mockCreateCodebase).not.toHaveBeenCalled();
  });

  test(`${mode}: explicit folder registration preserves an apostrophe in an unquoted path`, async () => {
    mockRegisterFolder.mockClear();
    mockListCodebases.mockResolvedValueOnce([]);
    mockSendQuery.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: "/register-project --folder demo /tmp/O'Brien\n" };
      yield { type: 'result', sessionId: 'literal-path' };
    });
    const platform = makePlatform();
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue(mode);
    await handleMessage(platform, 'conv-1', 'register my folder', { actor: operator });
    expect(mockRegisterFolder).toHaveBeenCalledWith(
      await canonicalizeProjectPath("/tmp/O'Brien"),
      'demo'
    );
  });
}
