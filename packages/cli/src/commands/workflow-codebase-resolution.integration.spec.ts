import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, 'fixtures', 'workflow-cli-without-title.ts');
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(repo: string, remote: string, file: string): void {
  mkdirSync(join(repo, 'subdir'), { recursive: true });
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  writeFileSync(join(repo, file), 'committed\n');
  writeFileSync(join(repo, '.gitignore'), 'projects/\n');
  writeFileSync(
    join(repo, '.archon', 'workflows', 'probe.yaml'),
    `name: probe\ndescription: Probe checkout\nnodes:\n  - id: probe\n    bash: cat ${file}\n`
  );
  git(repo, ['init', '-qb', 'main']);
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(repo, ['init', '--bare', '-q', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-qu', 'origin', 'main']);
}

interface CodebaseRow {
  id: string;
  default_cwd: string;
}

interface RunRow {
  codebase_id: string;
  working_path: string;
  status: string;
}

test('nested repo registers independently and its worktree retains the child owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-codebase-resolution-'));
  roots.push(root);
  const home = join(root, 'home');
  const parent = join(root, 'parent');
  const child = join(parent, 'projects', 'apps', 'child');
  initRepo(parent, join(root, 'parent.git'), 'parent-only.txt');
  initRepo(child, join(root, 'child.git'), 'child-only.txt');

  function run(cwd: string, args: string[]): string {
    const conversation = crypto.randomUUID();
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'probe', '--conversation-id', conversation, ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          ARCHON_HOME: home,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
      }
    );
    if (result.error) throw result.error;
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return conversation;
  }

  run(parent, ['--no-worktree']);
  const db = new Database(join(home, 'archon.db'), { readonly: true });
  try {
    const codebases = db.query<CodebaseRow, []>(
      'SELECT id, default_cwd FROM remote_agent_codebases'
    );
    const parentRow = codebases.get();
    if (!parentRow) throw new Error('Parent repository was not registered');
    expect(parentRow.default_cwd).toBe(await canonicalizeProjectPath(parent));
    const conversation = run(join(child, 'subdir'), ['--branch', 'child-probe', '--from', 'main']);
    const childPath = await canonicalizeProjectPath(child);
    const childRow = codebases.all().find(row => row.default_cwd === childPath);
    expect(childRow).toBeDefined();
    if (!childRow) throw new Error('Child repository was not registered');
    const runs = db.query<RunRow, [string]>(
      `SELECT r.codebase_id, r.working_path, r.status FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON c.id = r.conversation_id WHERE c.platform_conversation_id = ?`
    );
    const isolated = runs.get(conversation);
    expect(isolated?.codebase_id).toBe(childRow.id);
    expect(isolated?.status).toBe('completed');
    if (!isolated) throw new Error('Missing child run');
    expect(readFileSync(join(isolated.working_path, 'child-only.txt'), 'utf8')).toBe('committed\n');
    expect(
      git(isolated.working_path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).toBe(git(child, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    mkdirSync(join(isolated.working_path, 'subdir'));
    const worktreeConversation = run(join(isolated.working_path, 'subdir'), ['--no-worktree']);
    expect(runs.get(worktreeConversation)?.codebase_id).toBe(childRow.id);
    const subdirConversation = run(join(child, 'subdir'), ['--no-worktree']);
    expect(runs.get(subdirConversation)?.codebase_id).toBe(childRow.id);
    expect(codebases.all()).toHaveLength(2);
    expect(codebases.all().find(row => row.id === parentRow.id)).toEqual(parentRow);
  } finally {
    db.close();
  }
}, 120_000);
