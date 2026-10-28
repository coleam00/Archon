// @archon-test-isolated
/** Covers project-commands.ts through `handleMessage`; shared mocks live in `../test/orchestrator-agent-harness`. */
import { ActiveContainerEnvironmentsError } from '../db/codebase-delete-error';
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { quoteCommandArg } from '../utils/command-args';
import {
  DEFAULT_PROVIDER_CAPS,
  makeRun,
  mockFindWorkflowRunsByIdPrefix,
  mockDispatchBackgroundWorkflow,
  mockGetCodebase,
  mockSendQuery,
  mockRegisterFolder,
  resetDispatchMocks,
  MockCodebaseNotFoundError,
  MockSessionNotFoundError,
  canonicalizeProjectPath,
  makeConversation,
  makeNamedCodebase,
  makePlatform,
  makeSession,
  mockCreateCodebase,
  mockDeactivateSession,
  mockDeleteCodebase,
  mockDetachConversationProject,
  mockGetActiveSession,
  mockGetConversationByPlatformId,
  mockGetOrCreateConversation,
  mockListCodebases,
  mockParseCommand,
  mockRegisterRepository,
  mockRepairCodebaseRegistration,
  mockUpdateCodebase,
  mockUpdateConversation,
  operator,
} from '../test/orchestrator-agent-harness';
import { handleRegisterProject } from './project-commands';
import { handleMessage } from './orchestrator-agent';
import { buildOrchestratorSystemAppend } from './prompt-builder';

const trackTempRoot = trackTempRoots();

// ─── handleMessage — /setproject dispatch ─────────────────────────────────────

