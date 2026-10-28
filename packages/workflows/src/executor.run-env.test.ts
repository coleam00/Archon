// @archon-test-isolated
import {
  configWith,
  containerBackend,
  cwdPath,
  dagCall,
  makeDeps,
  makeRun,
  makeStore,
  makeWorkflow,
  mockExecuteDagWorkflow,
  recordedEvents,
  resetExecutorMocks,
  resumeOf,
  startWorkflow,
} from './executor/test-utils';
import { removeTempTree } from '@archon/paths/test-utils';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';
import type { StoredProviderCredential, WorkflowDeps } from './deps';
import { StoredCredentialDeliveryError } from './run-preflight';

/** The environment a run's nodes see: DB env vars, per-user credentials and credential preflight. */

beforeEach(resetExecutorMocks);

const asUser = { conversationId: 'db-c1', userId: 'u-1' };
const providerEnv = (env: Record<string, string>, protectedValues = Object.values(env)) =>
  mock(async () => ({ env, files: [], protectedValues }));
const withProviderEnv = (
  getUserProviderEnv: WorkflowDeps['getUserProviderEnv'],
  deps = makeDeps()
): WorkflowDeps => ({ ...deps, isPerUserProviderKeysEnabled: () => true, getUserProviderEnv });

describe('DB env var merge', () => {
  it('merges DB env vars on top of file config envVars when codebaseId provided', async () => {
    const store = makeStore({ getCodebaseEnvVars: mock(async () => ({ DB_KEY: 'db_val' })) });
    await startWorkflow({
      deps: { ...makeDeps(store), loadConfig: configWith({ envVars: { FILE_KEY: 'file_val' } }) },
      options: { codebaseId: 'codebase-1' },
    });
    expect(store.getCodebaseEnvVars).toHaveBeenCalledWith('codebase-1');
    expect(dagCall()?.config.envVars).toEqual({ FILE_KEY: 'file_val', DB_KEY: 'db_val' });
  });

  it('does not call getCodebaseEnvVars when no codebaseId', async () => {
    const store = makeStore();
    await startWorkflow({ store });
    expect(store.getCodebaseEnvVars).not.toHaveBeenCalled();
  });
});

