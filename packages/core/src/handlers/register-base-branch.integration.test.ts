// @archon-test-isolated
import { setPlatformPolicies } from '../platforms/registry';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { WorktreeProvider } from '@archon/isolation';
import { getDefaultBranch, syncWorkspace, toRepoPath, toBranchName } from '@archon/git';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';

const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-base-branch-')));
const dbPath = join(root, 'upgrade.sqlite');
const vintage = new Database(dbPath);
vintage.exec(
  await readFile(join(import.meta.dir, '../db/fixtures/sqlite-vintages/v0.11.0.sql'), 'utf8')
);
vintage.run(
  "INSERT INTO remote_agent_codebases (id, name, default_cwd, default_branch) VALUES ('legacy-explicit', 'legacy-explicit', '/legacy-explicit', 'release'), ('legacy-null', 'legacy-null', '/legacy-null', NULL)"
);
vintage.close();
const db = new SqliteAdapter(dbPath);
setPlatformPolicies([]);
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { registerRepository, registerFolder, inspectProjectBaseBranch } =
  await import('./sql-registration');
const { getCodebase, updateCodebase, listCodebases } = await import('../db/codebases');
// This test hosts a workflow run, so it registers providers the way CLI and server do.
registerBuiltinProviders();
const originalHome = process.env.ARCHON_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
});
afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}
async function fixture(name: string): Promise<{ remote: string; local: string }> {
  const remote = join(root, `${name}.git`);
  const local = join(root, name);
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=dev', remote]);
  execFileSync('git', ['clone', '-q', remote, local]);
  git(local, 'commit', '--allow-empty', '-qm', 'dev');
  git(local, 'push', '-q', 'origin', 'dev');
  git(local, 'checkout', '-qb', 'release');
  git(local, 'commit', '--allow-empty', '-qm', 'release');
  git(local, 'push', '-q', 'origin', 'release');
  git(local, 'remote', 'set-head', 'origin', '-a');
  git(local, 'checkout', '-qb', 'private-feature');
  process.env.ARCHON_HOME = join(root, name, '.archon-home');
  return { remote, local };
}
async function worktree(local: string, id: string, identifier: string): Promise<string> {
  const codebase = await getCodebase(id);
  if (!codebase) throw new Error('fixture codebase missing');
  const env = await new WorktreeProvider().create({
    codebaseId: id,
    canonicalRepoPath: toRepoPath(local),
    workflowType: 'task',
    identifier,
    baseBranch: codebase.default_branch ? toBranchName(codebase.default_branch) : undefined,
  });
  return env.workingPath;
}

test('feature checkout stores null; worktrees follow a renamed advertised default despite stale origin/HEAD', async () => {
  const { remote, local } = await fixture('follow');
  const before = await listCodebases();
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  });
  expect(await listCodebases()).toEqual(before);
  const result = await registerRepository(local);
  expect(result.defaultBranch).toBeNull();
  expect((await getCodebase(result.codebaseId))?.default_branch).toBeNull();
  const first = await worktree(local, result.codebaseId, 'first');
  expect(git(first, 'rev-parse', 'HEAD')).toBe(git(local, 'rev-parse', 'origin/dev'));
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/release');
  expect(git(local, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/dev');
  const second = await worktree(local, result.codebaseId, 'second');
  expect(git(second, 'rev-parse', 'HEAD')).toBe(git(local, 'rev-parse', 'origin/release'));
  expect(await getDefaultBranch(toRepoPath(local))).toBe(toBranchName('release'));
  expect((await registerRepository(local)).defaultBranch).toBeNull();
}, 30000);

test('explicit branch is stored and used, preserved on re-registration, and unknown choices share the engine error', async () => {
  const { remote, local } = await fixture('pinned');
  const result = await registerRepository(local, { baseBranch: 'dev' });
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/release');
  const path = await worktree(local, result.codebaseId, 'pinned');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(git(local, 'rev-parse', 'origin/dev'));
  expect((await registerRepository(local)).defaultBranch).toBe('dev');
  await expect(registerRepository(local, { baseBranch: 'release' })).rejects.toThrow(
    'initial registration'
  );
  const other = await fixture('unknown');
  let registrationMessage = '';
  try {
    await registerRepository(other.local, { baseBranch: 'unknown' });
  } catch (error) {
    registrationMessage = (error as Error).message;
  }
  expect(registrationMessage).toContain(
    "Configured base branch 'unknown' not found on remote 'origin'"
  );
  await expect(syncWorkspace(toRepoPath(other.local), toBranchName('unknown'))).rejects.toThrow(
    registrationMessage
  );
}, 30000);