describe('handleMessage — /setproject dispatch', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockUpdateConversation.mockReset();
    mockParseCommand.mockReset();
    mockGetActiveSession.mockReset();
    mockDeactivateSession.mockReset();

    mockUpdateConversation.mockImplementation(() => Promise.resolve());
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockGetActiveSession.mockImplementation(() => Promise.resolve(null));
    mockDeactivateSession.mockImplementation(() => Promise.resolve());
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(makeConversation({ codebase_id: null }))
    );
  });

  for (const name of ['none', 'clear', '-']) {
    test(`selects a project literally named ${name}`, async () => {
      mockListCodebases.mockResolvedValue([makeNamedCodebase(name)]);
      mockParseCommand.mockReturnValue({ command: 'setproject', args: [name] });
      await handleMessage(makePlatform(), 'conv-1', `/setproject ${name}`, { actor: operator });
      expect(mockUpdateConversation).toHaveBeenCalledWith(expect.any(String), {
        codebase_id: `id-${name}`,
        cwd: null,
        isolation_env_id: null,
      });
    });
  }

  test('binds conversation to exact-match codebase', async () => {
    const cb = makeNamedCodebase('my-app');
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-conv-1',
          platform_conversation_id: 'conv-1',
          codebase_id: null,
          cwd: '/old/worktree',
          isolation_env_id: 'env-old',
        })
      )
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    expect(mockUpdateConversation).toHaveBeenCalledWith('db-conv-1', {
      codebase_id: 'id-my-app',
      cwd: null,
      isolation_env_id: null,
    });
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', expect.stringContaining('my-app'));
  });

  test('resolves by case-insensitive match', async () => {
    const cb = makeNamedCodebase('My-App');
    // Distinct DB id vs platform id: proves the update targets conversation.id.
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-conv-ci',
          platform_conversation_id: 'conv-1',
          codebase_id: null,
        })
      )
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    expect(mockUpdateConversation).toHaveBeenCalledWith('db-conv-ci', {
      codebase_id: 'id-My-App',
      cwd: null,
      isolation_env_id: null,
    });
  });

  test('resolves by prefix match', async () => {
    const cb = makeNamedCodebase('my-website');
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-conv-px',
          platform_conversation_id: 'conv-1',
          codebase_id: null,
        })
      )
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-web'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-web', { actor: operator });

    expect(mockUpdateConversation).toHaveBeenCalledWith('db-conv-px', {
      codebase_id: 'id-my-website',
      cwd: null,
      isolation_env_id: null,
    });
  });

  test('resolves by substring match', async () => {
    const cb = makeNamedCodebase('archon-my-api');
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-conv-ss',
          platform_conversation_id: 'conv-1',
          codebase_id: null,
        })
      )
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-api'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-api', { actor: operator });

    expect(mockUpdateConversation).toHaveBeenCalledWith('db-conv-ss', {
      codebase_id: 'id-archon-my-api',
      cwd: null,
      isolation_env_id: null,
    });
  });

  test('writes to the DB conversation id, not the platform conversation id', async () => {
    // Regression: on Telegram/GitHub the platform conversation id (chat id,
    // owner/repo#n) differs from the conversations-table primary key. /setproject
    // must update by the DB id, otherwise the UPDATE matches 0 rows and throws
    // "Conversation not found: <platform-id>".
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-hex-id',
          platform_type: 'telegram',
          platform_conversation_id: '40865006',
          codebase_id: null,
        })
      )
    );

    const platform = makePlatform();
    await handleMessage(platform, '40865006', '/setproject my-app', { actor: operator });

    expect(mockUpdateConversation).toHaveBeenCalledWith('db-hex-id', {
      codebase_id: 'id-my-app',
      cwd: null,
      isolation_env_id: null,
    });
    // The reply still goes to the platform conversation id.
    expect(platform.sendMessage).toHaveBeenCalledWith(
      '40865006',
      expect.stringContaining('my-app')
    );
  });

  test('deactivates active provider session when project changes', async () => {
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
    mockGetActiveSession.mockImplementation(() =>
      Promise.resolve(makeSession({ id: 'session-123', conversation_id: 'conv-1' }))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    expect(mockDeactivateSession).toHaveBeenCalledWith('session-123', 'project-changed');
  });

  test('treats SessionNotFoundError during deactivation as benign (TOCTOU race)', async () => {
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
    mockGetActiveSession.mockImplementation(() =>
      Promise.resolve(makeSession({ id: 'session-gone', conversation_id: 'conv-1' }))
    );
    mockDeactivateSession.mockImplementation(() =>
      Promise.reject(new MockSessionNotFoundError('session-gone'))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    // The race is benign: the command still completes and reports success.
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('Project set to');
  });

  test('aborts BEFORE rebinding the conversation when the session lookup fails', async () => {
    // Ordering regression guard: session deactivation runs before
    // db.updateConversation, so a failure here must leave the conversation
    // untouched (no rebound project with the old session still active).
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
    mockGetActiveSession.mockImplementation(() => Promise.reject(new Error('db hiccup')));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).not.toContain('Project set to');
  });

  test('rethrows non-SessionNotFoundError deactivation failures without rebinding', async () => {
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
    mockGetActiveSession.mockImplementation(() =>
      Promise.resolve(makeSession({ id: 'session-123', conversation_id: 'conv-1' }))
    );
    mockDeactivateSession.mockImplementation(() => Promise.reject(new Error('db exploded')));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    // Deactivation runs before the rebind, so the conversation stays untouched.
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    // The failure surfaces: no success message, but SOME error reply went out
    // (a silently-swallowed error would send nothing at all).
    const sentMsgs = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
      String(c[1])
    );
    expect(sentMsgs.join('\n')).not.toContain('Project set to');
    expect(sentMsgs.length).toBeGreaterThan(0);
  });

  test('notes the detached worktree in the reply when an isolation env was cleared', async () => {
    const cb = makeNamedCodebase('my-app');
    mockGetOrCreateConversation.mockImplementation(() =>
      Promise.resolve(
        makeConversation({
          id: 'db-conv-wt',
          platform_conversation_id: 'conv-1',
          codebase_id: 'old-cb',
          cwd: '/old/worktree',
          isolation_env_id: 'env-old',
        })
      )
    );
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('Project set to');
    expect(sent).toContain('previous worktree was detached');
  });

  test('omits the worktree note when no isolation env was attached', async () => {
    const cb = makeNamedCodebase('my-app');
    mockListCodebases.mockImplementation(() => Promise.resolve([cb]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject my-app', { actor: operator });

    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('Project set to');
    expect(sent).not.toContain('previous worktree');
  });

  test('returns not-found message listing available projects', async () => {
    mockListCodebases.mockImplementation(() =>
      Promise.resolve([makeNamedCodebase('project-a'), makeNamedCodebase('project-b')])
    );
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['nonexistent'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject nonexistent', { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('nonexistent');
    expect(msg).toContain('project-a');
    expect(msg).toContain('project-b');
  });

  test('returns not-found with /register-project hint when no codebases registered', async () => {
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['anything'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject anything', { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('/register-project');
  });

  test('returns ambiguity message on multiple prefix matches', async () => {
    mockListCodebases.mockImplementation(() =>
      Promise.resolve([makeNamedCodebase('app-backend'), makeNamedCodebase('app-frontend')])
    );
    mockParseCommand.mockReturnValue({ command: 'setproject', args: ['app'] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject app', { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('Ambiguous');
    expect(msg).toContain('app-backend');
    expect(msg).toContain('app-frontend');
  });

  test('returns usage message when no args', async () => {
    mockParseCommand.mockReturnValue({ command: 'setproject', args: [] });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/setproject', { actor: operator });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', expect.stringContaining('Usage'));
  });
});

// ─── handleMessage — /update-project dispatch (issue #2085) ───────────────────

describe('handleMessage — /update-project dispatch', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockUpdateCodebase.mockReset();
    mockParseCommand.mockReset();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockListCodebases.mockImplementation(() => Promise.resolve([makeNamedCodebase('my-app')]));
    mockUpdateCodebase.mockImplementation(() => Promise.resolve());
    // '/' always exists — the handler's un-mocked existsSync check passes.
    mockParseCommand.mockReturnValue({ command: 'update-project', args: ['my-app', '/'] });
  });

  test('reports success with old and new path', async () => {
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/update-project my-app /', { actor: operator });

    expect(mockUpdateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-my-app', name: 'my-app' }),
      {
        default_cwd: await canonicalizeProjectPath('/'),
      }
    );
    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('updated');
    expect(msg).toContain('/repos/my-app');
  });

  test('row-gone failure (CodebaseNotFoundError) reports removal, not a DB error', async () => {
    mockUpdateCodebase.mockImplementation(() =>
      Promise.reject(new MockCodebaseNotFoundError('id-my-app'))
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/update-project my-app /', { actor: operator });

    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('removed');
    expect(msg).toContain('/register-project');
    expect(msg).not.toContain('database error');
  });

  test('transient DB failure reports a database error, not removal', async () => {
    mockUpdateCodebase.mockImplementation(() => Promise.reject(new Error('connection refused')));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/update-project my-app /', { actor: operator });

    const msg = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(msg).toContain('database error');
    expect(msg).toContain('try again');
    expect(msg).not.toContain('removed');
  });
});

describe('handleMessage — /detach-project dispatch', () => {
  beforeEach(() => {
    mockParseCommand.mockReturnValue({ command: 'detach-project', args: ['My App'] });
    mockGetConversationByPlatformId.mockReset();
    mockGetConversationByPlatformId.mockResolvedValue(
      makeConversation({ id: 'database-id', codebase_id: 'project-id' })
    );
    mockDetachConversationProject.mockReset();
    mockDetachConversationProject.mockResolvedValue({ status: 'detached', projectName: 'My App' });
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
  });

  for (const platformType of ['telegram', 'web', 'slack', 'discord']) {
    test(`detaches on ${platformType} before creation or inheritance`, async () => {
      const platform = {
        ...makePlatform(),
        capabilities: { ...makePlatform().capabilities, canDetachProject: true as const },
        getPlatformType: () => platformType,
      };
      await handleMessage(platform, 'platform-id', '/detach-project "My App"', {
        actor: operator,
        parentConversationId: 'parent-id',
      });
      expect(mockDetachConversationProject).toHaveBeenCalledWith({
        conversationId: 'database-id',
        projectName: 'My App',
        platformType,
        parentPlatformId: 'parent-id',
      });
      expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
      expect(mockUpdateConversation).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'platform-id',
        expect.stringContaining('now neutral')
      );
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'platform-id',
        expect.stringContaining('remains registered')
      );
    });
  }

  test('refuses undeclared eligibility without mutation', async () => {
    const platform = makePlatform();
    await handleMessage(platform, 'platform-id', '/detach-project "My App"', { actor: operator });
    expect(mockGetConversationByPlatformId).not.toHaveBeenCalled();
    expect(mockDetachConversationProject).not.toHaveBeenCalled();
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'platform-id',
      expect.stringContaining('not supported')
    );
  });

  for (const args of [[], [''], ['  '], ['My', 'App']]) {
    test(`requires one nonempty name: ${JSON.stringify(args)}`, async () => {
      mockParseCommand.mockReturnValue({ command: 'detach-project', args });
      const platform = makePlatform();
      await handleMessage(platform, 'platform-id', '/detach-project', { actor: operator });
      expect(mockDetachConversationProject).not.toHaveBeenCalled();
      expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'platform-id',
        expect.stringContaining('Usage:')
      );
    });
  }

  test('missing conversation refuses without creating it', async () => {
    mockGetConversationByPlatformId.mockResolvedValue(null);
    const platform = {
      ...makePlatform(),
      capabilities: { ...makePlatform().capabilities, canDetachProject: true as const },
    };
    await handleMessage(platform, 'platform-id', '/detach-project "My App"', { actor: operator });
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(mockDetachConversationProject).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'platform-id',
      expect.stringContaining('does not exist')
    );
  });

  test('reports every run and the environment without lifecycle actions', async () => {
    mockDetachConversationProject.mockResolvedValue({
      status: 'blocked',
      runs: [
        { id: 'full-run-id', status: 'paused' },
        { id: 'failed-run-id', status: 'failed' },
      ],
      environmentId: 'env-id',
    });
    const platform = {
      ...makePlatform(),
      capabilities: { ...makePlatform().capabilities, canDetachProject: true as const },
    };
    await handleMessage(platform, 'platform-id', '/detach-project "My App"', { actor: operator });
    const reply = String(platform.sendMessage.mock.calls[0]?.[1]);
    for (const text of [
      'full-run-id: paused',
      'failed-run-id: failed',
      'env-id',
      'manage_run',
      'CLI',
      'Web',
      'isolation controls',
    ])
      expect(reply).toContain(text);
    expect(mockUpdateConversation).not.toHaveBeenCalled();
  });

  for (const [reason, reply] of [
    ['parent-bound', 'inherit'],
    ['parent-changed', 'Retry'],
    ['name', 'exact, unambiguous'],
    ['neutral', 'already neutral'],
  ] as const) {
    test(`explains ${reason} refusal before inheritance`, async () => {
      mockDetachConversationProject.mockResolvedValue({ status: 'refused', reason });
      const platform = {
        ...makePlatform(),
        capabilities: { ...makePlatform().capabilities, canDetachProject: true as const },
      };
      await handleMessage(platform, 'platform-id', '/detach-project "My App"', { actor: operator });
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'platform-id',
        expect.stringContaining(reply)
      );
      expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    });
  }

  test('persistence failure never confirms success', async () => {
    mockDetachConversationProject.mockRejectedValue(new Error('detach database unavailable'));
    const platform = {
      ...makePlatform(),
      capabilities: { ...makePlatform().capabilities, canDetachProject: true as const },
    };
    await handleMessage(platform, 'platform-id', '/detach-project "My App"', { actor: operator });
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'platform-id',
      expect.stringContaining('now neutral')
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'platform-id',
      expect.stringContaining('detach database unavailable')
    );
  });
});

