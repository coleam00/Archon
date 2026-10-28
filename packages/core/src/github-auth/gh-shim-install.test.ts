// @archon-test-isolated
/**
 * Runs `gh` the way a workflow bash node does: the environment comes from the
 * engine's GitHub seam, the shim is the installed script, the token comes from
 * a real loopback server, and a fake `gh` reports the token it received.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBashPath } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolveWorkflowGithubEnvironment } from '@archon/workflows/run-credential-env';
import { runSubprocess } from '@archon/workflows/subprocess';
import { installGitHubCliShim } from './gh-shim-install';

const trackTempRoot = trackTempRoots();

describe.skipIf(process.platform === 'win32')('gh shim in a workflow run', () => {
  let root: string;
  let fakeBin: string;
  let previous: Record<'ARCHON_HOME' | 'ARCHON_PORT', string | undefined>;
  let requests: unknown[];
  let respond: () => Response;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(async () => {
    previous = { ARCHON_HOME: process.env.ARCHON_HOME, ARCHON_PORT: process.env.ARCHON_PORT };
    root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-gh-shim-')));
    process.env.ARCHON_HOME = join(root, 'home');
    fakeBin = join(root, 'real-bin');
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, 'gh'),
      '#!/bin/sh\nprintf \'%s|%s|%s\' "$GH_TOKEN" "$GITHUB_TOKEN" "$*"\n',
      {
        mode: 0o755,
      }
    );
    requests = [];
    respond = (): Response => Response.json({ token: 'ghs_fresh' });
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, body: await request.json() });
        return respond();
      },
    });
    process.env.ARCHON_PORT = String(server.port);
  });

  afterEach(() => {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function runGh(
    command: string,
    path = `${fakeBin}:${process.env.PATH ?? ''}`
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const environment = await resolveWorkflowGithubEnvironment(
      {
        store: {
          getCodebase: async () => ({
            id: 'codebase-1',
            name: 'acme/demo',
            repository_url: 'https://github.com/acme/demo',
            default_cwd: root,
            kind: 'repo' as const,
          }),
        },
        githubApp: {
          resolveInstallationToken: async () => 'ghs_expired_dispatch',
          installCliShim: installGitHubCliShim,
        },
      },
      'codebase-1',
      undefined,
      { envVars: { PATH: path } }
    );
    try {
      const { stdout, stderr } = await runSubprocess(
        { kind: 'host' },
        resolveBashPath(),
        ['-c', command],
        {
          cwd: root,
          timeout: 30_000,
          env: environment.envVars ?? {},
          protectedEnvKeys: environment.protectedEnvKeys,
          retention: { standalone: true },
        }
      );
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const failure = err as { code: number; stdout: string; stderr: string };
      return { exitCode: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
  }

  test('a gh call after the dispatch token expired runs with a fresh installation token', async () => {
    const { exitCode, stdout } = await runGh('gh pr checks 7');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('ghs_fresh|ghs_fresh|pr checks 7');
    expect(requests).toEqual([
      { path: '/internal/git-credential', body: { host: 'github.com', path: 'acme/demo' } },
    ]);
  });

  test.each([true, false])(
    'App credential request without a real gh (refresh succeeds: %s)',
    async succeeds => {
      await unlink(join(fakeBin, 'gh'));
      for (const tool of ['bash', 'dirname', 'sed', 'curl', 'wc']) {
        const executable = Bun.which(tool);
        if (!executable) throw new Error(`Missing test tool: ${tool}`);
        await symlink(executable, join(fakeBin, tool));
      }
      if (!succeeds) respond = () => Response.json({});
      const { exitCode, stdout, stderr } = await runGh(
        'gh auth token --hostname github.com',
        fakeBin
      );
      expect(exitCode, stderr).toBe(succeeds ? 0 : 1);
      expect(stdout).toBe(succeeds ? 'ghs_fresh\n' : '');
      if (!succeeds) expect(stderr).toContain('cannot refresh the GitHub App token');
      expect(requests).toEqual([
        { path: '/internal/git-credential', body: { host: 'github.com', path: 'acme/demo' } },
      ]);
    }
  );

  test('a token a step sets itself passes through unchanged', async () => {
    const { stdout } = await runGh('GH_TOKEN=gho_step gh api user');
    expect(stdout).toBe('gho_step|ghs_expired_dispatch|api user');
    expect(requests).toEqual([]);
  });

  test('fails loudly without running gh when the server returns no token', async () => {
    respond = (): Response => new Response('not found', { status: 404 });
    const { exitCode, stdout, stderr } = await runGh('gh pr checks 7');
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('git-credential-archon: curl to');
    expect(stderr).toContain('gh (archon shim): cannot refresh the GitHub App token');
    expect(stderr).not.toContain('ghs_');
  });
});
