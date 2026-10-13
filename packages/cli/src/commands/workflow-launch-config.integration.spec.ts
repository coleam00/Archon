import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function runCli(args: string[], cwd: string, archonHome: string): string {
  // --verbose keeps the executor's info logs, including `workflow_provider_resolved`.
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args, '--verbose'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHON_HOME: archonHome,
      ARCHON_TELEMETRY_DISABLED: '1',
      // Use the scratch SQLite database under ARCHON_HOME, never a configured server.
      DATABASE_URL: '',
    },
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Providers the executor resolved, in log order, from the CLI's JSON log lines. */
function resolvedProviders(output: string): string[] {
  return output
    .split('\n')
    .filter(line => line.includes('"workflow_provider_resolved"'))
    .map(line => (JSON.parse(line) as { provider: string }).provider);
}

interface RunRow {
  id: string;
  status: string;
  working_path: string;
  assistant: string | null;
}

function latestRun(archonHome: string): RunRow {
  // No concurrent writer: every CLI call here is a finished synchronous child. rowid, not
  // started_at: SQLite timestamps have one-second resolution and two runs can share one.
  const database = new Database(join(archonHome, 'archon.db'), { readonly: true });
  try {
    const row = database
      .query<
        RunRow,
        []
      >("SELECT id, status, working_path, json_extract(metadata, '$.ai_configuration.assistant') AS assistant FROM remote_agent_workflow_runs ORDER BY rowid DESC LIMIT 1")
      .get();
    if (row === null) throw new Error('no run row was recorded');
    return row;
  } finally {
    database.close();
  }
}

/**
 * A repository with a pushed `main` whose committed config selects claude. `settle`
 * succeeds and `gate` fails until a `go` file exists in the worktree, which leaves a resumable run.
 */
function createRepo(root: string, trackConfig: boolean): string {
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare');
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(
    join(repo, '.archon', 'workflows', 'launch-config.yaml'),
    [
      'name: launch-config',
      'description: launch config probe',
      'nodes:',
      '  - id: settle',
      '    bash: echo settled',
      '  - id: gate',
      '    depends_on: [settle]',
      '    bash: test -f go',
      '',
    ].join('\n')
  );
  const config = join(repo, '.archon', 'config.yaml');
  if (trackConfig) {
    writeFileSync(config, 'assistant: claude\nworktree:\n  baseBranch: main\n');
  } else {
    writeFileSync(join(repo, '.gitignore'), '.archon/config.yaml\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  return repo;
}

/**
 * The operator edits `.archon/config.yaml` in the checkout they launch from and expects
 * a new isolated run to use it, even though the run's worktree only holds committed
 * content. The run records that config at launch, so later edits never change it.
 */
describe('workflow run launch config', () => {
  test.each([
    { name: 'an uncommitted', trackConfig: true },
    { name: 'a gitignored', trackConfig: false },
  ])(
    '$name launch-checkout config reaches an isolated run and survives a resume',
    async ({ trackConfig }) => {
      const root = mkdtempSync(join(tmpdir(), 'archon-launch-config-'));
      cleanupPaths.push(root);
      const archonHome = join(root, 'home');
      mkdirSync(archonHome, { recursive: true });
      const repo = createRepo(root, trackConfig);
      const config = join(repo, '.archon', 'config.yaml');
      writeFileSync(config, 'assistant: codex\nworktree:\n  baseBranch: main\n');

      const first = runCli(['workflow', 'run', 'launch-config', 'go'], repo, archonHome);
      expect(first).toContain("Bash node 'gate' failed");
      expect(resolvedProviders(first)).toEqual(['codex']);

      const run = latestRun(archonHome);
      expect(run.status).toBe('failed');
      expect(run.assistant).toBe('codex');
      // The code still runs isolated: the worktree holds only what was pushed.
      expect(run.working_path).not.toBe(repo);
      const worktreeConfig = join(run.working_path, '.archon', 'config.yaml');
      if (trackConfig) expect(readFileSync(worktreeConfig, 'utf8')).toContain('claude');

      // Change the config in both places a continuation could read from.
      writeFileSync(config, 'assistant: pi\nworktree:\n  baseBranch: main\n');
      writeFileSync(worktreeConfig, 'assistant: pi\n');
      writeFileSync(join(run.working_path, 'go'), '');

      const resumed = runCli(['workflow', 'resume', run.id], repo, archonHome);
      expect(resolvedProviders(resumed)).toEqual(['codex']);
      expect(latestRun(archonHome).assistant).toBe('codex');
    },
    120_000
  );

  test('a fresh run reusing a --branch worktree still reads the launch checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-launch-config-'));
    cleanupPaths.push(root);
    const archonHome = join(root, 'home');
    mkdirSync(archonHome, { recursive: true });
    const repo = createRepo(root, true);
    const config = join(repo, '.archon', 'config.yaml');

    runCli(['workflow', 'run', 'launch-config', '--branch', 'reuse-me', 'go'], repo, archonHome);
    const firstRun = latestRun(archonHome);
    expect(firstRun.assistant).toBe('claude');

    // The reused worktree keeps its committed claude config; the operator's checkout
    // now says codex, and the new run must follow the checkout.
    writeFileSync(config, 'assistant: codex\nworktree:\n  baseBranch: main\n');
    const second = runCli(
      ['workflow', 'run', 'launch-config', '--branch', 'reuse-me', 'go'],
      repo,
      archonHome
    );
    const secondRun = latestRun(archonHome);
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(secondRun.working_path).toBe(firstRun.working_path);
    expect(secondRun.assistant).toBe('codex');
    expect(resolvedProviders(second)).toEqual(['codex']);
  }, 120_000);
});
