// @archon-test-isolated
/** Covers `handleMessage` in orchestrator-agent.ts; shared mocks live in `../test/orchestrator-agent-harness`. */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { NativeTool } from '@archon/providers/types';

import {
  DEFAULT_PROVIDER_CAPS,
  canonicalizeProjectPath,
  makeCodebase,
  makeCodebaseForSync,
  makeConfig,
  makeConversation,
  makePlatform,
  makeRun,
  makeSession,
  mockAddMessage,
  mockCaptureApprovalResolved,
  mockCaptureWorkflowNoMatch,
  mockCreateWorkflowEvent,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockEnsureArchonWorkspacesPath,
  mockExecuteWorkflow,
  mockExistsSync,
  mockFindResumableRunByParentConversation,
  mockFindWorkflowRunsByIdPrefix,
  mockGetActiveSession,
  mockGetCodebase,
  mockGetCodebaseEnvVars,
  mockGetOrCreateConversation,
  mockGetPausedWorkflowRun,
  mockGetWorkflowRunDb,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockListCodebases,
  mockLoadConfig,
  mockLogger,
  mockRegisterFolder,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockSendQuery,
  mockTransitionSession,
  mockUpdateWorkflowRun,
  mockValidateAndResolveIsolation,
  operator,
  makeDispatchConversation,
  makeForegroundPlatform,
  resetDispatchMocks,
} from '../test/orchestrator-agent-harness';
import { handleMessage } from './orchestrator-agent';

// ─── provider cwd resolution (issue #1179) ──────────────────────────────────

