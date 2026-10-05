import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { canConnectToRunLiveOwner, runLiveOwnerPath } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

const repo = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];
const children = new Set<Bun.Subprocess>();
const detachedRuns: { id: string; home: string }[] = [];
afterEach(async () => {
  for (const child of children) {
    child.kill();
    await child.exited;
  }
  children.clear();
  const savedHome = process.env.ARCHON_HOME;
  try {
    for (const run of detachedRuns.splice(0)) {
      process.env.ARCHON_HOME = run.home;
      if (await canConnectToRunLiveOwner(runLiveOwnerPath(run.id))) {
        const target = await requestDetachedRunStop(run.id);
        await target.stop();
      }
    }
  } finally {
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
  }
  for (const root of roots.splice(0)) await removeTempTree(root);
});
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  .toString();
type CredentialMode = 'bot' | 'absent' | 'user' | 'scrub' | 'fallback';
interface Fixture {
  root: string;
  project: string;
  home: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}
interface RunRow {
  id: string;
  status: string;
  metadata: string;
}
function row(f: Fixture): RunRow | null {
  const database = join(f.home, 'archon.db');
  if (!existsSync(database)) return null;
  const db = new Database(database, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db
      .query<
        RunRow,
        []
      >('SELECT id, status, metadata FROM remote_agent_workflow_runs ORDER BY started_at DESC LIMIT 1')
      .get();
  } finally {
    db.close();
  }
}
async function run(
  f: Fixture,
  args: string[]
): Promise<{ code: number; output: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, f.entry, ...args], {
    cwd: f.project,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  children.delete(child);
  const output = stdout + stderr;
  expect(output.includes('stub-installation-') || output.includes('stub-user-credential')).toBe(
    false
  );
  return { code, output, stdout };
}
async function fixture(
  options: {
    wait?: 'event' | 'timer';
    fail?: boolean;
    mintFailure?: boolean;
    git?: boolean;
    repositoryUrl?: string;
    mode?: CredentialMode;
  } = {}
): Promise<Fixture> {
  const root = await canonicalizeProjectPath(mkdtempSync(join(tmpdir(), 'archon-cli-app-')));
  roots.push(root);
  let project = join(root, 'project');
  const home = join(root, 'home');
  const entry = join(root, 'entry.ts');
  mkdirSync(join(project, '.archon/workflows'), { recursive: true });
  project = await canonicalizeProjectPath(project);
  const marker = join(root, 'marker');
  if (options.git) {
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.test'],
    ]) {
      expect(Bun.spawnSync(['git', ...args], { cwd: project }).exitCode).toBe(0);
    }
  }
  const mode = options.mode ?? 'bot';
  const deliveryMode = options.mintFailure ? 'absent' : mode;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    LOG_LEVEL: 'silent',
    GITHUB_APP_ID: mode === 'absent' ? '' : '123',
    GITHUB_APP_PRIVATE_KEY: mode === 'absent' ? '' : privateKey,
    GITHUB_APP_PRIVATE_KEY_PATH: '',
    GITHUB_APP_SLUG: 'archon',
    GITHUB_APP_INSTALLATION_ID: '',
    GITHUB_TOKEN: '',
    GH_TOKEN: mode === 'absent' ? 'ambient-fixture' : '',
    WEBHOOK_SECRET: '',
    TOKEN_ENCRYPTION_KEY: ['user', 'scrub', 'fallback'].includes(mode) ? 'ab'.repeat(32) : '',
    GITHUB_APP_CLIENT_ID: '',
    ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: mode === 'fallback' ? 'true' : '',
    ARCHON_ALLOW_ORG_PROVIDER_TOKEN_FALLBACK: 'true',
  };
  // The loader distinguishes an absent optional ID from an explicitly invalid one.
  // The entry removes only this test's suppressed empty value after Bun loads env.
  const source = (p: string): string => JSON.stringify(join(repo, p));
  writeFileSync(
    entry,
    `
import { mock } from 'bun:test';
import { appendFileSync } from 'node:fs';
if (process.env.GITHUB_APP_INSTALLATION_ID === '') delete process.env.GITHUB_APP_INSTALLATION_ID;
let currentToken;
let minted = 0;
globalThis.fetch = async () => { throw new Error('Network forbidden in App auth fixture'); };
mock.module(${JSON.stringify(Bun.resolveSync('@octokit/rest', join(repo, 'packages/core')))}, () => ({ Octokit: class {
  async request(route, args) {
    if (route === 'GET /repos/{owner}/{repo}/installation') {
      if (args.owner !== 'fixture-owner' || args.repo !== 'fixture-repo') throw new Error('Wrong installation scope');
      appendFileSync(${JSON.stringify(join(root, 'scope'))}, 'scoped\\n');
      return { data: { id: 42 } };
    }
    if (route !== 'POST /app/installations/{installation_id}/access_tokens' || args.installation_id !== 42) throw new Error('Unexpected GitHub request');
    if (${options.mintFailure === true}) throw new Error('Stub installation mint refused');
    currentToken = 'stub-installation-' + (++minted) + '-' + process.pid;
    appendFileSync(${JSON.stringify(join(root, 'mint'))}, 'minted\\n');
    return { data: { token: currentToken, expires_at: new Date(Date.now() + 1000).toISOString() } };
  }
} }));
const userStore = await import(${source('packages/core/src/db/user-github-token-store.ts')});
mock.module(${source('packages/core/src/db/user-github-token-store.ts')}, () => ({
  ...userStore,
  getDecryptedAccessToken: async () => ${mode === 'user' ? "'stub-user-credential'" : 'null'},
  getUserGithubAuthor: async () => undefined,
}));
const { ClaudeProvider } = await import(${source('packages/providers/src/claude/provider.ts')});
ClaudeProvider.prototype.checkCredential = async () => ({ state: 'valid' });
ClaudeProvider.prototype.sendQuery = async function* (_prompt, _cwd, _session, options) {
  const expected = ${deliveryMode === 'user' ? "'stub-user-credential'" : deliveryMode === 'scrub' ? "''" : deliveryMode === 'absent' ? "'explicit-fixture'" : 'currentToken'};
  if (options?.env?.GH_TOKEN !== expected || options?.env?.GITHUB_TOKEN !== expected) throw new Error('AI credential delivery failed');
  if (${deliveryMode !== 'absent'} && !['GH_TOKEN', 'GITHUB_TOKEN'].every(key => options?.protectedEnvKeys?.includes(key))) throw new Error('Injected credentials unprotected');
  appendFileSync(${JSON.stringify(marker)}, 'ai\\n');
  yield { type: 'result', text: 'verified', sessionId: 'fixture-session' };
  yield { type: 'settled' };
};
if (process.argv[2] === 'seed') {
  const { createCodebase } = await import(${source('packages/core/src/db/codebases.ts')});
  const { closeDatabase } = await import(${source('packages/core/src/db/connection.ts')});
  await createCodebase({ name: 'fixture', default_cwd: ${JSON.stringify(project)}, kind: '${options.git ? 'repo' : 'folder'}', repository_url: ${JSON.stringify(options.repositoryUrl ?? 'https://github.com/fixture-owner/fixture-repo.git')} });
  const { findOrCreateUserByPlatformIdentity } = await import(${source('packages/core/src/db/users.ts')});
  const user = await findOrCreateUserByPlatformIdentity('cli', 'trigger-fixture');
  appendFileSync(${JSON.stringify(join(root, 'user'))}, user.id);
  await closeDatabase();
} else if (process.argv[2] === 'pause') {
  const { registerBuiltinProviders } = await import(${source('packages/providers/src/index.ts')});
  const { createCliWorkflowDeps } = await import(${source('packages/cli/src/utils/workflow-deps.ts')});
  const { createCodebase } = await import(${source('packages/core/src/db/codebases.ts')});
  const { getOrCreateConversation } = await import(${source('packages/core/src/db/conversations.ts')});
  const { closeDatabase } = await import(${source('packages/core/src/db/connection.ts')});
  const { findOrCreateUserByPlatformIdentity } = await import(${source('packages/core/src/db/users.ts')});
  const { InProcessWorkflowEngine } = await import(${source('packages/workflows/src/in-process-engine.ts')});
  const { prepareWorkflowSource, recordSelectedWorkflow } = await import(${source('packages/workflows/src/executor.ts')});
  const { discoverWorkflowsWithConfig } = await import(${source('packages/workflows/src/workflow-discovery.ts')});
  const { loadConfig } = await import(${source('packages/core/src/config/config-loader.ts')});
  const { HeadlessPlatform } = await import(${source('packages/core/src/workflows/headless-platform.ts')});
  const { setPlatformPolicies } = await import(${source('packages/core/src/platforms/registry.ts')});
  setPlatformPolicies([]);
  registerBuiltinProviders();
  const cwd = ${JSON.stringify(project)};
  const codebase = await createCodebase({ name: 'pause', default_cwd: cwd, kind: '${options.git ? 'repo' : 'folder'}', repository_url: 'https://github.com/fixture-owner/fixture-repo' });
  const user = await findOrCreateUserByPlatformIdentity('cli', 'app-fixture');
  const conversation = await getOrCreateConversation('cli', 'app-fixture', codebase.id, undefined, user.id);
  const deps = createCliWorkflowDeps();
  const source = await prepareWorkflowSource(deps, { sourceRoot: cwd });
  const discovery = await discoverWorkflowsWithConfig(cwd, loadConfig, source.roots);
  const workflow = discovery.workflows.find(entry => entry.workflow.name === 'app')?.workflow;
  if (!workflow) throw new Error('Fixture discovery failed');
  await recordSelectedWorkflow(source.anchor.root, workflow.name);
  const result = await new InProcessWorkflowEngine(deps).submit({ platform: new HeadlessPlatform(conversation.id), conversationId: conversation.id, conversationDbId: conversation.id, cwd, workflow, userMessage: 'verify', options: { codebaseId: codebase.id, preparedSource: source, userId: user.id } });
  if (!('paused' in result)) throw new Error('Fixture did not pause');
  await closeDatabase();
} else {
  await import(${source('packages/cli/src/cli.ts')});
}
`
  );
  const check =
    deliveryMode === 'scrub'
      ? '[ -z "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ]'
      : deliveryMode === 'absent'
        ? '[ "$GH_TOKEN" = "explicit-fixture" ] && [ "$GITHUB_TOKEN" = "explicit-fixture" ]'
        : deliveryMode === 'user'
          ? '[ "$GH_TOKEN" = "stub-user-credential" ] && [ "$GITHUB_TOKEN" = "$GH_TOKEN" ]'
          : '[ "${GH_TOKEN#stub-installation-}" != "$GH_TOKEN" ] && [ "$GITHUB_TOKEN" = "$GH_TOKEN" ]';
  const scriptCheck =
    deliveryMode === 'scrub'
      ? '!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN'
      : deliveryMode === 'absent'
        ? "process.env.GH_TOKEN === 'explicit-fixture' && process.env.GITHUB_TOKEN === 'explicit-fixture'"
        : deliveryMode === 'user'
          ? "process.env.GH_TOKEN === 'stub-user-credential' && process.env.GITHUB_TOKEN === process.env.GH_TOKEN"
          : "process.env.GH_TOKEN?.startsWith('stub-installation-') && process.env.GITHUB_TOKEN === process.env.GH_TOKEN";
  writeFileSync(
    join(project, '.archon/workflows/app.yaml'),
    `name: app
description: CLI App credential delivery
provider: claude
nodes:
  - id: bash
    bash: |
      ${check} || exit 41
      echo bash >> '${marker.replaceAll('\\', '/')}'
${options.fail ? '  - id: refuse\n    depends_on: [bash]\n    bash: test -f allow\n' : ''}${
      options.wait
        ? `  - id: pause
    depends_on: [bash]
    wait:
${options.wait === 'event' ? '      event: ready\n      deadline_ms: 60000' : '      duration_ms: 1000'}
`
        : ''
    }  - id: script
    depends_on: [${options.wait ? 'pause' : options.fail ? 'refuse' : 'bash'}]
    runtime: bun
    script: |
      if (!(${scriptCheck})) throw new Error('Script credential delivery failed');
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'script\\n');
  - id: ai
    depends_on: [script]
    prompt: Verify delivery.
`
  );
  writeFileSync(
    join(project, '.archon/config.yaml'),
    'env:\n  GH_TOKEN: explicit-fixture\n  GITHUB_TOKEN: explicit-fixture\n' +
      (options.git ? 'worktree:\n  path: .worktrees\n  baseBranch: main\n' : '')
  );
  if (options.git) {
    writeFileSync(join(project, '.gitignore'), '.worktrees/\n');
    expect(Bun.spawnSync(['git', 'add', '.archon', '.gitignore'], { cwd: project }).exitCode).toBe(
      0
    );
    expect(Bun.spawnSync(['git', 'commit', '-qm', 'Fixture'], { cwd: project }).exitCode).toBe(0);
    const remote = join(root, 'remote.git');
    expect(Bun.spawnSync(['git', 'init', '--bare', '-q', '-b', 'main', remote]).exitCode).toBe(0);
    expect(
      Bun.spawnSync(['git', 'remote', 'add', 'origin', remote], { cwd: project }).exitCode
    ).toBe(0);
    expect(
      Bun.spawnSync(['git', 'push', '-q', '-u', 'origin', 'main'], { cwd: project }).exitCode
    ).toBe(0);
  }
  const f = { root, project, home, entry, env };
  expect((await run(f, ['seed'])).code).toBe(0);
  return f;
}
function markers(f: Fixture): string {
  return existsSync(join(f.root, 'marker')) ? readFileSync(join(f.root, 'marker'), 'utf8') : '';
}
const runArgs = ['workflow', 'run', 'app', 'verify', '--no-worktree'];

