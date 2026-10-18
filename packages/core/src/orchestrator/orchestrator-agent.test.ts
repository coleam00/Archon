// @archon-test-isolated
/** Covers `handleMessage` in orchestrator-agent.ts; shared mocks live in `../test/orchestrator-agent-harness`. */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { IPlatformAdapter } from '../types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { NativeTool } from '@archon/providers/types';

import {
  DEFAULT_PROVIDER_CAPS,
  canonicalizeProjectPath,
  makeCodebase,
  makeCodebaseForSync,
  makeConfig,
  makeConversation,
  makeMessage,
  makeNamedCodebase,
  makePlatform,
  makeRun,
  makeSession,
  mockAddMessage,
  mockCaptureApprovalResolved,
  mockCaptureChatTurn,
  mockCreateCodebase,
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
  mockGetRecentWorkflowResultMessages,
  mockGetWorkflowRunDb,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockListCodebases,
  mockLoadConfig,
  mockLogger,
  mockParseCommand,
  mockRegisterFolder,
  mockRegisterRepository,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockSendQuery,
  mockTransitionSession,
  mockUpdateConversation,
  mockUpdateSession,
  mockUpdateWorkflowRun,
  mockValidateAndResolveIsolation,
  operator,
  makeDispatchConversation,
  makeForegroundPlatform,
  resetDispatchMocks,
} from '../test/orchestrator-agent-harness';
import { handleMessage } from './orchestrator-agent';

// ─── filterToolIndicators (tested indirectly through known behavior) ──────────
//
// filterToolIndicators is a private function but its logic is straightforward
// enough to test directly by replicating its behavior with the same regex.
// We test it by exercising the exact same filtering pattern it uses.