describe('handleMessage — legacy registration recovery', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockUpdateCodebase.mockReset();
    mockUpdateCodebase.mockImplementation(() => Promise.resolve());
    mockCreateCodebase.mockClear();
    mockRegisterRepository.mockClear();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockParseCommand.mockReturnValue({ command: 'register-project', args: ['My-App', '/'] });
  });

  test('explicit re-registration repairs the existing ID despite another invalid registration', async () => {
    mockListCodebases.mockResolvedValue([
      { ...makeNamedCodebase('other'), default_cwd: 'other/path' },
      { ...makeNamedCodebase('my-app'), default_cwd: 'projects/repo' },
    ]);
    const repairRoot = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-legacy-repair-')));
    const replacement = join(repairRoot, 'repo');
    await mkdir(replacement, { recursive: true });
    const platform = makePlatform();
    await handleMessage(
      platform,
      'conv-1',
      `/register-project My-App ${quoteCommandArg(replacement)}`,
      { actor: operator }
    );
    expect(mockRepairCodebaseRegistration).toHaveBeenCalledWith('id-my-app', {
      default_cwd: await canonicalizeProjectPath(replacement),
      kind: 'repo',
    });
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    expect((platform.sendMessage as ReturnType<typeof mock>).mock.calls[0]?.[1]).toContain(
      're-registered'
    );
  });

  test('remove-project renders the shared active-container refusal', async () => {
    mockListCodebases.mockResolvedValue([makeNamedCodebase('my-app')]);
    mockParseCommand.mockReturnValue({ command: 'remove-project', args: ['my-app'] });
    mockDeleteCodebase.mockRejectedValueOnce(
      new ActiveContainerEnvironmentsError(['container-one'])
    );
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/remove-project my-app', { actor: operator });
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(call => call[1])
      .join('\n');
    expect(messages).toContain('container-one');
    expect(messages).toContain('archon isolation cleanup 0');
    expect(messages).not.toContain('removed.');
  });

  test('update and removal remain available for legacy registrations', async () => {
    mockListCodebases.mockResolvedValue([
      { ...makeNamedCodebase('my-app'), default_cwd: 'projects/repo' },
    ]);
    mockParseCommand.mockReturnValue({ command: 'update-project', args: ['my-app', '/'] });
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/update-project my-app /', { actor: operator });
    expect(mockUpdateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-my-app', name: 'my-app' }),
      {
        default_cwd: await canonicalizeProjectPath('/'),
      }
    );
    mockDeleteCodebase.mockClear();
    mockParseCommand.mockReturnValue({ command: 'remove-project', args: ['my-app'] });
    await handleMessage(platform, 'conv-1', '/remove-project my-app', { actor: operator });
    expect(mockDeleteCodebase).toHaveBeenCalledWith('id-my-app');
  });

  test('a name already used at another path reaches the shared registration checks', async () => {
    mockListCodebases.mockResolvedValue([makeNamedCodebase('my-app')]);
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/register-project My-App /', { actor: operator });
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    expect(mockRegisterRepository).toHaveBeenCalledWith(await canonicalizeProjectPath('/'), {
      name: 'My-App',
    });
  });
});