describe('provider cwd resolution', () => {
  function getSendQueryCwd(): string {
    expect(mockSendQuery).toHaveBeenCalled();
    return mockSendQuery.mock.calls[0][1] as string;
  }

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockSendQuery.mockClear();
    mockEnsureArchonWorkspacesPath.mockClear();
    mockLogger.warn.mockClear();
    // existsSync is reset by the top-level beforeEach, which covers every describe.
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockLoadConfig.mockImplementation(() => Promise.resolve(makeConfig()));
    mockGetCodebaseEnvVars.mockImplementation(() => Promise.resolve({}));
  });

  test('scoped chat uses codebase.default_cwd as provider cwd', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(getSendQueryCwd()).toBe('/repos/test-repo');
    expect(mockEnsureArchonWorkspacesPath).not.toHaveBeenCalled();
  });

  test('scoped chat uses conversation.cwd when set (active worktree path)', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({
      codebase_id: 'codebase-1',
      cwd: '/worktrees/feature-branch',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(getSendQueryCwd()).toBe('/worktrees/feature-branch');
    expect(mockEnsureArchonWorkspacesPath).not.toHaveBeenCalled();
  });

  test('scoped chat refuses the turn when conversation.cwd no longer exists', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({
      codebase_id: 'codebase-1',
      cwd: '/worktrees/deleted-branch',
      isolation_env_id: 'env-gone',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/deleted-branch');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    // Never reaches the provider: spawning there fails ENOENT and the Claude
    // SDK misreports it as a binary/libc mismatch.
    expect(mockSendQuery).not.toHaveBeenCalled();
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
    expect(sent).toContain('/worktrees/deleted-branch');
    expect(sent).toContain('/setproject');
  });

  test('suggests detaching the worktree only while one is still attached', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({
      codebase_id: 'codebase-1',
      cwd: '/worktrees/deleted-branch',
      isolation_env_id: 'env-gone',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/deleted-branch');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
    expect(sent).toContain('/worktree remove');
    expect(sent).toContain('/setproject');
  });

  test('drops the worktree advice once isolation_env_id is already cleared', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({
      codebase_id: 'codebase-1',
      cwd: '/worktrees/deleted-branch',
      isolation_env_id: null,
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/deleted-branch');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
    // Reachable via the stale_cleaned branch in validateAndResolveIsolation, which
    // clears isolation_env_id and leaves cwd set. `/worktree remove` answers "This
    // conversation is not using a worktree." here, so suggesting it dead-ends.
    expect(sent).not.toContain('/worktree remove');
    expect(sent).not.toContain('isolated worktree was removed');
    expect(sent).toContain('/setproject');
  });

  test('missing conversation.cwd does not silently fall back to default_cwd', async () => {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({
      codebase_id: 'codebase-1',
      cwd: '/worktrees/deleted-branch',
    });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/deleted-branch');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    // Relocating the agent into the live checkout would widen its write scope
    // without the user asking for it.
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test('unscoped chat ignores a missing conversation.cwd', async () => {
    const conversation = makeConversation({ codebase_id: null, cwd: '/worktrees/deleted-branch' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([]));
    mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/deleted-branch');

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    // With no codebase scoped, cwd is never consulted — the workspaces path wins,
    // so a stale override must not block the turn.
    expect(mockEnsureArchonWorkspacesPath).toHaveBeenCalled();
    expect(mockSendQuery).toHaveBeenCalled();
  });

  // ─── missing project directory (#2663) ──────────────────────────────────────

  describe('missing project directory', () => {
    test('refuses the turn and never reaches the provider when default_cwd is gone', async () => {
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      // Handing a missing path to the provider is the whole defect: the spawn
      // fails ENOENT against the BINARY, so the user is told the wrong thing.
      expect(mockSendQuery).not.toHaveBeenCalled();
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
      expect(sent).toContain('/repos/test-repo');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ codebaseId: 'codebase-1', cwd: '/repos/test-repo' }),
        'orchestrator.codebase_cwd_missing'
      );
    });

    test('offers recovery that actually works, and not the traps', async () => {
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
      // /update-project validates the new path and repairs the registration.
      expect(sent).toContain('/update-project');
      expect(sent).toContain('/setproject');
      // /worktree remove answers "not using a worktree" when isolation_env_id is
      // null, and otherwise repoints cwd at this same missing directory.
      expect(sent).not.toContain('/worktree remove');
      // /register-project creates a new registration rather than repairing this one.
      expect(sent).not.toContain('/register-project');
    });

    test('quotes a project name containing whitespace so the suggestion parses', async () => {
      const codebase = { ...makeCodebaseForSync(), name: 'Client Ops' };
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
      // handleUpdateProject takes only the FIRST token as the project name, so an
      // unquoted `Client Ops` parses as `Client` and hands the user a second, more
      // confusing error instead of a repair. Verified against the real parser:
      // `/update-project Client Ops <path>` -> name "Client", path "Ops <path>";
      // the quoted form -> name "Client Ops", path "<path>".
      expect(sent).toContain('/update-project "Client Ops" <new-path>');
      expect(sent).not.toContain('/update-project Client Ops');
    });

    test('escapes quotes and backslashes in the project name', async () => {
      // Quoting alone is not enough: a `"` inside the name closes the quoted token
      // early and reproduces the original defect, and a trailing `\` escapes the
      // closing quote. parseCommand honours backslash escapes inside quotes, so a
      // single pass over both characters round-trips. One pass, not two chained
      // replaces — escaping `"` first and `\` second would double-escape the
      // backslashes the first pass just added.
      const codebase = { ...makeCodebaseForSync(), name: 'Bob"s \\Ops' };
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
      expect(sent).toContain('/update-project "Bob\\"s \\\\Ops" <new-path>');
    });

    test('writes no user row when it refuses, so none is left unpaired', async () => {
      mockAddMessage.mockClear();
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      // Non-web only: the web adapter's route persists its own turns, so the
      // orchestrator never writes a user row for it and this could not regress.
      const platform = makePlatform();
      platform.getPlatformType = mock(() => 'telegram') as typeof platform.getPlatformType;
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      expect(mockSendQuery).not.toHaveBeenCalled();
      expect(mockAddMessage.mock.calls.filter(c => c[1] === 'user')).toHaveLength(0);
    });

    test('a stale cwd override gets the conversation-cwd message, not this one', async () => {
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({
        codebase_id: 'codebase-1',
        cwd: '/worktrees/removed',
      });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      mockExistsSync.mockImplementation((p: string) => p !== '/worktrees/removed');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      // Pins WHICH refusal the user gets, which is the part still observable here.
      //
      // Be clear about what this does not do: it cannot catch widening this guard's
      // condition to `conversation.cwd ?? default_cwd`. The conversation-cwd guard
      // above returns first for every `cwd !== null` case, so a widened condition
      // is dead code, and the mutation passes the whole suite. That is a property
      // of the ordering, not a gap worth papering over with a weaker assertion —
      // the note on the guard itself carries the reason to keep it narrow.
      //
      // What this DOES catch is the two guards' messages crossing: this guard
      // claiming the override case and answering with project-root advice that says
      // nothing about `isolation_env_id`.
      const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1] as string;
      expect(sent).toContain('/worktrees/removed');
      expect(sent).toContain('working directory no longer exists');
      // This guard's own message signature — nothing else emits that sentence, so
      // it cannot false-alarm. Deliberately NOT also asserting the absence of
      // `/update-project`: the guard above offers `/worktree remove` and
      // `/setproject` and never that, so the two strings always co-occur and it
      // would add no detection — while breaking this test if anyone ever adds
      // `/update-project` to that message, an edit that has nothing to do with
      // this guard.
      expect(sent).not.toContain('project directory no longer exists');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.anything(),
        'orchestrator.conversation_cwd_missing'
      );
    });

    test('runs the turn when the cwd override is healthy but default_cwd is gone', async () => {
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({
        codebase_id: 'codebase-1',
        cwd: '/worktrees/healthy',
      });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
      // The project root is gone, but this conversation does not use it.
      mockExistsSync.mockImplementation((p: string) => p !== '/repos/test-repo');

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      // This is the case that makes `&& conversation.cwd === null` load-bearing
      // rather than decorative. Drop that clause while leaving the target as
      // `default_cwd` and this guard refuses a perfectly healthy turn, telling the
      // user their project directory is gone and offering to repoint a directory
      // the turn never touches. Nothing else in the suite catches that mutation.
      expect(getSendQueryCwd()).toBe('/worktrees/healthy');
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'orchestrator.codebase_cwd_missing'
      );
    });

    test('does not fire when the project directory is present', async () => {
      const codebase = makeCodebaseForSync();
      const conversation = makeConversation({ codebase_id: 'codebase-1' });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      expect(getSendQueryCwd()).toBe('/repos/test-repo');
    });

    test('leaves the unscoped path alone — the workspaces root is created on demand', async () => {
      const conversation = makeConversation({ codebase_id: null });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockListCodebases.mockReturnValueOnce(Promise.resolve([]));
      mockExistsSync.mockImplementation(() => false);

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

      expect(getSendQueryCwd()).toBe('/home/test/.archon/workspaces');
    });
  });

  test('unscoped chat uses ensureArchonWorkspacesPath result', async () => {
    const conversation = makeConversation({ codebase_id: null, cwd: null, isolation_env_id: null });
    mockGetActiveSession.mockResolvedValueOnce(null);
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(getSendQueryCwd()).toBe('/home/test/.archon/workspaces');
    expect(mockEnsureArchonWorkspacesPath).toHaveBeenCalled();
    expect(mockSendQuery.mock.calls[0]?.[2]).toBeUndefined();
  });

  test('scoped chat falls back to workspaces root and warns when codebase not found (deleted)', async () => {
    const conversation = makeConversation({ codebase_id: 'deleted-id' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockListCodebases.mockReturnValueOnce(Promise.resolve([]));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(getSendQueryCwd()).toBe('/home/test/.archon/workspaces');
    expect(mockEnsureArchonWorkspacesPath).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'deleted-id' }),
      'orchestrator.scoped_codebase_not_found'
    );
  });
});