describe('filterToolIndicators logic (replicated regex tests)', () => {
  // This replicates the exact regex and logic from filterToolIndicators
  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;

  function applyFilter(messages: string[]): string {
    if (messages.length === 0) return '';
    const allMessages = messages.join('\n\n---\n\n');
    const sections = allMessages.split('\n\n');
    const cleanSections = sections.filter(section => {
      const trimmed = section.trim();
      return !toolIndicatorRegex.exec(trimmed);
    });
    const finalMessage = cleanSections.join('\n\n').trim();
    return finalMessage || allMessages;
  }

  test('returns empty string for empty array', () => {
    expect(applyFilter([])).toBe('');
  });

  test('preserves non-tool-indicator text unchanged', () => {
    const result = applyFilter(['This is a regular message.']);
    expect(result).toBe('This is a regular message.');
  });

  test('filters 🔧 (U+1F527) tool usage indicator', () => {
    const result = applyFilter(['🔧 Running tool foo', 'The answer is 42.']);
    expect(result).not.toContain('🔧');
    expect(result).toContain('The answer is 42.');
  });

  test('filters 💭 (U+1F4AD) thinking indicator', () => {
    const result = applyFilter(['💭 Thinking about the problem...', 'Here is my response.']);
    expect(result).not.toContain('💭');
    expect(result).toContain('Here is my response.');
  });

  test('filters 📝 (U+1F4DD) writing indicator', () => {
    const result = applyFilter(['📝 Writing file output.txt', 'Done writing.']);
    expect(result).not.toContain('📝');
    expect(result).toContain('Done writing.');
  });

  test('filters ✏️ (U+270F+FE0F) editing indicator', () => {
    const result = applyFilter(['\u{270F}\u{FE0F} Editing main.ts', 'Edit complete.']);
    expect(result).not.toContain('\u{270F}');
    expect(result).toContain('Edit complete.');
  });

  test('filters 🗑️ (U+1F5D1+FE0F) deleting indicator', () => {
    const result = applyFilter(['\u{1F5D1}\u{FE0F} Deleting temp file', 'File removed.']);
    expect(result).not.toContain('\u{1F5D1}');
    expect(result).toContain('File removed.');
  });

  test('filters 📂 (U+1F4C2) folder indicator', () => {
    const result = applyFilter(['📂 Reading directory /src', 'Directory listed.']);
    expect(result).not.toContain('📂');
    expect(result).toContain('Directory listed.');
  });

  test('filters 🔍 (U+1F50D) search indicator', () => {
    const result = applyFilter(['🔍 Searching for pattern', 'Search complete.']);
    expect(result).not.toContain('🔍');
    expect(result).toContain('Search complete.');
  });

  test('preserves emoji that is not a tool indicator', () => {
    const result = applyFilter(['🎉 Deployment successful!']);
    expect(result).toContain('🎉 Deployment successful!');
  });

  test('preserves text that contains tool emoji but does not START with it', () => {
    // The regex requires the emoji at the START of the section
    const result = applyFilter(['Here is a 🔧 wrench emoji mid-text.']);
    expect(result).toContain('🔧');
  });

  test('falls back to all messages when everything gets filtered out', () => {
    // If all sections are tool indicators, return the raw joined messages
    const messages = ['🔧 Tool call one', '💭 Thinking...'];
    const result = applyFilter(messages);
    // The fallback returns allMessages (raw join)
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles multiple assistant messages joined with separator', () => {
    const messages = [
      'First part of the response.',
      '🔧 Some tool usage here',
      'Second part of the response.',
    ];
    const result = applyFilter(messages);
    expect(result).toContain('First part of the response.');
    expect(result).toContain('Second part of the response.');
    expect(result).not.toContain('🔧 Some tool usage here');
  });

  test('sections within a single message are split by double newlines', () => {
    // A single message with embedded double-newline creates multiple sections
    const messages = ['Normal text.\n\n🔧 Tool output.\n\nMore normal text.'];
    const result = applyFilter(messages);
    expect(result).toContain('Normal text.');
    expect(result).toContain('More normal text.');
    expect(result).not.toContain('🔧');
  });

  test('trims whitespace from the final output', () => {
    const result = applyFilter(['  Regular text with leading spaces.  ']);
    expect(result).toBe('Regular text with leading spaces.');
  });

  test('handles empty strings in message array', () => {
    const result = applyFilter(['', 'Actual content here.', '']);
    expect(result).toContain('Actual content here.');
  });
});

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
    'Codex launches through item/tool/call after the turn; prose cannot launch (%s)',
    async mode => {
      const { CodexProvider } = await import('@archon/providers/codex/provider');
      const { CODEX_CAPABILITIES } = await import('../../../providers/src/codex/capabilities');
      const { createFakeAppServer, THREAD_ID, TURN_ID, agentMessage } = await import(
        '../../../providers/src/test/codex-app-server-fake'
      );
      capsMock.mockReturnValue(CODEX_CAPABILITIES);
      const prose =
        '/invoke-workflow test-workflow --project test-repo --prompt "prose must not launch"';
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

  test('every chat gets invoke_workflow and register_project; scoped chats also get manage_run', async () => {
    await handleMessage(makePlatform(), 'conv-1', 'hello', { actor: operator });
    expect(turnToolNames()).toEqual(['invoke_workflow', 'register_project']);

    mockGetOrCreateConversation.mockResolvedValueOnce(makeDispatchConversation());
    mockGetCodebase.mockResolvedValueOnce(makeCodebase());
    await handleMessage(makePlatform(), 'conv-1', 'hello', { actor: operator });
    expect(turnToolNames()).toEqual(['invoke_workflow', 'register_project', 'manage_run']);
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

  test('the command scan is off: a /invoke-workflow line in the reply is plain text', async () => {
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

// ─── handleMessage — workflow context injection ───────────────────────────────

describe('handleMessage — workflow context injection', () => {
  beforeEach(() => {
    mockGetRecentWorkflowResultMessages.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
  });

  test('calls getRecentWorkflowResultMessages for the conversation', async () => {
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What happened?', { actor: operator });

    expect(mockGetRecentWorkflowResultMessages).toHaveBeenCalledWith('conv-1-db', 3);
  });

  test('does not throw when getRecentWorkflowResultMessages returns empty array', async () => {
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'Hello', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('handles malformed metadata JSON without throwing', async () => {
    const badRow = {
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: 'not-valid-json',
      user_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([badRow]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'What did the workflow do?', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('handles metadata with missing workflowResult key gracefully', async () => {
    const rowNoWorkflowResult = {
      id: 'msg-2',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: '{"someOtherKey":"value"}',
      user_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([rowNoWorkflowResult]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'Follow-up', { actor: operator })
    ).resolves.toBeUndefined();
  });

  test('continues without workflow context when outer fetch throws', async () => {
    mockGetRecentWorkflowResultMessages.mockRejectedValueOnce(new Error('unexpected'));
    const platform = makePlatform();

    // Non-critical path — must not block message handling
    await expect(
      handleMessage(platform, 'conv-1', 'Hello', { actor: operator })
    ).resolves.toBeUndefined();
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
