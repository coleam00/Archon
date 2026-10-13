import { createSqlWorkflowHost } from '../sql-host';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import {
  prepareWorkflowSource,
  recordSelectedWorkflow,
  preparedWorkflowSourceRecord,
} from '@archon/workflows/executor';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { createWorkflowDeps } from '../store-adapter';
import { startAdmittedResourceStart } from '../resource-start-host';
import { createCodebase } from '../../db/codebases';
import { getOrCreateConversation } from '../../db/conversations';
import { findOrCreateUserByPlatformIdentity } from '../../db/users';
import { saveUserGithubToken } from '../../db/user-github-token-store';
import { admitResourceStart } from '../../db/resource-starts';
import { getDatabase, closeDatabase } from '../../db/connection';
import { loadConfig } from '../../config/config-loader';
import { dispatchBackgroundWorkflow } from '../../orchestrator/orchestrator';
import { setPlatformPolicies } from '../../platforms/registry';
import type { IPlatformAdapter } from '../../types';

for (const key of [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]) {
  Reflect.deleteProperty(process.env, key);
}

const [root, mode, connection] = process.argv.slice(2);
if (!root) throw new Error('Missing fixture root');
const project = join(root, 'project');
await mkdir(join(project, '.archon/workflows'), { recursive: true });
async function git(...args: string[]): Promise<void> {
  const child = Bun.spawn(['git', '-C', project, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ambient Archon',
      GIT_AUTHOR_EMAIL: 'ambient@example.test',
      GIT_COMMITTER_NAME: 'Ambient Archon',
      GIT_COMMITTER_EMAIL: 'ambient@example.test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(stderr);
}
await git('init', '-b', 'main');
await git('config', 'user.name', 'Ambient Archon');
await git('config', 'user.email', 'ambient@example.test');
await git('remote', 'add', 'origin', project);
await writeFile(
  join(project, '.archon/workflows/author.yaml'),
  `name: author
description: Commit attribution proof
provider: claude
worktree:
  enabled: ${mode === 'adopted' || mode === 'worktree'}
nodes:
  - id: commit
    bash: |
      git -c commit.gpgsign=false commit --allow-empty -m proof
      printf '%s\\n' "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL"
  - id: finish
    depends_on: [commit]
    bash: echo done
`
);
await git('add', '.archon');
await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
registerBuiltinProviders();
setPlatformPolicies([]);
const codebase = await createCodebase({
  name: 'author-fixture',
  default_cwd: project,
  ...(mode === 'folder'
    ? { kind: 'folder' as const }
    : { repository_url: 'https://github.com/example/author-fixture' }),
  default_branch: 'main',
});
const user = await findOrCreateUserByPlatformIdentity('cli', 'author-operator');
const other = await findOrCreateUserByPlatformIdentity('cli', 'other-operator');
await saveUserGithubToken({
  userId: connection === 'missing' ? other.id : user.id,
  githubUserId: 42,
  githubLogin: 'connected-author',
  accessToken: 'fixture-token',
});
const conversation = await getOrCreateConversation(
  'cli',
  'author-fixture',
  codebase.id,
  undefined,
  user.id
);
const deps = createWorkflowDeps();
const engine = new InProcessWorkflowEngine(deps);
const platform: IPlatformAdapter = {
  capabilities: { messagePersistence: 'core', defaultWorkflowDispatch: 'background' },
  sendMessage: async () => undefined,
  ensureThread: async id => id,
  getStreamingMode: () => 'batch',
  getPlatformType: () => 'cli',
  start: async () => undefined,
  stop: () => undefined,
};
try {
  if (mode === 'cli') {
    await closeDatabase();
    const cliEntry = join(root, 'cli.ts');
    await writeFile(
      cliEntry,
      `
import { mock } from 'bun:test';
if (process.env.GITHUB_APP_INSTALLATION_ID === '') delete process.env.GITHUB_APP_INSTALLATION_ID;
globalThis.fetch = async () => { throw new Error('Network forbidden in commit-author fixture'); };
mock.module(${JSON.stringify(Bun.resolveSync('@octokit/rest', import.meta.dir))}, () => ({
  Octokit: class {
    async request(route) {
      if (route === 'GET /repos/{owner}/{repo}/installation') return { data: { id: 42 } };
      if (route !== 'POST /app/installations/{installation_id}/access_tokens') throw new Error('Unexpected GitHub request');
      return { data: { token: 'fixture-installation-credential', expires_at: new Date(Date.now() + 3600000).toISOString() } };
    }
  }
}));
await import(${JSON.stringify(resolve(import.meta.dir, '../../../../cli/src/cli.ts'))});
`
    );
    const child = Bun.spawn(
      [process.execPath, cliEntry, 'workflow', 'run', 'author', '--cwd', project, '--no-worktree'],
      { cwd: root, env: process.env, stdout: 'inherit', stderr: 'inherit' }
    );
    if (await child.exited) throw new Error('CLI workflow failed');
  } else {
    const source = await prepareWorkflowSource(deps, { sourceRoot: project });
    const discovery = await discoverWorkflowsWithConfig(
      project,
      loadConfig,
      deps.providers,
      source.roots
    );
    const workflow = discovery.workflows.find(entry => entry.workflow.name === 'author')?.workflow;
    if (!workflow) throw new Error(JSON.stringify(discovery.errors));
    await recordSelectedWorkflow(source.anchor.root, workflow.name);
    if (mode === 'resource') {
      const admitted = await admitResourceStart({
        resource: 'author',
        capacity: 1,
        hostId: 'author-host',
        overlap: 'queue',
        launch: {
          version: 2,
          run: {
            id: source.runId,
            workflow_name: workflow.name,
            origin: { conversationId: conversation.id, userId: user.id },
            codebase_id: codebase.id,
            user_message: '',
            working_path: project,
            metadata: { workflow_source: preparedWorkflowSourceRecord(source) },
          },
          execution: {
            cwd: project,
            conversationId: conversation.id,
            isolation: { kind: 'in-place' },
          },
        },
      });
      if (admitted.status !== 'admitted') throw new Error('Not admitted');
      const result = await startAdmittedResourceStart({
        requestId: admitted.requestId,
        hostId: 'author-host',
        host: { ...createSqlWorkflowHost(deps), engine },
        createPlatform: () => platform,
      });
      if (!result.success) throw new Error(JSON.stringify(result));
    } else {
      let cwd = project;
      if (mode === 'adopted') {
        cwd = join(root, 'adopted');
        await git('worktree', 'add', '-b', 'adopted', cwd);
      }
      await dispatchBackgroundWorkflow(
        {
          platform,
          conversationId: conversation.id,
          conversationDbId: conversation.id,
          cwd: project,
          originalMessage: 'Commit proof',
          codebaseId: codebase.id,
          availableWorkflows: [workflow],
          userId: user.id,
          ...(mode === 'adopted'
            ? { adoptionLane: { kind: 'reuse-worktree' as const, workingPath: cwd } }
            : {}),
        },
        workflow
      );
      const deadline = Date.now() + 15_000;
      while (true) {
        const rows = await getDatabase().query<{ status: string; working_path: string }>(
          'SELECT status, working_path FROM remote_agent_workflow_runs ORDER BY started_at DESC LIMIT 1'
        );
        const run = rows.rows[0];
        if (run?.status === 'completed') break;
        if (run?.status === 'failed' || Date.now() > deadline) throw new Error(JSON.stringify(run));
        await Bun.sleep(20);
      }
    }
  }
  const rows = await getDatabase().query<{ working_path: string }>(
    'SELECT working_path FROM remote_agent_workflow_runs ORDER BY started_at DESC LIMIT 1'
  );
  await writeFile(join(root, 'working-path'), rows.rows[0]?.working_path ?? project);
} finally {
  await closeDatabase();
}