// ─── Typed chat tools ─────────────────────────────────────────────────────────

describe('typed chat tools', () => {
  beforeEach(resetDispatchMocks);

  const task = 'Fix the "login" bug and add tests';
  let capsMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    const providers = await import('@archon/providers');
    capsMock = providers.getProviderCapabilities as ReturnType<typeof mock>;
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: true });
    mockSendQuery.mockReset();
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([makeCodebase()]));
  });

  afterEach(() => {
    // Restore the shared baseline, not a subset (see 'paused approval gate routing').
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
  });

  function turnToolNames(): string[] {
    const options = mockSendQuery.mock.calls.at(-1)?.[3] as
      | { nativeTools?: { name: string }[] }
      | undefined;
    return (options?.nativeTools ?? []).map(t => t.name);
  }

  /** The agent calls `invoke_workflow` with each input in turn, then replies `reply`. */
  function agentInvokes(inputs: Record<string, unknown>[], sink: string[], reply = 'On it.'): void {
    mockSendQuery.mockImplementationOnce(async function* () {
      const options = mockSendQuery.mock.calls.at(-1)?.[3] as { nativeTools: NativeTool[] };
      const tool = options.nativeTools.find(t => t.name === 'invoke_workflow');
      for (const input of inputs) sink.push(await tool!.handler(input));
      yield { type: 'agent_message_chunk', text: reply };
      yield { type: 'result', sessionId: 'session-1' };
    });
  }

  const launch = { workflow: 'test-workflow', project: 'test-repo', prompt: task };

  test.each(['stream', 'batch'] as const)(
    'escaped quotes in model --prompt prose cannot truncate typed Codex dispatch (%s)',
    async mode => {
      const { CodexProvider } = await import('@archon/providers/codex/provider');
      const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
      const { createFakeAppServer, THREAD_ID, TURN_ID, agentMessage } = await import(
        '../../../providers/src/test/codex-app-server-fake'
      );
      capsMock.mockReturnValue(CODEX_CAPABILITIES);
      const prose = String.raw`/invoke-workflow test-workflow --project test-repo --prompt "Fix the \"login\" bug and add tests"`;
      expect(prose).toContain(String.raw`\"login\"`);
      const server = createFakeAppServer(() => ({
        toolCalls: [
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            callId: 'launch',
            namespace: null,
            tool: 'invoke_workflow',
            arguments: launch,
          },
        ],
        notifications: [agentMessage(prose)],
      }));
      const provider = new CodexProvider(server, 1);
      mockGetOrCreateConversation.mockResolvedValueOnce(
        makeConversation({ ai_assistant_type: 'codex' })
      );
      mockSendQuery.mockImplementationOnce(async function* (prompt, cwd, sessionId, options) {
        for await (const chunk of provider.sendQuery(prompt, cwd, sessionId, options)) {
          expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
          yield chunk;
        }
      });
      const platform = makePlatform();
      platform.getStreamingMode.mockReturnValue(mode);
      await handleMessage(platform, 'conv-1', 'fix the login bug', { actor: operator });
      expect(server.processes[0].toolResponses[0].result).toMatchObject({
        success: true,
        contentItems: [{ text: expect.stringContaining('Queued test-workflow') }],
      });
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ originalMessage: task }),
        expect.anything()
      );

      mockDispatchBackgroundWorkflow.mockClear();
      const proseServer = createFakeAppServer(() => ({ notifications: [agentMessage(prose)] }));
      const proseProvider = new CodexProvider(proseServer, 1);
      mockGetOrCreateConversation.mockResolvedValueOnce(
        makeConversation({ ai_assistant_type: 'codex' })
      );
      mockSendQuery.mockImplementationOnce((...args) => proseProvider.sendQuery(...args));
      await handleMessage(platform, 'conv-1', 'hello', { actor: operator });
      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    }
  );

  for (const mode of ['stream', 'batch'] as const) {
    for (const toolName of ['invoke_workflow', 'register_project']) {
      test(`Codex reports an unanswered ${toolName} exception (${mode})`, async () => {
        const { CodexProvider } = await import('@archon/providers/codex/provider');
        const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
        const { createFakeAppServer, THREAD_ID, TURN_ID, itemCompleted } = await import(
          '../../../providers/src/test/codex-app-server-fake'
        );
        capsMock.mockReturnValue(CODEX_CAPABILITIES);
        const server = createFakeAppServer(() => ({
          toolCalls: [
            {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              callId: 'failure',
              namespace: null,
              tool: toolName,
              arguments:
                toolName === 'invoke_workflow' ? launch : { name: 'demo', path: '/', folder: true },
            },
          ],
          notifications: [
            itemCompleted({
              type: 'dynamicToolCall',
              id: 'failure',
              tool: toolName,
              namespace: null,
              arguments: {},
              status: 'failed',
              success: false,
              contentItems: [],
              durationMs: 1,
            }),
          ],
        }));
        const provider = new CodexProvider(server, 1);
        mockGetOrCreateConversation.mockResolvedValueOnce(
          makeConversation({ ai_assistant_type: 'codex' })
        );
        mockSendQuery.mockImplementationOnce(async function* (...args) {
          if (toolName === 'invoke_workflow')
            mockListCodebases.mockRejectedValueOnce(new Error('registry unavailable'));
          else mockRegisterFolder.mockRejectedValueOnce(new Error('disk full'));
          yield* provider.sendQuery(...args);
        });
        const platform = makePlatform();
        platform.getStreamingMode.mockReturnValue(mode);
        await handleMessage(platform, 'conv-1', 'launch or register', { actor: operator });
        expect(server.processes[0].toolResponses[0].result.success).toBe(false);
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          expect.stringContaining('A tool failed or was cancelled')
        );
        expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
      });
    }
  }

  test('a legacy Codex chat visibly asks for a new chat before invoking a model', async () => {
    const { CodexProvider } = await import('@archon/providers/codex/provider');
    const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
    const { createFakeAppServer } = await import(
      '../../../providers/src/test/codex-app-server-fake'
    );
    capsMock.mockReturnValue(CODEX_CAPABILITIES);
    mockGetOrCreateConversation.mockResolvedValueOnce(
      makeConversation({ ai_assistant_type: 'codex' })
    );
    mockTransitionSession.mockResolvedValueOnce(
      makeSession({ assistant_session_id: 'legacy-thread' })
    );
    const server = createFakeAppServer();
    const provider = new CodexProvider(server, 1);
    mockSendQuery.mockImplementationOnce((...args) => provider.sendQuery(...args));
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'launch the workflow', { actor: operator });
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Start a new chat')
    );
    expect(server.processes).toHaveLength(0);
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('Codex registration uses the shared primitive and manage_run preserves actor and project authorization', async () => {
    const { CodexProvider } = await import('@archon/providers/codex/provider');
    const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
    const { createFakeAppServer, THREAD_ID, TURN_ID } = await import(
      '../../../providers/src/test/codex-app-server-fake'
    );
    capsMock.mockReturnValue(CODEX_CAPABILITIES);
    const run = makeRun({
      id: 'aaaaaaaa-1111-2222-3333-444444444444',
      status: 'running',
      user_id: 'another-user',
    });
    mockGetWorkflowRunDb.mockResolvedValue(run);
    mockFindWorkflowRunsByIdPrefix.mockResolvedValue([run]);
    mockGetOrCreateConversation.mockResolvedValueOnce(
      makeConversation({
        ai_assistant_type: 'codex',
        codebase_id: 'codebase-1',
        cwd: '/repos/test-repo',
      })
    );
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    mockRegisterFolder.mockClear();
    const server = createFakeAppServer(() => ({
      toolCalls: [
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          callId: 'register',
          namespace: null,
          tool: 'register_project',
          arguments: { name: 'new-folder', path: '/', folder: true },
        },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          callId: 'cancel',
          namespace: null,
          tool: 'manage_run',
          arguments: { action: 'cancel', runId: run.id, confirm: true },
        },
      ],
    }));
    const provider = new CodexProvider(server, 1);
    mockSendQuery.mockImplementationOnce((...args) => provider.sendQuery(...args));
    await handleMessage(makePlatform(), 'conv-1', 'register my folder and cancel the run', {
      actor: { kind: 'unidentified' },
    });
    expect(mockRegisterFolder).toHaveBeenCalledWith(
      await canonicalizeProjectPath('/'),
      'new-folder'
    );
    expect(server.processes[0].toolResponses[0].result.contentItems).toEqual([
      { type: 'inputText', text: expect.stringContaining('registered successfully') },
    ]);
    expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith(run.id, 'codebase-1');
    expect(server.processes[0].toolResponses[1].result.contentItems).toEqual([
      {
        type: 'inputText',
        text: expect.stringContaining('Only the user who started this run or an admin'),
      },
    ]);
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  test('a typed no-match decision emits one distinct event; ordinary replies emit none', async () => {
    mockCaptureWorkflowNoMatch.mockClear();
    await handleMessage(makePlatform(), 'conv-1', 'hello', { actor: operator });
    expect(mockCaptureWorkflowNoMatch).not.toHaveBeenCalled();
    mockSendQuery.mockImplementationOnce(async function* () {
      const options = mockSendQuery.mock.calls.at(-1)?.[3] as { nativeTools: NativeTool[] };
      const report = options.nativeTools.find(tool => tool.name === 'report_workflow_no_match')!;
      await report.handler({});
      await report.handler({});
      yield {
        type: 'agent_message_chunk' as const,
        text: 'No workflow fits. Here are the alternatives.',
      };
      yield { type: 'result' as const, sessionId: 'session-1' };
    });
    await handleMessage(makePlatform(), 'conv-1', 'please do this work', { actor: operator });
    expect(mockCaptureWorkflowNoMatch).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowNoMatch).toHaveBeenCalledWith('native_tool');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('every chat gets invoke_workflow and register_project; scoped chats also get manage_run', async () => {
    await handleMessage(makePlatform(), 'conv-1', 'hello', { actor: operator });
    expect(turnToolNames()).toEqual([
      'invoke_workflow',
      'register_project',
      'report_workflow_no_match',
    ]);

    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    await handleMessage(makePlatform(), 'conv-1', 'hello', { actor: operator });
    expect(turnToolNames()).toEqual([
      'invoke_workflow',
      'register_project',
      'report_workflow_no_match',
      'manage_run',
    ]);
  });

  test('a background surface dispatches the typed prompt verbatim after the turn', async () => {
    const results: string[] = [];
    agentInvokes([launch], results);
    await handleMessage(makePlatform(), 'conv-1', 'fix the login bug', { actor: operator });

    expect(results[0]).toContain('Queued test-workflow on test-repo');
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessage: task }),
      expect.anything()
    );
  });

  test('inputs supplied on the launch reach the dispatch gate and the run', async () => {
    const results: string[] = [];
    agentInvokes([{ ...launch, inputs: '{"base_branch":"dev"}' }], results);
    await handleMessage(makePlatform(), 'conv-1', 'release from dev', { actor: operator });

    expect(results[0]).toContain('with inputs: base_branch=dev');
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { base_branch: 'dev' } }),
      expect.anything()
    );
  });

  test('a foreground surface runs the launch in the foreground with the isolation hints', async () => {
    mockGetCodebase.mockResolvedValue(makeCodebase());
    const isolationHints = { workflowType: 'issue', workflowId: '42' } as const;
    agentInvokes([launch], []);
    await handleMessage(makeForegroundPlatform(), 'conv-1', 'fix the login bug', {
      actor: operator,
      isolationHints,
    });

    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockValidateAndResolveIsolation.mock.calls[0]?.[4]).toMatchObject(isolationHints);
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
  });

  test('a launch sees a project registered earlier in the same turn', async () => {
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    const results: string[] = [];
    mockSendQuery.mockImplementationOnce(async function* () {
      const options = mockSendQuery.mock.calls.at(-1)?.[3] as { nativeTools: NativeTool[] };
      mockListCodebases.mockImplementation(() => Promise.resolve([makeCodebase()]));
      results.push(
        await options.nativeTools.find(t => t.name === 'invoke_workflow')!.handler(launch)
      );
      yield { type: 'result', sessionId: 'session-1' };
    });
    await handleMessage(makePlatform(), 'conv-1', 'clone and fix', { actor: operator });

    expect(results[0]).toContain('Queued test-workflow on test-repo');
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
  });

  test('a second launch in the same turn is refused and only the first dispatches', async () => {
    const results: string[] = [];
    agentInvokes([launch, { ...launch, prompt: 'something else' }], results);
    await handleMessage(makePlatform(), 'conv-1', 'fix the login bug', { actor: operator });

    expect(results[1]).toContain('Only one workflow launch per reply');
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ originalMessage: task }),
      expect.anything()
    );
  });

  test.each(['stream', 'batch'] as const)(
    'a turn that ends in an error result drops its queued launch (%s)',
    async mode => {
      mockSendQuery.mockImplementationOnce(async function* () {
        const options = mockSendQuery.mock.calls.at(-1)?.[3] as { nativeTools: NativeTool[] };
        await options.nativeTools.find(t => t.name === 'invoke_workflow')!.handler(launch);
        yield { type: 'result', isError: true, errorSubtype: 'error_max_turns' };
      });
      const platform = makePlatform();
      platform.getStreamingMode.mockReturnValue(mode);
      await handleMessage(platform, 'conv-1', 'fix the login bug', { actor: operator });

      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    }
  );

  test('a turn that throws after queueing a launch dispatches nothing', async () => {
    mockSendQuery.mockImplementationOnce(async function* () {
      const options = mockSendQuery.mock.calls.at(-1)?.[3] as { nativeTools: NativeTool[] };
      await options.nativeTools.find(t => t.name === 'invoke_workflow')!.handler(launch);
      yield { type: 'agent_message_chunk', text: 'On it.' };
      throw new Error('provider crashed');
    });
    await handleMessage(makePlatform(), 'conv-1', 'fix the login bug', { actor: operator });

    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('a /invoke-workflow line in the reply is plain text', async () => {
    const reply = '/invoke-workflow test-workflow --project test-repo --prompt "x"\n';
    agentInvokes([], [], reply);
    const platform = makePlatform();
    platform.getStreamingMode.mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'hello', { actor: operator });

    expect(platform.sendMessage.mock.calls.map(c => c[1])).toContain(reply);
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});

// ─── Natural-language approval routing ──────────────────────────────────────

describe('paused approval gate routing', () => {
  const approvalWorkflow = makeTestResolvedWorkflow({ name: 'prd' });

  type ManageRunHandler = (input: Record<string, unknown>) => Promise<string>;

  function makePausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return makeRun({
      workflow_name: 'prd',
      metadata: { approval: { nodeId: 'gate-1', message: 'Please review the plan' } },
      ...overrides,
    });
  }

  /** The prompt handed to the provider on the most recent turn. */
  function lastPrompt(): string {
    const call = mockSendQuery.mock.calls.at(-1) as unknown[] | undefined;
    return (call?.[0] as string | undefined) ?? '';
  }

  /**
   * The `manage_run` tool the orchestrator injected for the turn currently in
   * flight. Read from `mock.calls` rather than the generator's own parameters so
   * the once-implementation keeps the zero-arg shape the rest of this file uses.
   */
  function inFlightManageRunTool(): { name: string; handler: ManageRunHandler } | undefined {
    const call = mockSendQuery.mock.calls.at(-1) as unknown[] | undefined;
    const options = call?.[3] as
      | { nativeTools?: { name: string; handler: ManageRunHandler }[] }
      | undefined;
    return options?.nativeTools?.find(t => t.name === 'manage_run');
  }

  /** Have the agent call `manage_run` once with `input`, then finish its turn. */
  function agentCallsManageRun(input: Record<string, unknown>, sink: string[]): void {
    mockSendQuery.mockImplementationOnce(async function* () {
      const tool = inFlightManageRunTool();
      if (tool) sink.push(await tool.handler(input));
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  }

  /**
   * Wire a project-scoped, native-tool chat sitting on an unresolved gate.
   * Returns the paused run so a test can assert against the same object the
   * continuation receives.
   */
  function arrangeGatedChat(runOverrides: Partial<WorkflowRun> = {}) {
    const codebase = makeCodebase();
    const run = makePausedRun(runOverrides);
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' }))
    );
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(run));
    mockGetWorkflowRunDb.mockImplementation(() => Promise.resolve(run));
    mockFindWorkflowRunsByIdPrefix.mockImplementation(() => Promise.resolve([run]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({
        workflows: [{ workflow: approvalWorkflow, source: 'project' }],
        errors: [],
      })
    );
    return run;
  }

  let capsMock: ReturnType<typeof mock>;
  let prevExistsSyncImpl: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(async () => {
    mockGetPausedWorkflowRun.mockReset();
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
    mockGetWorkflowRunDb.mockReset();
    mockGetWorkflowRunDb.mockImplementation(() => Promise.resolve(makePausedRun()));
    mockFindWorkflowRunsByIdPrefix.mockReset();
    mockFindWorkflowRunsByIdPrefix.mockImplementation(() => Promise.resolve([]));
    mockCreateWorkflowEvent.mockReset();
    mockCreateWorkflowEvent.mockImplementation(() => Promise.resolve());
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockExecuteWorkflow.mockClear();
    mockFindResumableRunByParentConversation.mockReset();
    mockFindResumableRunByParentConversation.mockImplementation(() => Promise.resolve(null));
    mockHydrateResumableRun.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockUpdateWorkflowRun.mockImplementation(() => Promise.resolve());
    mockResolveApprovalGate.mockClear();
    mockResolveApprovalGate.mockImplementation(() => Promise.resolve({ resolved: true }));
    mockResolveAndCancelApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockImplementation(() => Promise.resolve({ resolved: true }));
    mockCaptureApprovalResolved.mockClear();
    mockSendQuery.mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    // These turns reach the AI, so the provider must report native-tool support
    // for `manage_run` to be injected. Restored in afterEach.
    const providers = await import('@archon/providers');
    capsMock = providers.getProviderCapabilities as ReturnType<typeof mock>;
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools: true });
    // `fs.existsSync` is a file-wide mock other suites mutate (#2551 turns it
    // into a shared predicate reset in only one describe). Force the value these
    // tests need rather than inheriting whatever ran last — a false here would
    // short-circuit the turn before the gate context is ever built.
    const fs = await import('fs');
    const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof mock>;
    prevExistsSyncImpl = existsSyncMock.getMockImplementation();
    existsSyncMock.mockImplementation(() => true);
  });

  afterEach(async () => {
    // Restore the shared baseline, not a hand-written subset. A subset here
    // silently drops every other flag for the REST OF THE FILE — that is how
    // `effortControl` went missing for `resolveTitleRequest` once already
    // (#2556), and this block reintroduced it on merge.
    capsMock.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
    // Undo the forced `true` above so this describe block doesn't leak its own
    // override forward onto whatever suite runs next in the same file — the
    // same class of cross-suite fs.existsSync bleed #2551 fixed in the other
    // direction.
    const fs = await import('fs');
    (fs.existsSync as unknown as ReturnType<typeof mock>).mockImplementation(
      prevExistsSyncImpl ?? (() => true)
    );
  });

  // ── The removed behaviour: prose no longer decides the gate ────────────────

  test('an approving-sounding message no longer resolves the gate by itself', async () => {
    arrangeGatedChat();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good, proceed with implementation', {
      actor: operator,
    });

    // Nothing was resolved and nothing resumed — the message went to the agent.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Resuming')
    );
    expect(mockSendQuery).toHaveBeenCalled();
  });

  test('a rejecting message is never recorded as an approval', async () => {
    arrangeGatedChat();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'no, stop — why is it editing the schema?', {
      actor: operator,
    });

    // The regression this issue exists for: an objection used to resolve the
    // gate as APPROVED and store the objection itself as the approval comment.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockSendQuery).toHaveBeenCalled();
  });

  test('an ambiguous message resolves nothing and leaves the gate open', async () => {
    arrangeGatedChat();

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'what would that change?', { actor: operator });

    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Resuming')
    );
  });

  // ── The gate reaches the agent as context ──────────────────────────────────

  test('an open gate is handed to the agent as prompt context', async () => {
    arrangeGatedChat();

    await handleMessage(makePlatform(), 'conv-1', 'what would that change?', { actor: operator });

    expect(mockGetPausedWorkflowRun).toHaveBeenCalledWith('conv-1-db', 'codebase-1');
    const prompt = lastPrompt();
    expect(prompt).toContain('## Paused Approval Gate');
    expect(prompt).toContain('run-1');
    expect(prompt).toContain('Please review the plan');
    expect(prompt).toContain('gate-1');
    // The gate must sit immediately before the message it is most likely about.
    expect(prompt.indexOf('## Paused Approval Gate')).toBeLessThan(
      prompt.indexOf('## User Message')
    );
  });

  test('no paused run means no gate section', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));

    await handleMessage(makePlatform(), 'conv-1', 'hello world', { actor: operator });

    expect(lastPrompt()).not.toContain('## Paused Approval Gate');
  });

  test('a gate already resolved and awaiting resume produces no gate section', async () => {
    arrangeGatedChat({
      metadata: {
        approval: { nodeId: 'gate-1', message: 'Please review the plan', resolved: 'approved' },
      },
    });

    await handleMessage(makePlatform(), 'conv-1', 'sounds good', { actor: operator });

    // Nothing for a human to decide — the run is only waiting to be resumed.
    expect(lastPrompt()).not.toContain('## Paused Approval Gate');
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('a paused run with a malformed legacy approval context sends the user to inspect or reject it', async () => {
    arrangeGatedChat({ metadata: {} });

    await handleMessage(makePlatform(), 'conv-1', 'looks good', { actor: operator });

    // approve refuses an unreadable gate, so naming it would hand the user a command that
    // fails; reject still accepts a legacy gate whose metadata is unreadable.
    const prompt = lastPrompt();
    expect(prompt).toContain('## Paused Approval Gate');
    expect(prompt).toContain('missing or malformed');
    expect(prompt).toContain('/workflow get run-1');
    expect(prompt).not.toContain('/workflow approve run-1');
    expect(prompt).toContain('/workflow reject run-1 <reason>');
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('a slash command never reaches the gate lookup', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: 'codebase-1' }))
    );
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({ success: true, message: 'status ok', workflow: undefined })
    );

    await handleMessage(makePlatform(), 'conv-1', '/status', { actor: operator });

    expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
  });

  // ── Resolution through manage_run also continues the run ───────────────────

  test('the agent approving through manage_run resolves the gate AND resumes the run', async () => {
    const run = arrangeGatedChat();
    const toolReplies: string[] = [];
    agentCallsManageRun(
      { action: 'approve', runId: 'run-1', confirm: true, message: 'looks good, ship it' },
      toolReplies
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good, ship it', { actor: operator });

    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'gate-1',
          message: 'Please review the plan',
          resolved: 'approved',
          answeredVia: 'manage_run',
          answeredAt: expect.any(String),
        },
        approval_response: 'approved',
        rejection_reason: '',
        rejection_count: 0,
      },
      expect.any(Array),
      undefined
    );
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
    // Continuation: resolution without it would leave the run stranded (#2565).
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Continuation requested')
    );
    expect(mockHydrateResumableRun).toHaveBeenCalled();
    const hydrated = mockHydrateResumableRun.mock.calls[0] as unknown[];
    expect((hydrated[1] as { id: string }).id).toBe(run.id);
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    // The tool acknowledges the continuation request before the host prepares it.
    expect(toolReplies[0]).toContain('Continuation requested');
  });

  test('the agent rejecting a gate with on_reject rework resumes the run', async () => {
    arrangeGatedChat({
      metadata: {
        approval: {
          nodeId: 'gate-1',
          message: 'Please review the plan',
          onRejectPrompt: 'Address $REJECTION_REASON',
        },
      },
    });
    const toolReplies: string[] = [];
    agentCallsManageRun(
      { action: 'reject', runId: 'run-1', confirm: true, message: 'the schema change is wrong' },
      toolReplies
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'no, the schema change is wrong', { actor: operator });

    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(toolReplies[0]).toContain('Continuation requested');
  });

  test('a reject that cancels the run does not try to resume it', async () => {
    arrangeGatedChat();
    const toolReplies: string[] = [];
    agentCallsManageRun(
      { action: 'reject', runId: 'run-1', confirm: true, message: 'abandon this' },
      toolReplies
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'no, drop it', { actor: operator });

    // No on_reject prompt on the gate → the run is cancelled, which IS its
    // terminal state. Nothing to continue.
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Resuming')
    );
    expect(toolReplies[0]).toContain('Nothing further runs');
  });

  test('slash command with leading whitespace still bypasses approval interception (regression)', async (): Promise<void> => {
    // Some inbound surfaces (e.g. a platform that doesn't pre-trim after
    // stripping a bot mention) can hand handleMessage a command with leading
    // whitespace. It must still be recognized as a command, not treated as
    // a natural-language approval response or routed to the AI.
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({ success: true, message: 'status ok', workflow: undefined })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '   /status', { actor: operator });

    expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    // The platform rides along so command suggestions use its spelling.
    expect(mockHandleCommand).toHaveBeenCalledWith(conversation, '   /status', operator, platform);
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'status ok');
  });

  test('a provider crash after the gate is resolved still continues the run', async () => {
    // The resolution commits to the DB the moment the tool call returns. If the
    // rest of the turn throws — a provider subprocess crash, a dropped stream —
    // skipping the continuation would leave the run resolved and parked with
    // only a generic error to show for it.
    arrangeGatedChat();
    const toolReplies: string[] = [];
    mockSendQuery.mockImplementationOnce(async function* () {
      const tool = inFlightManageRunTool();
      if (tool) {
        toolReplies.push(await tool.handler({ action: 'approve', runId: 'run-1', confirm: true }));
      }
      yield { type: 'agent_message_chunk', text: 'Approved.' };
      throw new Error('provider subprocess exited unexpectedly');
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'ship it', { actor: operator });

    expect(mockResolveApprovalGate).toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Continuation requested')
    );
  });

  test.each([
    { action: 'approve', decision: undefined },
    { action: 'reject', decision: undefined },
    { action: 'respond', decision: 'reject' },
    { action: 'respond', decision: 'approve' },
  ])(
    'Codex drains an in-flight gate decision after process exit: %j',
    async ({ action, decision }) => {
      const { CodexProvider } = await import('@archon/providers/codex/provider');
      const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
      const { createFakeAppServer, THREAD_ID, TURN_ID } = await import(
        '../../../providers/src/test/codex-app-server-fake'
      );
      capsMock.mockReturnValue(CODEX_CAPABILITIES);
      arrangeGatedChat({
        metadata: { approval: { nodeId: 'gate-1', message: 'Review', onRejectPrompt: 'Rework' } },
      });
      const entered = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      mockResolveApprovalGate.mockImplementationOnce(async () => {
        entered.resolve();
        await commit.promise;
        return { resolved: true };
      });
      const server = createFakeAppServer(() => ({
        toolCalls: [
          {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            callId: 'gate',
            namespace: null,
            tool: 'manage_run',
            arguments: { action, decision, runId: 'run-1', confirm: true, message: 'feedback' },
          },
        ],
      }));
      const provider = new CodexProvider(server, 1);
      mockSendQuery.mockImplementationOnce((...args) => provider.sendQuery(...args));
      const platform = makePlatform();
      let returned = false;
      const handling = handleMessage(platform, 'conv-1', 'resolve the gate', {
        actor: operator,
      }).finally(() => {
        returned = true;
      });
      await entered.promise;
      server.processes[0].exit(1);
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      const returnedBeforeCommit = returned;
      commit.resolve();
      await handling;
      expect(returnedBeforeCommit).toBe(false);
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockHydrateResumableRun).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('Continuation requested')
      );
      expect(server.processes[0].toolResponses).toHaveLength(0);
    }
  );

  test('a container run is resolved but not resumed from chat', async () => {
    // Chat cannot rewire the container, so the executor would refuse the resume.
    arrangeGatedChat({
      metadata: { approval: { nodeId: 'gate-1', message: 'Apply?' }, isolation: 'container' },
    });
    const toolReplies: string[] = [];
    agentCallsManageRun({ action: 'approve', runId: 'run-1', confirm: true }, toolReplies);

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'apply the changes', { actor: operator });

    expect(mockResolveApprovalGate).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(toolReplies[0]).toContain('archon workflow resume');
    // The prompt must have warned the agent before it acted.
    expect(lastPrompt()).toContain('isolation container');
  });

  test('an unscoped conversation gets the gate but no instruction to resolve it', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(makePausedRun()));

    await handleMessage(makePlatform(), 'conv-1', 'looks good', { actor: operator });

    expect(mockGetPausedWorkflowRun).toHaveBeenCalledWith('conv-1-db', undefined);
    const prompt = lastPrompt();
    expect(prompt).toContain('## Paused Approval Gate');
    expect(prompt).toContain('no project is attached');
    expect(prompt).not.toContain('resolve the gate as APPROVED');
  });

  test('manage_run without confirm previews the gate action and resolves nothing', async () => {
    arrangeGatedChat();
    const toolReplies: string[] = [];
    agentCallsManageRun({ action: 'approve', runId: 'run-1' }, toolReplies);

    await handleMessage(makePlatform(), 'conv-1', 'maybe approve it?', { actor: operator });

    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(toolReplies[0]).toContain('confirm');
  });

  test('a resolved gate whose workflow is gone reports the decision and stops', async () => {
    arrangeGatedChat();
    // Discovery finds nothing, so the continuation cannot locate the definition.
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    const toolReplies: string[] = [];
    agentCallsManageRun({ action: 'approve', runId: 'run-1', confirm: true }, toolReplies);

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'ship it', { actor: operator });

    expect(mockResolveApprovalGate).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('was not found')
    );
  });
});
