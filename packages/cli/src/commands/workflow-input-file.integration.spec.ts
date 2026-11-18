// @archon-test-isolated
/**
 * `workflow run --input-file name=path` supplies a declared input from a file's exact
 * contents, read once by the launching command: real git, real SQLite, the CLI in its
 * own process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

// Pauses at its only node, so the run's row holds its inputs without spawning a node:
// a shell node would receive a 500 KiB input as one environment string.
const TAKE = `name: take
description: take
inputs:
  big: { required: true }
nodes:
  - id: hold
    wait: { attention: hold, form: approval }
`;

// Over Linux's 128 KiB per-argument limit, with multi-byte text and a trailing newline
// that `$(cat file)` would strip.
const CONTENT = 'äöü line of a large work item\n'.repeat(16_000);

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

async function git(args: string[], cwd: string): Promise<void> {
  const result = await run(['git', ...args], cwd);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-input-file-')));
  tempRoots.push(root);
  const repo = join(root, 'repo');
  const archonHome = join(root, 'home');
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.archon', 'workflows', 'take.yaml'), TAKE);
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['add', '.'], repo);
  await git(
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'],
    repo
  );
  const bigPath = join(root, 'big.txt');
  writeFileSync(bigPath, CONTENT);

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
  const runs = (): { status: string; metadata: string }[] => {
    const path = join(archonHome, 'archon.db');
    if (!existsSync(path)) return [];
    const database = new Database(path, { readonly: true });
    try {
      return database
        .query<{ status: string; metadata: string }, []>(
          'SELECT status, metadata FROM remote_agent_workflow_runs'
        )
        .all();
    } finally {
      database.close();
    }
  };
  return { root, repo, bigPath, cli, runs };
}

const recordedBig = (metadata: string): unknown =>
  (JSON.parse(metadata) as { inputs?: { big?: unknown } }).inputs?.big;

describe('workflow run --input-file', () => {
  test('a run records a 500 KiB file whole as its input', async () => {
    const fx = await fixture();
    // Relative to --cwd, which defaults to the shell's directory: the repo.
    const result = await fx.cli([
      'workflow',
      'run',
      'take',
      '--no-worktree',
      '--input-file',
      'big=../big.txt',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);

    const [row] = fx.runs();
    expect(row?.status).toBe('paused');
    expect(recordedBig(row?.metadata ?? '{}')).toBe(CONTENT);
  }, 90_000);

  test('a detached run does not need the file once the command returns', async () => {
    const fx = await fixture();
    const result = await fx.cli([
      'workflow',
      'run',
      'take',
      '--no-worktree',
      '--detach',
      '--input-file',
      `big=${fx.bigPath}`,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    rmSync(fx.bigPath);

    const deadline = Date.now() + 60_000;
    let row = fx.runs()[0];
    while (row?.status !== 'paused' && row?.status !== 'failed' && Date.now() < deadline) {
      await Bun.sleep(200);
      row = fx.runs()[0];
    }
    expect(row?.status).toBe('paused');
    expect(recordedBig(row?.metadata ?? '{}')).toBe(CONTENT);
  }, 90_000);

  // The run's cwd is normalized to the repository root; the path must not follow it.
  test('a relative path resolves from a subdirectory --cwd, on a dry run and a real run', async () => {
    const fx = await fixture();
    const briefs = join(fx.repo, 'briefs');
    mkdirSync(briefs);
    writeFileSync(join(briefs, 'item.txt'), 'the brief\n');
    const launch = ['workflow', 'run', 'take', '--cwd', briefs, '--input-file', 'big=item.txt'];

    // Only briefs/item.txt exists: reading <root>/item.txt would refuse the run.
    const dry = await fx.cli([...launch, '--dry-run']);
    expect(dry.exitCode, dry.stderr).toBe(0);

    // A same-named root file must not win.
    writeFileSync(join(fx.repo, 'item.txt'), 'the root file\n');
    const real = await fx.cli([...launch, '--no-worktree']);
    expect(real.exitCode, real.stderr).toBe(0);
    expect(recordedBig(fx.runs()[0]?.metadata ?? '{}')).toBe('the brief\n');
  }, 90_000);

  test('refuses a missing file or a name given twice before any run exists', async () => {
    const fx = await fixture();
    const missing = await fx.cli([
      'workflow',
      'run',
      'take',
      '--no-worktree',
      '--input-file',
      'big=nope.txt',
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain(
      `Cannot read --input-file for input 'big' at '${join(fx.root, 'repo', 'nope.txt')}'`
    );

    const twice = await fx.cli([
      'workflow',
      'run',
      'take',
      '--no-worktree',
      '--input',
      'big=typed',
      '--input-file',
      `big=${fx.bigPath}`,
    ]);
    expect(twice.exitCode).not.toBe(0);
    expect(twice.stderr).toContain("Input 'big' is given by both --input and --input-file");
    expect(fx.runs()).toEqual([]);
  }, 90_000);
});
