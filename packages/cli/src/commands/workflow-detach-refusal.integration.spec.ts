// @archon-test-isolated
/**
 * A detached launch the child would refuse is refused in the result the caller reads,
 * before the fork: real git, real SQLite, the CLI in its own process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await run(['git', ...args], cwd);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The JSON document a `--json` run ends its stdout with; a foreground run prints text first. */
function resultDocument(stdout: string): { ok: boolean; error?: string } {
  return JSON.parse(stdout.slice(stdout.lastIndexOf('\n{\n') + 1)) as {
    ok: boolean;
    error?: string;
  };
}

describe('workflow run --detach', () => {
  test('refuses a --from the branch worktree lacks in its JSON result, as the foreground does', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-detach-refusal-')));
    tempRoots.push(root);
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    const archonHome = join(root, 'home');
    await git(['init', '-q', '--bare', origin], root);
    await git(['init', '-q', '-b', 'main', repo], root);
    mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: main\n');
    writeFileSync(
      join(repo, '.archon', 'workflows', 'probe.yaml'),
      'name: probe\ndescription: probe\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
    await git(['add', '.'], repo);
    await git([...identity, 'commit', '-q', '-m', 'init'], repo);
    await git(['remote', 'add', 'origin', origin], repo);
    await git(['push', '-q', 'origin', 'main'], repo);
    await git(['checkout', '-q', '-b', 'other'], repo);
    await git([...identity, 'commit', '-q', '--allow-empty', '-m', 'not on main'], repo);
    const otherCommit = await git(['rev-parse', 'HEAD'], repo);
    await git(['checkout', '-q', 'main'], repo);

    const cli = (args: string[]) =>
      run([process.execPath, CLI_PATH, ...args], repo, {
        WORKFLOW_ID: '',
        ARCHON_NODE_EXECUTION: '',
        ARCHON_TRIGGER_HOST: '',
        DATABASE_URL: '',
        ARCHON_HOME: archonHome,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        GITHUB_APP_ID: '',
      });
    const runCount = (): number => {
      const database = new Database(join(archonHome, 'archon.db'), { readonly: true });
      try {
        return (
          database
            .query<{ count: number }, []>(
              'SELECT COUNT(*) AS count FROM remote_agent_workflow_runs'
            )
            .get()?.count ?? 0
        );
      } finally {
        database.close();
      }
    };

    const first = await cli(['workflow', 'run', 'probe', '--branch', 'feat/x', '--json']);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(runCount()).toBe(1);

    const launch = ['workflow', 'run', 'probe', '--branch', 'feat/x', '--from', otherCommit];
    const detached = await cli([...launch, '--detach', '--json']);
    expect(detached.exitCode).not.toBe(0);
    const refused = resultDocument(detached.stdout);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('is not in its history');
    expect(runCount()).toBe(1);

    const foreground = await cli([...launch, '--json']);
    expect(foreground.exitCode).not.toBe(0);
    expect(resultDocument(foreground.stdout)).toEqual(refused);
  }, 90_000);
});