test('normal CLI execution joins bootstrap, repository resolution and bash/script/AI delivery', async () => {
  const f = await fixture();
  expect((await run(f, runArgs)).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'scope'), 'utf8')).toBe('scoped\n');
  expect(row(f)?.status).toBe('completed');
}, 30000);

test('no App configuration preserves explicit environment over ambient credentials', async () => {
  const f = await fixture({ mode: 'absent' });
  expect((await run(f, runArgs)).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(existsSync(join(f.root, 'mint'))).toBe(false);
}, 30000);

test('a detached child bootstraps App auth independently without minting in the parent', async () => {
  const f = await fixture();
  const result = await run(f, [...runArgs, '--detach', '--json']);
  expect(result.code).toBe(0);
  const ack = JSON.parse(result.stdout) as { runId: string; logPath: string | null };
  detachedRuns.push({ id: ack.runId, home: f.home });
  const deadline = Date.now() + 20000;
  while (row(f)?.status !== 'completed' && Date.now() < deadline) await Bun.sleep(25);
  expect(row(f)?.status).toBe('completed');
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'mint'), 'utf8')).toBe('minted\n');
  const savedHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = f.home;
  try {
    while (await canConnectToRunLiveOwner(runLiveOwnerPath(ack.runId))) {
      if (Date.now() >= deadline) throw new Error('Detached owner did not release its endpoint');
      await Bun.sleep(25);
    }
  } finally {
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
  }
  detachedRuns.pop();
  if (ack.logPath)
    expect(readFileSync(ack.logPath, 'utf8').includes('stub-installation-')).toBe(false);
}, 30000);

