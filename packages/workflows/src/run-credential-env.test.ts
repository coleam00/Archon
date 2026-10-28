// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { delimiter } from 'path';
import { resolveWorkflowGithubEnvironment } from './run-credential-env';
const mockLogFn = mock(() => {});
const actualPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...actualPaths,
  createLogger: () => ({ debug: mockLogFn, info: mockLogFn, warn: mockLogFn, error: mockLogFn }),
}));

describe('gh shim activation', () => {
  let previousPort: string | undefined;
  beforeEach(() => {
    previousPort = process.env.ARCHON_PORT;
  });
  afterEach(() => {
    if (previousPort === undefined) delete process.env.ARCHON_PORT;
    else process.env.ARCHON_PORT = previousPort;
  });

  function githubDeps(perUser?: { token: string | undefined }): Parameters<
    typeof resolveWorkflowGithubEnvironment
  >[0] & {
    githubApp: { installCliShim: ReturnType<typeof mock> };
  } {
    return {
      store: {
        getCodebase: mock(async () => ({
          id: 'codebase-1',
          name: 'demo',
          repository_url: 'https://github.com/acme/demo',
          default_cwd: '/tmp',
          kind: 'repo' as const,
        })),
      },
      githubApp: {
        resolveInstallationToken: mock(async () => 'ghs_dispatch'),
        installCliShim: mock(() => '/archon/bin/gh-shim'),
      },
      isPerUserGitHubEnabled: () => perUser !== undefined,
      getUserGithubToken: mock(async () => perUser?.token),
    };
  }

  it.skipIf(process.platform === 'win32')(
    'puts the shim first on PATH when ARCHON_PORT names the App server',
    async () => {
      process.env.ARCHON_PORT = '3090';
      const deps = githubDeps();
      const environment = await resolveWorkflowGithubEnvironment(deps, 'codebase-1', undefined, {
        envVars: { PATH: '/run/bin' },
      });
      expect(environment.envVars).toEqual({
        GH_TOKEN: 'ghs_dispatch',
        GITHUB_TOKEN: 'ghs_dispatch',
        PATH: `/archon/bin/gh-shim${delimiter}/run/bin`,
        ARCHON_PORT: '3090',
        ARCHON_GITHUB_APP_REPO: 'acme/demo',
      });
      expect(environment.protectedEnvKeys).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the dispatch token and warns once without ARCHON_PORT',
    async () => {
      delete process.env.ARCHON_PORT;
      const deps = githubDeps();
      mockLogFn.mockClear();
      const environment = await resolveWorkflowGithubEnvironment(deps, 'codebase-1', undefined, {});
      expect(environment.envVars).toEqual({
        GH_TOKEN: 'ghs_dispatch',
        GITHUB_TOKEN: 'ghs_dispatch',
      });
      expect(deps.githubApp.installCliShim).not.toHaveBeenCalled();
      const warnings = (mockLogFn.mock.calls as unknown[][]).filter(
        call => call[1] === 'workflow.gh_token_refresh_unavailable'
      );
      expect(warnings).toEqual([
        [
          { repo: 'acme/demo', reason: 'archon_port_unset' },
          'workflow.gh_token_refresh_unavailable',
        ],
      ]);
    }
  );

  for (const [name, token, expected] of [
    ['a per-user token', 'gho_user', 'gho_user'],
    ['the per-user scrub', undefined, ''],
  ] as const) {
    it(`leaves ${name} unrefreshed`, async () => {
      process.env.ARCHON_PORT = '3090';
      const deps = githubDeps({ token });
      const environment = await resolveWorkflowGithubEnvironment(deps, 'codebase-1', 'u-1', {});
      expect(environment.envVars?.GH_TOKEN).toBe(expected);
      expect(environment.envVars).not.toHaveProperty('PATH');
      expect(environment.envVars).not.toHaveProperty('ARCHON_GITHUB_APP_REPO');
      expect(deps.githubApp.installCliShim).not.toHaveBeenCalled();
    });
  }

  it('hides stored logins from the per-user scrub without redacting its config values', async () => {
    const environment = await resolveWorkflowGithubEnvironment(
      githubDeps({ token: undefined }),
      'codebase-1',
      'u-1',
      {}
    );
    expect(environment.envVars?.GH_CONFIG_DIR).toContain('archon-gh-scrubbed-');
    expect(environment.envVars?.GIT_CONFIG_PARAMETERS).toBe("'credential.helper='");
    // Only secrets are protected: protecting the scrub's config values would redact
    // them, and every `credential.helper` mention, from node output.
    expect(environment.protectedEnvKeys).toEqual([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'COPILOT_GITHUB_TOKEN',
    ]);
  });
});
