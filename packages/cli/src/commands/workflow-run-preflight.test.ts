import { createTestWorkflowHost } from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  makeTestComposedWorkflow,
  makeTestWorkflow,
  makeTestWorkflowWithSource,
} from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow';
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

  function makeTierWorkflow(nodeModel?: string, workflowModel?: string) {
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