describe('user provider env injection', () => {
  it('does not read credential delivery for a deterministic-only graph', async () => {
    const getUserProviderEnv = mock(async (): Promise<never> => {
      throw new Error('unused vault unavailable');
    });
    const result = await startWorkflow({
      deps: withProviderEnv(getUserProviderEnv),
      workflow: makeWorkflow({
        nodes: [{ id: 'exec', kind: 'exec', runtime: 'sh', script: 'true' }],
      }),
      origin: asUser,
    });
    expect(result.success).toBe(true);
    expect(getUserProviderEnv).not.toHaveBeenCalled();
  });

  it.each([
    ['the feature is disabled', false, asUser],
    ['no user is known', true, { conversationId: 'db-c1' }],
  ])('skips injection when %s', async (_label, enabled, origin) => {
    const getUserProviderEnv = providerEnv({ SHOULD_NOT_APPEAR: '1' });
    await startWorkflow({
      deps: { ...withProviderEnv(getUserProviderEnv), isPerUserProviderKeysEnabled: () => enabled },
      origin,
    });
    expect(getUserProviderEnv).not.toHaveBeenCalled();
  });

  it('merges user provider env LAST so it overrides DB env', async () => {
    const store = makeStore({
      getCodebaseEnvVars: mock(async () => ({
        DATABASE_URL: 'db_val',
        BASE_BRANCH: 'reserved-db-secret',
        SHARED_KEY: 'db',
      })),
    });
    await startWorkflow({
      deps: withProviderEnv(
        providerEnv({ SHARED_KEY: 'user_wins', USER_KEY: 'u_val' }),
        makeDeps(store)
      ),
      origin: asUser,
      options: { codebaseId: 'codebase-1' },
    });
    const config = dagCall()?.config;
    expect(config?.envVars).toMatchObject({
      DATABASE_URL: 'db_val',
      BASE_BRANCH: 'reserved-db-secret',
      SHARED_KEY: 'user_wins',
      USER_KEY: 'u_val',
    });
    expect(config?.protectedEnvKeys).toEqual(['SHARED_KEY', 'USER_KEY']);
    expect(config?.userCredentialEnvKeys).toEqual(['SHARED_KEY', 'USER_KEY']);
    expect(config?.protectedCredentialValues).toEqual([
      'db_val',
      'reserved-db-secret',
      'user_wins',
      'u_val',
    ]);
  });

  it('uses the persisted user identity to rebuild credential provenance on resume', async () => {
    const getUserProviderEnv = providerEnv({ CODEX_HOME: '/run/codex-home' }, [
      'persisted-user-token',
    ]);
    await startWorkflow({
      deps: withProviderEnv(getUserProviderEnv),
      origin: { conversationId: 'db-c1', userId: 'transient-resumer' },
      options: { preCreatedRun: makeRun({ user_id: 'persisted-user' }) },
    });
    expect(getUserProviderEnv).toHaveBeenCalledWith(
      'persisted-user',
      expect.any(String),
      ['anthropic'],
      ['anthropic']
    );
    expect(dagCall()?.config.protectedCredentialValues).toEqual(['persisted-user-token']);
  });

  it('removes stale credential files before a credential refresh failure', async () => {
    const artifactsDir = cwdPath('/tmp', 'artifacts', 'runs', 'run-123');
    const authPaths = ['codex-home', 'pi-home'].map(home => join(artifactsDir, home, 'auth.json'));
    for (const path of authPaths) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'stale-secret');
    }
    const deps = withProviderEnv(
      mock(async () => {
        throw new Error('network down');
      })
    );
    try {
      const result = await startWorkflow({ deps, origin: asUser });
      expect(result.success).toBe(false);
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      for (const path of authPaths) await expect(readFile(path, 'utf8')).rejects.toThrow();
    } finally {
      for (const path of authPaths) await removeTempTree(dirname(path));
    }
  });

  it('blocks DAG entry and cleans partial delivery when a later file write fails', async () => {
    const credentialValue = 'oauth-partial-write-secret';
    const deliveryRoot = await mkdtemp(join(tmpdir(), 'archon-provider-delivery-'));
    const firstFile = join(deliveryRoot, 'codex-auth.json');
    const deps = withProviderEnv(
      mock(async () => ({
        env: { CODEX_HOME: deliveryRoot },
        files: [
          { path: firstFile, contents: credentialValue },
          // A path under a file cannot be written.
          { path: join(firstFile, 'pi-auth.json'), contents: credentialValue },
        ],
        protectedValues: [credentialValue],
      }))
    );
    try {
      const result = await startWorkflow({ deps, origin: asUser });
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      if (result.success) throw new Error('Expected delivery failure');
      expect(result.error).toBe('Could not safely write provider credential files');
      expect(result.error).not.toContain(credentialValue);
      await expect(readFile(firstFile, 'utf8')).rejects.toThrow();
    } finally {
      await removeTempTree(deliveryRoot);
    }
  });
});

