import {
  mockCreateWorkflowRun,
  firstDetachedSpawnOptions,
  createDetachedChildFixture,
  finishStartupWindow,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import {
  makeTestComposedWorkflow,
  makeTestWorkflow,
  makeTestWorkflowWithSource,
} from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';
import { maybePrintTierNotice } from './workflow-run-preflight';

describe('workflowRunCommand — requires: [github] gate', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let priorArchonUserId: string | undefined;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    // Deterministic CLI identity (resolveCliUserId reads ARCHON_USER_ID).
    priorArchonUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'cli-tester';

    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const usersDb = await import('@archon/core/db/users');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockClear();
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockClear();
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (priorArchonUserId === undefined) delete process.env.ARCHON_USER_ID;
    else process.env.ARCHON_USER_ID = priorArchonUserId;
  });

  it('blocks a requires:[github] workflow before any cost when enabled and not connected', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    // Hard-blocked before any worktree/AI cost — executeWorkflow never ran.
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('blocks a parent whose requirement came only from a COMPOSED block', async () => {
    // The parent declares no `requires:` of its own — the requirement unions upward from
    // the block during expansion (#1764). Without that union this refusal never happens
    // and the run fails mid-block instead, inside a file the parent cannot inspect.
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const composed = makeTestComposedWorkflow(
      [
        makeTestWorkflow({
          name: 'gh-block',
          requires: ['github'],
          nodes: [{ id: 'work', prompt: 'work' }],
        }),
        makeTestWorkflow({ name: 'composes-gh', nodes: [{ id: 'sub', include: 'gh-block' }] }),
      ],
      'composes-gh'
    );
    // The union is what the gate reads — assert it before relying on it.
    expect(composed.requires).toEqual(['github']);

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ workflow: composed, source: 'project' }],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'composes-gh', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/connected github identity/i);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('allows the run when the acting CLI user has a connected GitHub identity', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce('gho_token');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on solo installs (per-user GitHub disabled) even when github is required', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    // Default mock returns false; be explicit for readability.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(false);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Gate short-circuited on the env check — no token lookup happened.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('does not resolve GitHub connection for a workflow without requires', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });
    // Even with per-user GitHub enabled, a workflow with no `requires` skips the lookup.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
      noWorktree: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed when the acting CLI user identity cannot be resolved', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);

    // No resolvable CLI identity → resolveCliUserId() returns null → treated as
    // "not connected" (fail closed). Clear every identity source for this test.
    const savedUser = process.env.USER;
    const savedUsername = process.env.USERNAME;
    delete process.env.ARCHON_USER_ID;
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', {
          noWorktree: true,
        })
      ).rejects.toThrow(/connected github identity/i);
    } finally {
      if (savedUser !== undefined) process.env.USER = savedUser;
      if (savedUsername !== undefined) process.env.USERNAME = savedUsername;
    }

    // Never resolved a token, and never reached execution.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed when the identity/token lookup throws', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const usersDb = await import('@archon/core/db/users');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('db unavailable')
    );

    // Lookup failure is swallowed inside the gate and defaults to "not connected".
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('maybePrintTierNotice', () => {
  const { loadConfig, getUserAiPrefs } = require('@archon/core') as {
    loadConfig: ReturnType<typeof mock>;
    getUserAiPrefs: ReturnType<typeof mock>;
  };
  const { readTierNoticeState, markTierNoticeShown } = require('@archon/paths') as {
    readTierNoticeState: ReturnType<typeof mock>;
    markTierNoticeShown: ReturnType<typeof mock>;
  };

  let stderrSpy: ReturnType<typeof spyOn>;

  function makeTierWorkflow(nodeModel?: string | string[], workflowModel?: string) {
    return makeTestWorkflow({
      name: 'tier-test',
      ...(workflowModel !== undefined ? { model: workflowModel } : {}),
      nodes: [
        { id: 'n1', command: 'test-cmd', ...(nodeModel !== undefined ? { model: nodeModel } : {}) },
      ],
    });
  }

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue(null);
    (markTierNoticeShown as ReturnType<typeof mock>).mockClear();
    // assistant: 'claude' — a provider WITH built-in tier defaults, so the
    // notice has something truthful to announce (the no-built-ins case is
    // covered by its own test below).
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'claude',
    });
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints nothing and returns when quiet=true', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, true);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when no nodes use tier keywords', async () => {
    const workflow = makeTierWorkflow(undefined);
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('detects workflow-level tier keyword even when no per-node model is set', async () => {
    const workflow = makeTierWorkflow(undefined, 'large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing when the used tier is explicitly configured in install config', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: { large: { provider: 'claude', model: 'opus' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when the notice was already shown for this version', async () => {
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue({
      shownForVersion: '0.0.0-test',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('counts a preference list by its tier when none of its aliases is configured', async () => {
    const workflow = makeTierWorkflow(['@reviewer', 'medium']);
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing when a preference list runs on its configured alias', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      aliases: { '@reviewer': { provider: 'codex', model: 'gpt-5.5' } },
      assistant: 'claude',
    });
    const workflow = makeTierWorkflow(['@reviewer', 'medium']);
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints the notice and marks shown when tier is unconfigured and not yet shown', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('model tiers');
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing for a provider with no built-in tier defaults (and keeps the notice unshown)', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'pi',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false);
    // No built-ins exist, so claiming "using built-in defaults" would be false —
    // the run's tier-resolution error owns the guidance. Not marked shown, so a
    // later provider switch still gets its one-time notice.
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('returns silently when loadConfig throws', async () => {
    (loadConfig as ReturnType<typeof mock>).mockRejectedValue(new Error('parse error'));
    const workflow = makeTierWorkflow('large');
    await expect(
      maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', undefined, false)
    ).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when user prefs already configure the tier', async () => {
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({
      tiers: { large: { provider: 'claude', model: 'claude-opus-4-8' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(createTestWorkflowHost(), workflow, '/cwd', 'user-1', false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — supersedes run-id prefix resolution (#2990)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  // The suites above leave queued mockOnce values and call history behind on the shared
  // module mocks. Re-install the module-mock defaults so this describe starts from a
  // clean queue and leaves one behind for the suites after it.
  function resetSharedMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock.mockImplementation(() => Promise.resolve({ workflows: [], errors: [] }));
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({
        id: 'conv-123',
        platform_type: 'cli',
        platform_conversation_id: 'cli-123',
      })
    );
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockReset();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    mockCreateWorkflowRun.mockReset();
    mockCreateWorkflowRun.mockImplementation(
      (data: {
        workflow_name: string;
        origin?: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin;
      }) =>
        Promise.resolve({
          origin: data.origin ?? null,
          id: 'run-detached-created',
          workflow_name: data.workflow_name,
          conversation_id: data.origin?.conversationId ?? null,
          status: 'pending',
          working_path: null,
          started_at: new Date(),
          metadata: {},
        })
    );
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('adoption not expected'))
    );
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    resetSharedMocks();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetSharedMocks();
  });

  function setupSupersedesMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-sup',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
  }

  it('supersedes a run from a unique short run-id prefix', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      supersedesRunId: '0b1ee8da',
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-sup');
    // The terminality check sees the resolved full id, not the typed prefix.
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Superseding run ${supersededRunId}`)
    );
  });

  it('rejects an ambiguous supersedes run prefix with its candidates', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(workflowDb.getWorkflowRun).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
  });

  it('passes a full supersedes run id through unchanged', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      supersedesRunId: supersededRunId,
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
  });

  it('keeps the unknown-id refusal for a prefix that matches nothing', async () => {
    setupSupersedesMocks();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: 'deadbeef',
        noWorktree: true,
      })
    ).rejects.toThrow("Cannot supersede: no workflow run 'deadbeef' exists.");
  });

  it('still refuses a supersedes run that is not terminal', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'running',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
  });

  it('resolves a supersedes run prefix before passing it to the detached child', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // The detach pre-flight resolves the project the same way the adopt pre-flight
    // does: a subdir cwd misses the exact default-cwd lookup, then the path-prefix
    // lookup resolves the covering folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    // finishStartupWindow advances the 500 ms startup window on fake timers.
    jest.useFakeTimers();
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path/subdir',
        'assist',
        'hello',
        {
          detach: true,
          supersedesRunId: '0b1ee8da',
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      jest.useRealTimers();
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const supIndex = spawnCmd.indexOf('--supersedes');
    expect(supIndex).toBeGreaterThan(-1);
    expect(spawnCmd[supIndex + 1]).toBe(supersededRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: supersededRunId })
    );
  });

  it('refuses a non-terminal supersedes run in the detach pre-flight before forking', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    // Argument-aware on purpose: the queued-value mocks are argument-blind, which
    // would let terminality pass here even if it ran on the raw prefix.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === supersededRunId ? { id: supersededRunId, status: 'running' } : null
    );

    const spawnSpy = spyOn(Bun, 'spawn');
    try {
      // The refusal names the resolved full id, so terminality is checked on the
      // resolution, not on the raw prefix.
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path/subdir', 'assist', 'hello', {
          detach: true,
          supersedesRunId: '0b1ee8da',
        })
      ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
    } finally {
      spawnSpy.mockRestore();
    }

    // The refusal reached the parent: no child was forked and no pending run row
    // was left behind for a launch that cannot proceed (#2872).
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });
});