test('cold CLI resume resolves credentials again from captured workflow source', async () => {
  const f = await fixture({ fail: true });
  expect((await run(f, runArgs)).code).not.toBe(0);
  const failed = row(f);
  if (!failed) throw new Error('Fixture run missing');
  expect(failed.status).toBe('failed');
  writeFileSync(join(f.project, 'allow'), 'ready');
  expect((await run(f, ['workflow', 'resume', failed.id])).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'mint'), 'utf8')).toBe('minted\nminted\n');
}, 30000);

for (const mode of ['user', 'scrub', 'fallback'] as const) {
  test(`CLI preserves per-user policy: ${mode}`, async () => {
    const f = await fixture({ mode });
    expect((await run(f, runArgs)).code).toBe(0);
    expect(markers(f)).toBe('bash\nscript\nai\n');
  }, 30000);
}

test('wait auto-resume re-resolves through the same process provider', async () => {
  const f = await fixture({ wait: 'timer' });
  expect((await run(f, runArgs)).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'mint'), 'utf8')).toBe('minted\nminted\n');
}, 30000);

test('cold signal preflights configuration before mutation, then admits with bot credentials', async () => {
  const f = await fixture({ wait: 'event' });
  expect((await run(f, ['pause'])).code).toBe(0);
  const paused = row(f);
  if (!paused) throw new Error('Fixture run missing');
  expect(paused.status).toBe('paused');
  const wait = (JSON.parse(paused.metadata) as { wait: { resumeAt: string } }).wait;
  const args = [
    'workflow',
    'signal',
    paused.id,
    '--event',
    'ready',
    '--resume-at',
    wait.resumeAt,
    '--json',
  ];
  f.env.GITHUB_APP_PRIVATE_KEY = 'invalid';
  expect((await run(f, args)).code).not.toBe(0);
  expect(row(f)?.metadata).toBe(paused.metadata);
  f.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  expect((await run(f, args)).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
}, 30000);

test('invalid configuration prevents detached dispatch before a pending run exists', async () => {
  const f = await fixture();
  f.env.GITHUB_APP_PRIVATE_KEY = 'invalid';
  expect((await run(f, [...runArgs, '--detach', '--json'])).code).not.toBe(0);
  expect(row(f)).toBeNull();
  expect(markers(f)).toBe('');
  expect(existsSync(join(f.root, 'mint'))).toBe(false);
}, 30000);

test('cold wake initializes credentials before admitting a due workflow', async () => {
  const f = await fixture({ wait: 'timer' });
  expect((await run(f, ['pause'])).code).toBe(0);
  const paused = row(f);
  if (!paused) throw new Error('Fixture run missing');
  expect(paused.status).toBe('paused');
  const wait = (JSON.parse(paused.metadata) as { wait: { resumeAt: string } }).wait;
  await Bun.sleep(Math.max(0, Date.parse(wait.resumeAt) - Date.now() + 10));
  expect((await run(f, ['workflow', 'wake', '--json'])).code).toBe(0);
  expect(row(f)?.status).toBe('completed');
  expect(markers(f)).toBe('bash\nscript\nai\n');
}, 30000);

test('default worktree CLI execution delivers repository-scoped App credentials to every node', async () => {
  const f = await fixture({ git: true });
  expect((await run(f, ['workflow', 'run', 'app', 'verify'])).code).toBe(0);
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'scope'), 'utf8')).toBe('scoped\n');
  expect(row(f)?.status).toBe('completed');
  const db = new Database(join(f.home, 'archon.db'), { readonly: true });
  try {
    const isolation = db
      .query<
        { working_path: string },
        []
      >('SELECT working_path FROM remote_agent_isolation_environments')
      .get();
    expect(isolation).not.toBeNull();
    expect(isolation?.working_path).not.toBe(f.project);
  } finally {
    db.close();
  }
}, 30000);