describe('GitHub credentials', () => {
  const demoCodebase = (repositoryUrl: string) =>
    mock(async () => ({
      id: 'codebase-1',
      name: 'demo',
      repository_url: repositoryUrl,
      default_cwd: '/tmp',
      kind: 'repo' as const,
    }));

  for (const [enabled, userId] of [
    [false, 'u-1'],
    [true, undefined],
  ] as const) {
    it(`does not resolve a commit author with per-user=${enabled} and user=${userId}`, async () => {
      const author = mock(async () => ({ name: 'other-user', email: 'other@example.test' }));
      await startWorkflow({
        deps: { ...makeDeps(), isPerUserGitHubEnabled: () => enabled, getUserGithubAuthor: author },
        origin: { conversationId: 'db-c1', userId },
      });
      expect(author).not.toHaveBeenCalled();
      expect(dagCall()?.config.envVars).not.toHaveProperty('GIT_AUTHOR_NAME');
      expect(dagCall()?.config.envVars).not.toHaveProperty('GIT_AUTHOR_EMAIL');
    });
  }

  it('protects bot and per-user GitHub credentials beside provider credentials', async () => {
    const store = makeStore({
      getCodebaseEnvVars: mock(async () => ({
        GIT_AUTHOR_NAME: 'wrong-user',
        GIT_AUTHOR_EMAIL: 'wrong@example.test',
      })),
      getCodebase: demoCodebase('https://github.com/acme/demo'),
    });
    const getUserGithubAuthor = mock(async () => ({
      name: 'connected-author',
      email: '42+connected-author@users.noreply.github.com',
    }));
    await startWorkflow({
      deps: {
        ...withProviderEnv(providerEnv({ ANTHROPIC_API_KEY: 'provider-token' }), makeDeps(store)),
        githubApp: {
          resolveInstallationToken: mock(async () => 'bot-token'),
          installCliShim: () => '/archon/bin/gh-shim',
        },
        isPerUserGitHubEnabled: () => true,
        getUserGithubToken: mock(async () => 'user-token'),
        getUserGithubAuthor,
      },
      origin: asUser,
      options: { codebaseId: 'codebase-1' },
    });

    const config = dagCall()?.config;
    expect(config?.envVars).toMatchObject({
      GH_TOKEN: 'user-token',
      GITHUB_TOKEN: 'user-token',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      COPILOT_GITHUB_TOKEN: '',
      GIT_AUTHOR_NAME: 'connected-author',
      GIT_AUTHOR_EMAIL: '42+connected-author@users.noreply.github.com',
      ANTHROPIC_API_KEY: 'provider-token',
    });
    expect(config?.protectedEnvKeys).toEqual([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'ANTHROPIC_API_KEY',
    ]);
    expect(config?.userCredentialEnvKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(config?.protectedCredentialValues).toEqual(['provider-token']);
    expect(getUserGithubAuthor).toHaveBeenCalledTimes(1);
    expect(getUserGithubAuthor).toHaveBeenCalledWith('u-1');
  });

  for (const [repositoryUrl, expected] of [
    ['ssh://git@github.com/acme/demo.git', 'token'],
    ['https://x-access-token@github.com/acme/demo.git', 'token'],
    ['github.com:acme/demo', 'token'],
    ['https://github.com/acme/demo/tree/main', 'fail'],
    ['git@github.com:acme', 'fail'],
    ['https://gitlab.com/acme/demo', 'inherit'],
  ] as const) {
    it(`resolves the App token for ${repositoryUrl} as ${expected}`, async () => {
      const resolveInstallationToken = mock(async () => 'bot-token');
      const result = await startWorkflow({
        deps: {
          ...makeDeps(makeStore({ getCodebase: demoCodebase(repositoryUrl) })),
          githubApp: { resolveInstallationToken, installCliShim: () => '/archon/bin/gh-shim' },
        },
        origin: { conversationId: 'db-c1' },
        options: { codebaseId: 'codebase-1' },
      });

      if (expected === 'fail') {
        // A github.com remote without a resolvable owner/repo must not run on whatever
        // GitHub credential the host process happens to hold.
        expect(result.success).toBe(false);
        expect(resolveInstallationToken).not.toHaveBeenCalled();
        expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
        return;
      }
      const envVars = dagCall()?.config.envVars;
      if (expected === 'token') {
        expect(resolveInstallationToken).toHaveBeenCalledWith('acme', 'demo');
        expect(envVars).toMatchObject({ GH_TOKEN: 'bot-token', GITHUB_TOKEN: 'bot-token' });
      } else {
        expect(resolveInstallationToken).not.toHaveBeenCalled();
        expect(envVars).not.toHaveProperty('GH_TOKEN');
      }
    });
  }
});

describe('credential preflight lifecycle', () => {
  const nativeAuth = (state: string) => {
    const checkCredential = mock(async () => ({ state, source: 'native' }));
    const getAgentProvider = mock(() => ({
      run: mock(async () => {}),
      checkCredential,
    })) as unknown as WorkflowDeps['getAgentProvider'];
    return { checkCredential, getAgentProvider };
  };

  it.each(['paused', 'failed'] as const)(
    'blocks a %s continuation using its originating identity before DAG entry',
    async status => {
      const store = makeStore();
      const getUserProviderCredential = mock(
        async (): Promise<StoredProviderCredential> => ({
          kind: 'api_key',
          getStatus: async () => ({
            state: 'unusable',
            source: 'archon',
            evidence: 'stored credential unreadable',
          }),
        })
      );
      const result = await startWorkflow({
        deps: {
          ...makeDeps(store),
          isPerUserProviderKeysEnabled: () => true,
          getUserProviderCredential,
        },
        origin: { conversationId: 'db', userId: 'resumer' },
        options: resumeOf(makeRun({ status, user_id: 'origin' }), [
          ['completed', { output: 'done' }],
        ]),
      });
      if (result.success) throw new Error('Expected credential refusal');
      expect(result.error).toBe(
        "Credential preflight failed for provider 'claude' (vendor 'anthropic'): credential cannot be used: stored credential unreadable"
      );
      expect(getUserProviderCredential).toHaveBeenCalledWith('origin', 'anthropic');
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledWith(
        'run-123',
        result.error,
        expect.anything()
      );
    }
  );

  it('a Pi-only run with its own login neither refreshes nor delivers a stored Claude subscription', async () => {
    const storedStatus = mock(async (): Promise<never> => {
      throw new Error('unused credential must not be refreshed');
    });
    const getUserProviderEnv = mock(async (): Promise<never> => {
      throw new Error('delivery must not be asked for an unconsumed credential');
    });
    const result = await startWorkflow({
      deps: {
        ...withProviderEnv(getUserProviderEnv),
        getUserProviderCredential: mock(
          async () => ({ kind: 'oauth', getStatus: storedStatus }) as const
        ),
        getAgentProvider: nativeAuth('usable').getAgentProvider,
      },
      workflow: makeWorkflow({ provider: 'pi', model: 'anthropic/claude-sonnet-4-5' }),
      origin: { conversationId: 'db', userId: 'origin' },
    });
    expect(result.success).toBe(true);
    expect(storedStatus).not.toHaveBeenCalled();
    expect(getUserProviderEnv).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
  });

  it('checks native authentication in the run checkout and container before DAG entry', async () => {
    const store = makeStore();
    const { checkCredential, getAgentProvider } = nativeAuth('not_connected');
    const execContext = { kind: 'container', containerId: 'cid' } as const;
    const result = await startWorkflow({
      deps: { ...makeDeps(store), getAgentProvider },
      cwd: '/tmp/run-checkout',
      options: {
        execContext,
        container: { envId: 'env-x', writeBack: 'approve', backend: containerBackend() },
      },
    });
    if (result.success) throw new Error('Expected credential refusal');
    expect(result.error).toStartWith("Credential preflight failed for provider 'claude'");
    expect(checkCredential).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/run-checkout', execContext })
    );
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledWith('run-123', result.error, expect.anything());
  });

  it('an inconclusive native check starts the run and records a warning event with its evidence', async () => {
    const store = makeStore();
    const getAgentProvider = mock(() => ({
      run: mock(async () => {}),
      checkCredential: mock(async () => ({
        state: 'check_failed',
        source: 'native',
        evidence: 'workspace routing discovery failed',
      })),
    })) as unknown as WorkflowDeps['getAgentProvider'];
    const result = await startWorkflow({ deps: { ...makeDeps(store), getAgentProvider } });
    expect(result.success).toBe(true);
    expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    expect(recordedEvents(store, 'credential_check_inconclusive')).toEqual([
      {
        workflow_run_id: 'run-123',
        event_type: 'credential_check_inconclusive',
        data: {
          provider: 'claude',
          vendor: 'anthropic',
          source: 'native',
          evidence: 'workspace routing discovery failed',
        },
      },
    ]);
  });

  it('a delivery refusal after a successful check blocks rather than using ambient credentials', async () => {
    const getUserProviderEnv = mock<NonNullable<WorkflowDeps['getUserProviderEnv']>>(async () => {
      throw new StoredCredentialDeliveryError('anthropic', {
        state: 'check_failed',
        source: 'archon',
        evidence: 'refresh unavailable',
      });
    });
    const result = await startWorkflow({
      deps: withProviderEnv(getUserProviderEnv),
      origin: { conversationId: 'db', userId: 'origin' },
    });
    if (result.success) throw new Error('Expected credential refusal');
    expect(result.error).toBe(
      "Credential preflight failed for provider 'claude' (vendor 'anthropic'): could not verify: refresh unavailable"
    );
    expect(getUserProviderEnv.mock.calls[0]?.slice(2)).toEqual([['anthropic'], ['anthropic']]);
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('a stored check that stays inconclusive at delivery refuses without a run-started warning', async () => {
    const store = makeStore();
    const inconclusive = {
      state: 'check_failed',
      source: 'archon',
      evidence: 'refresh unavailable',
    } as const;
    const getUserProviderEnv = mock<NonNullable<WorkflowDeps['getUserProviderEnv']>>(async () => {
      throw new StoredCredentialDeliveryError('anthropic', inconclusive);
    });
    const result = await startWorkflow({
      deps: {
        ...withProviderEnv(getUserProviderEnv, makeDeps(store)),
        getUserProviderCredential: mock(
          async (): Promise<StoredProviderCredential> => ({
            kind: 'oauth',
            getStatus: async () => inconclusive,
          })
        ),
      },
      origin: { conversationId: 'db', userId: 'origin' },
    });
    if (result.success) throw new Error('Expected credential refusal');
    expect(result.error).toEndWith('could not verify: refresh unavailable');
    expect(recordedEvents(store, 'credential_check_inconclusive')).toEqual([]);
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });
});