describe('explicit registration syntax', () => {
  beforeEach(() => {
    mockRegisterFolder.mockClear();
    mockListCodebases.mockResolvedValue([]);
  });

  test.each([
    ['/register-project --folder demo "/tmp/with spaces"', '/tmp/with spaces'],
    ["/register-project --folder demo /tmp/O'Brien", "/tmp/O'Brien"],
  ])('%s reaches folder registration intact', async (command, path) => {
    expect(await handleRegisterProject(command)).toContain('registered');
    expect(mockRegisterFolder).toHaveBeenCalledWith(await canonicalizeProjectPath(path), 'demo');
  });

  test.each([
    '/register-project',
    '/register-project --folder demo',
    '/register-project-backup --folder demo /tmp',
  ])('%s cannot register', async command => {
    expect(await handleRegisterProject(command)).toContain('Usage:');
    expect(mockRegisterFolder).not.toHaveBeenCalled();
  });
});

describe('chat adapter project selection and capability transport', () => {
  beforeEach(resetDispatchMocks);

  for (const adapter of ['slack', 'telegram', 'discord']) {
    for (const nativeTools of [false, true]) {
      test(`${adapter} selection scopes subsequent turns (nativeTools=${nativeTools})`, async () => {
        const providers = await import('@archon/providers');
        const caps = providers.getProviderCapabilities as ReturnType<typeof mock>;
        caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS, nativeTools });
        const project = makeNamedCodebase('my-app');
        let conversation = makeConversation({
          id: 'db-conversation',
          platform_type: adapter,
          platform_conversation_id: 'adapter-thread',
          codebase_id: null,
        });
        mockGetOrCreateConversation.mockImplementation(async () => conversation);
        mockListCodebases.mockResolvedValue([project]);
        mockGetCodebase.mockResolvedValue(project);
        mockGetActiveSession.mockResolvedValue(makeSession({ id: 'old-session' }));
        mockDeactivateSession.mockClear();
        mockUpdateConversation.mockImplementation(async (_id, updates) => {
          conversation = { ...conversation, ...updates };
        });
        mockParseCommand.mockReturnValue({ command: 'setproject', args: ['my-app'] });
        const platform = makePlatform();
        platform.getPlatformType.mockReturnValue(adapter);
        try {
          await handleMessage(platform, 'adapter-thread', '/setproject my-app', {
            actor: operator,
          });
          expect(mockUpdateConversation).toHaveBeenCalledWith('db-conversation', {
            codebase_id: project.id,
            cwd: null,
            isolation_env_id: null,
          });
          expect(mockDeactivateSession).toHaveBeenCalledWith('old-session', 'project-changed');
          mockFindWorkflowRunsByIdPrefix.mockReset();
          mockFindWorkflowRunsByIdPrefix.mockResolvedValue([
            makeRun({ id: 'run-scoped', codebase_id: project.id }),
          ]);
          mockSendQuery.mockImplementationOnce(async function* (_prompt, _cwd, _session, options) {
            if (nativeTools) {
              const manage = options?.nativeTools?.find(t => t.name === 'manage_run');
              const launch = options?.nativeTools?.find(t => t.name === 'invoke_workflow');
              if (!manage || !launch) throw new Error('Missing scoped chat tools');
              expect(await manage.handler({ action: 'get', runId: 'run-scoped' })).toContain(
                'status:'
              );
              expect(
                await launch.handler({
                  workflow: 'test-workflow',
                  project: project.name,
                  prompt: 'Inspect the selected project',
                })
              ).toContain('Queued');
            }
            yield { type: 'agent_message_chunk', text: 'Ready.' };
            yield { type: 'result', sessionId: 'new-session' };
          });
          await handleMessage(
            platform,
            'adapter-thread',
            'Inspect this run, then launch the workflow',
            { actor: operator }
          );
          expect(buildOrchestratorSystemAppend).toHaveBeenLastCalledWith(
            expect.objectContaining({ codebase_id: project.id }),
            [project],
            expect.any(Array),
            nativeTools ? 'tools' : 'cli'
          );
          if (nativeTools) {
            expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith('run-scoped', project.id);
            expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
          }
          const options = mockSendQuery.mock.calls.at(-1)?.[3];
          expect(options?.nativeTools?.map(t => t.name) ?? []).toEqual(
            nativeTools
              ? ['invoke_workflow', 'register_project', 'report_workflow_no_match', 'manage_run']
              : []
          );
        } finally {
          caps.mockReturnValue({ ...DEFAULT_PROVIDER_CAPS });
        }
      });
    }
  }
});