test('offline explicit choice is stored; folders and invalid branch syntax reject choices', async () => {
  const { local } = await fixture('offline');
  git(local, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  expect((await registerRepository(local, { baseBranch: 'future' })).defaultBranch).toBe('future');
  await expect(registerFolder(root, undefined, { baseBranch: 'dev' })).rejects.toThrow(
    'Folder projects have no base branch'
  );
  const invalid = await fixture('invalid');
  await expect(registerRepository(invalid.local, { baseBranch: 'bad..branch' })).rejects.toThrow(
    'Invalid base branch'
  );
}, 30000);

test('shipped rows retain null and explicit choices after opening the upgraded database and resolve at use', async () => {
  const { local } = await fixture('legacy');
  const legacyExplicit = await getCodebase('legacy-explicit');
  const legacyNull = await getCodebase('legacy-null');
  expect(legacyExplicit?.default_branch).toBe('release');
  expect(legacyNull?.default_branch).toBeNull();
  if (!legacyExplicit || !legacyNull) throw new Error('legacy rows missing');
  await updateCodebase(legacyExplicit, { default_cwd: local });
  await updateCodebase(legacyNull, { default_cwd: local });
  const explicit = await worktree(local, 'legacy-explicit', 'legacy-explicit');
  const automatic = await worktree(local, 'legacy-null', 'legacy-null');
  expect(git(explicit, 'rev-parse', 'HEAD')).toBe(git(local, 'rev-parse', 'origin/release'));
  expect(git(automatic, 'rev-parse', 'HEAD')).toBe(git(local, 'rev-parse', 'origin/dev'));
}, 30000);

test('prefill distinguishes unavailable remote, unknown HEAD, absent or ambiguous remote, and folders', async () => {
  const { local, remote } = await fixture('prefill');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/unknown');
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'unknown_head',
  });
  git(local, 'remote', 'set-url', 'origin', join(root, 'unavailable.git'));
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'remote_unavailable',
  });
  git(local, 'remote', 'remove', 'origin');
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'no_remote',
  });
  git(local, 'remote', 'add', 'upstream', remote);
  git(local, 'remote', 'add', 'other', remote);
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'ambiguous_remote',
  });
  await mkdir(join(local, '.archon'));
  await writeFile(join(local, '.archon', 'config.yaml'), 'worktree:\n  remote: " upstream "\n');
  expect(await inspectProjectBaseBranch({ path: local })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'unknown_head',
  });
  const subdirectory = join(local, 'subdirectory');
  await mkdir(subdirectory);
  expect(await inspectProjectBaseBranch({ path: subdirectory })).toEqual({
    kind: 'repo',
    defaultBranch: null,
    reason: 'ambiguous_remote',
  });
  await expect(registerRepository(local, { baseBranch: 'absent' })).rejects.toThrow(
    "Configured base branch 'absent' not found on remote 'upstream'"
  );
  expect(await inspectProjectBaseBranch({ path: root })).toEqual({ kind: 'folder' });
}, 30000);

test('configured upstream controls the worktree commit, dispatch metadata and BASE_BRANCH', async () => {
  const { local, remote } = await fixture('configured-remote');
  const upstream = join(root, 'upstream.git');
  execFileSync('git', ['clone', '--bare', '-q', remote, upstream]);
  git(upstream, 'symbolic-ref', 'HEAD', 'refs/heads/release');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'checkout', 'release');
  await mkdir(join(local, '.archon'));
  const config = 'worktree:\n  remote: " upstream "\n';
  await writeFile(join(local, '.archon', 'config.yaml'), config);
  git(local, 'add', '.archon/config.yaml');
  git(local, 'commit', '-qm', 'select upstream');
  git(local, 'push', '-q', 'upstream', 'release');
  git(local, 'checkout', 'private-feature');
  await mkdir(join(local, '.archon'), { recursive: true });
  await writeFile(join(local, '.archon', 'config.yaml'), config);
  const project = await registerRepository(local);
  const provider = new WorktreeProvider(async () => ({ remote: ' upstream ' }));
  const env = await provider.create({
    codebaseId: project.codebaseId,
    canonicalRepoPath: toRepoPath(local),
    workflowType: 'task',
    identifier: 'upstream-dispatch',
  });
  expect(git(env.workingPath, 'rev-parse', 'HEAD')).toBe(
    git(local, 'rev-parse', 'upstream/release')
  );
  expect(git(env.workingPath, 'rev-parse', 'HEAD')).not.toBe(git(local, 'rev-parse', 'origin/dev'));
  const { createWorkflowDeps } = await import('../workflows/store-adapter');
  const { getOrCreateConversation } = await import('../db/conversations');
  const { getWorkflowRun } = await import('../db/workflows');
  const { executeWorkflow } = await import('@archon/workflows/executor');
  const { resolveWorkflow } = await import('@archon/workflows/graph-plan');
  const { readRunDispatchMetadata } = await import('@archon/workflows/schemas/workflow-run');
  const conversation = await getOrCreateConversation(
    'cli',
    'upstream-dispatch',
    project.codebaseId
  );
  const output = join(env.workingPath, 'base-branch.txt');
  const result = await executeWorkflow(
    createWorkflowDeps(),
    { sendMessage: async () => {}, getPlatformType: () => 'cli', getStreamingMode: () => 'batch' },
    'upstream-dispatch',
    env.workingPath,
    resolveWorkflow({
      name: 'branch-proof',
      description: 'Prove selected remote branch',
      nodes: [
        {
          id: 'base',
          kind: 'exec',
          runtime: 'sh',
          script: 'printf "%s" "$BASE_BRANCH" > base-branch.txt',
        },
      ],
    }),
    'prove the configured remote',
    { conversationId: conversation.id },
    { codebaseId: project.codebaseId }
  );
  expect(result.success).toBe(true);
  expect(await readFile(output, 'utf8')).toBe('release');
  if (!result.workflowRunId) throw new Error('run missing');
  const run = await getWorkflowRun(result.workflowRunId);
  expect(readRunDispatchMetadata(run?.metadata)?.base_branch).toBe('release');
}, 30000);

test('the exported inspection seam rejects an ambiguous source before inspecting either', async () => {
  const ambiguous = { url: 'https://example.com/repo', path: root };
  // @ts-expect-error Both sources violate the exported exclusive source contract.
  await expect(inspectProjectBaseBranch(ambiguous)).rejects.toThrow('Provide either');
});