test('App mint failure fails the run before nodes can use configured or ambient credentials', async () => {
  const f = await fixture({ mintFailure: true });
  f.env.GH_TOKEN = 'ambient-fixture';
  const result = await run(f, runArgs);
  expect(result.code).not.toBe(0);
  expect(result.output.includes('Stub installation mint refused')).toBe(true);
  expect(readFileSync(join(f.root, 'scope'), 'utf8')).toBe('scoped\n');
  expect(row(f)?.status).toBe('failed');
  expect(markers(f)).toBe('');
}, 30000);

test('registered App auth leaves non-GitHub codebases using their existing environment', async () => {
  const f = await fixture({ mintFailure: true, repositoryUrl: 'https://example.com/owner/repo' });
  expect((await run(f, runArgs)).code).toBe(0);
  expect(row(f)?.status).toBe('completed');
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(existsSync(join(f.root, 'scope'))).toBe(false);
  expect(existsSync(join(f.root, 'mint'))).toBe(false);
}, 30000);

test('trigger execution in a cold child delivers repository-scoped App credentials', async () => {
  const f = await fixture();
  const config = join(f.root, 'trigger.json');
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      sourceInstanceId: 'app-fixture',
      binding: {
        bindingId: 'app-fixture',
        bindingRevision: null,
        hostId: 'app-fixture',
        runAsUserId: readFileSync(join(f.root, 'user'), 'utf8'),
        resource: 'app-fixture',
        overlap: 'queue',
        launch: {
          cwd: f.project,
          workflowName: 'app',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
      schedule: { intervalSeconds: 60, runAtLoad: false },
    })
  );
  expect((await run(f, ['trigger', 'fire', '--config', config])).code).toBe(0);
  const deadline = Date.now() + 20000;
  while (!['completed', 'failed'].includes(row(f)?.status ?? '') && Date.now() < deadline)
    await Bun.sleep(25);
  const triggered = row(f);
  if (triggered) detachedRuns.push({ id: triggered.id, home: f.home });
  expect(triggered?.status).toBe('completed');
  expect(markers(f)).toBe('bash\nscript\nai\n');
  expect(readFileSync(join(f.root, 'scope'), 'utf8')).toBe('scoped\n');
}, 30000);
