// @archon-test-isolated
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { executeWorkflow } from '@archon/workflows/executor';
import { discoverWorkflows } from '@archon/workflows/workflow-discovery';
import { readRunDispatchMetadata } from '@archon/workflows/schemas/workflow-run';
import { configureIsolation } from '@archon/isolation';
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { createWorkflowStore, createWorkflowDeps } = await import('./store-adapter');
const isolation = await import('../db/isolation-environments');
const { createCodebaseChildResolver } = await import('./child-isolation-resolver');
const track = trackTempRoots();
const originalEnv = {
  ARCHON_HOME: process.env.ARCHON_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
};
let root: string;
let repo: string;
function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const platform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getPlatformType: () => 'test',
  getStreamingMode: () => 'batch',
};
beforeEach(async () => {
  registerBuiltinProviders();
  setPlatformPolicies([{ id: 'test', workspaceRetention: 'retain' }]);
  root = track(await realpath(await mkdtemp(join(tmpdir(), 'archon-child-base-'))));
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  repo = join(root, 'repo');
  await mkdir(join(repo, '.archon', 'workflows'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(
    join(repo, '.archon/workflows/child.yaml'),
    `name: child\ndescription: reports checkout base\nnodes:\n  - id: report\n    bash: 'printf "%s:" "$BASE_BRANCH"; git rev-parse HEAD'\n`
  );
  await writeFile(
    join(repo, '.archon/workflows/parent.yaml'),
    `name: parent\ndescription: isolates child\nnodes:\n  - id: child\n    workflow: child\n    isolation: worktree\n`
  );
  git('add', '.archon');
  git('commit', '-qm', 'workflows');
  git('branch', 'release-2026');
  git('checkout', '-q', 'release-2026');
  git('commit', '--allow-empty', '-qm', 'release only');
  git('checkout', '-q', 'main');
  const remote = join(root, 'remote.git');
  git('init', '--bare', '-q', '-b', 'main', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main', 'release-2026');
});
afterEach(() => {
  configureIsolation(async () => null);
  clearPlatformPolicies();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(async () => {
  await db.close();
});

for (const scenario of [
  {
    name: 'codebase default',
    fallback: 'release-2026',
    configured: undefined,
    expected: 'release-2026',
  },
  { name: 'repo config', fallback: 'main', configured: 'release-2026', expected: 'release-2026' },
  { name: 'remote detection', fallback: undefined, configured: undefined, expected: 'main' },
]) {
  test(`isolated child reports and records its provisioning base: ${scenario.name}`, async () => {
    await writeFile(
      join(repo, '.archon/config.yaml'),
      `worktree:\n  path: .worktrees\n${scenario.configured ? `  baseBranch: ${scenario.configured}\n` : ''}`
    );
    const codebaseId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      [codebaseId, 'test/repo', repo]
    );
    await db.query(
      "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'test', $1)",
      [conversationId]
    );
    const store = createWorkflowStore();
    const native = createWorkflowDeps(store);
    const deps: WorkflowDeps = {
      ...native,
      loadConfig: async path => ({
        ...(await native.loadConfig(path)),
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    };
    const resolver = createCodebaseChildResolver(
      isolation,
      { id: codebaseId, name: 'test/repo', default_cwd: repo, kind: 'repo' },
      { baseBranch: scenario.fallback, createdByPlatform: 'test', createdByUserId: undefined },
      deps
    );
    const discovered = await discoverWorkflows(repo, {
      providers: deps.providers,
      loadDefaults: false,
    });
    const parent = discovered.workflows.find(w => w.workflow.name === 'parent')?.workflow;
    if (!parent) throw new Error(JSON.stringify(discovered.errors));
    const expectedCommit = git('rev-parse', `origin/${scenario.expected}`);
    const result = await executeWorkflow(
      deps,
      platform,
      conversationId,
      repo,
      parent,
      'goal',
      { conversationId },
      {
        codebaseId,
        baseBranch: scenario.fallback,
        ...(scenario.name !== 'codebase default' ? { baseOverride: 'parent-only' } : {}),
        resolveChildIsolation: resolver,
      }
    );
    expect(result.success).toBe(true);
    const children = await store.findChildRuns(result.workflowRunId!);
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.status).toBe('completed');
    expect(readRunDispatchMetadata(child.metadata)?.base_branch).toBe(scenario.expected);
    expect(child.metadata.summary).toBe(`${scenario.expected}:${expectedCommit}`);
  });
}
