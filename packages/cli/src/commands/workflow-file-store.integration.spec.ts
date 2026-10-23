import { spawn } from 'node:child_process';
import * as processTools from '@archon/paths/plugin-process';
import { multiAttentionWorkflows } from '../test-support/multi-attention-fixture';
import { attentionQueueItemSchema } from '@archon/workflows/attention-queue';
import {
  resourceStartDispositionSchema,
  type ResourceStartDisposition,
} from '@archon/workflows/schemas/resource-start';
import { z } from '@hono/zod-openapi';
import {
  answeredPauseContinuation,
  runAttention,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { workflowEventRowSchema } from '@archon/workflows/schemas/workflow-event';
import { afterEach, beforeEach, expect, test, setSystemTime, spyOn } from 'bun:test';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { readdir } from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir, hostname } from 'node:os';
import { CliTestScope } from '../test-support/cli-test-scope';
import { getLogLevel, setLogLevel } from '@archon/paths';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import {
  clearPlatformPolicies,
  getRegisteredPlatformPolicies,
  setPlatformPolicies,
} from '@archon/core/platforms/registry';
import { createFileWorkflowHost } from '@archon/core/workflows/file-host';
import { triggerCommand } from './trigger';
import * as workflowCommands from './workflow';
import {
  runWorkflowAnswer,
  runWorkflowRespond,
  runWorkflowApprove,
  runWorkflowReject,
} from '../routes/workflow';
import { workflowContinuationCommand } from './workflow-continuations';
const scopes: CliTestScope[] = [];
let originalEnv: NodeJS.ProcessEnv;
let originalLogLevel: ReturnType<typeof getLogLevel>;
beforeEach(() => {
  originalEnv = { ...process.env };
  originalLogLevel = getLogLevel();
});
afterEach(closeFixtures);
async function closeFixtures(): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const scope of scopes.splice(0)) {
      try {
        await scope.close();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    process.env = originalEnv;
    setLogLevel(originalLogLevel);
    clearPlatformPolicies();
  }
  if (errors.length > 0) throw new AggregateError(errors, 'CLI fixture cleanup failed');
}
const repo = join(import.meta.dir, '../../../..');
interface Fixture {
  scope: CliTestScope;
  root: string;
  project: string;
  home: string;
  entry: string;
  trap: string;
  env: NodeJS.ProcessEnv;
}
function fixture(
  config = 'store: files\n',
  nativeStatus?: 'usable' | 'not_connected' | 'real'
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'cli-file-store-'));
  const scope = new CliTestScope(root);
  scopes.push(scope);
  const project = join(root, 'project'),
    home = join(root, 'home'),
    entry = join(root, 'entry.ts'),
    trap = join(root, 'sql-opens');
  mkdirSync(join(project, '.archon/workflows'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), config);
  writeFileSync(
    join(project, '.archon/workflows/portable.yaml'),
    `name: portable
description: file-backed lifecycle
worktree:
  enabled: false
nodes:
  - id: before
    bash: echo executed >> before-count; echo before
  - id: review
    depends_on: [before]
    approval:
      message: Approve?
      decisions:
        - id: approve
        - id: reject
  - id: after
    depends_on: [review]
    bash: echo finished > result.txt
`
  );
  const src = (path: string): string => JSON.stringify(join(repo, path));
  writeFileSync(
    entry,
    `import {mock} from 'bun:test';
import {appendFileSync} from 'node:fs';
const childProcess = await import('node:child_process');
const spawn = childProcess.spawn;
// Detached owners and bash nodes lead separate process groups; teardown needs both.
mock.module('node:child_process', () => ({...childProcess, spawn: (...args) => {
  const child = spawn(...args);
  if (args[2]?.detached && child.pid) appendFileSync(${JSON.stringify(scope.detachedPids)}, child.pid + String.fromCharCode(10));
  return child;
}}));
const fail=() => {appendFileSync(${JSON.stringify(trap)},'open\\n');throw new Error('SQL open trap');};
const connection=await import(${src('packages/core/src/db/connection.ts')});
mock.module(${src('packages/core/src/db/connection.ts')},()=>({...connection,getDatabase:fail,getDialect:fail,pool:{query:fail,connect:fail}}));
${
  nativeStatus
    ? `const {ClaudeProvider}=await import(${src('packages/providers/src/claude/provider.ts')});
${nativeStatus === 'real' ? '' : `ClaudeProvider.prototype.checkCredential=async()=>({state:${JSON.stringify(nativeStatus)},source:'native'});`}
const {registerBuiltinProviders}=await import(${src('packages/providers/src/in-process.ts')});
mock.module(${src('packages/core/src/providers/register-host-providers.ts')},()=>({registerHostProviders:async()=>registerBuiltinProviders()}));`
    : ''
}
await import(${src('packages/cli/src/cli.ts')});`
  );
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    GITHUB_APP_PRIVATE_KEY_PATH: '',
    GITHUB_APP_CLIENT_ID: '',
    TOKEN_ENCRYPTION_KEY: '',
    ARCHON_USER_ID: 'file-operator',
    ARCHON_TELEMETRY_DISABLED: '1',
    LOG_LEVEL: 'silent',
    WORKFLOW_ID: '',
    ARCHON_NODE_EXECUTION: '',
  };
  return { scope, root, project, home, entry, trap, env };
}
async function cli(
  f: ReturnType<typeof fixture>,
  args: string[],
  env = f.env,
  input = '',
  launchCwd = f.project
): Promise<{ output: string; error: string; code: number }> {
  return f.scope.run([process.execPath, f.entry, ...args], launchCwd, env, input);
}
async function commandResult(command: () => Promise<number | void>) {
  let output = '';
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += `${args.join(' ')}\n`;
  });
  const stdout = spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    output += String(args[0]);
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    const code = (await command()) ?? 0;
    return { code, output, error: '' };
  } catch (error) {
    return { code: 1, output, error: String(error) };
  } finally {
    log.mockRestore();
    stdout.mockRestore();
  }
}
test('a timed-out CLI child settles before its fixture is removed', async () => {
  const f = fixture();
  const childRoot = join(f.root, 'timed-out');
  mkdirSync(childRoot);
  const pidFile = join(f.root, 'child.pid');
  const proof = join(f.root, 'closed');
  const continued = join(f.root, 'continued');
  const spec = join(f.root, 'timeout.test.ts');
  writeFileSync(
    spec,
    `
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as cleanup from ${JSON.stringify(join(repo, 'packages/paths/src/test-utils.ts'))};
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CliTestScope } from ${JSON.stringify(join(import.meta.dir, '../test-support/cli-test-scope.ts'))};
const scope = new CliTestScope(${JSON.stringify(childRoot)});
afterEach(async () => {
  expect(existsSync(scope.root)).toBe(true);
  const pid = Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
  const removeTempTree = cleanup.removeTempTree;
  const removal = spyOn(cleanup, 'removeTempTree').mockImplementation(async root => {
    expect(() => process.kill(pid, 0)).toThrow();
    await removeTempTree(root);
  });
  try {
    await scope.close();
  } finally {
    removal.mockRestore();
  }
  expect(existsSync(scope.root)).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(scope.run([process.execPath, '-e', ''], scope.root, process.env)).rejects.toThrow('scope is closed');
  writeFileSync(${JSON.stringify(proof)}, 'closed');
});
let running: ReturnType<CliTestScope['run']>;
beforeEach(async () => {
  running = scope.run([process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 1500);`)}], scope.root, process.env);
  while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(10);
});
test('forced timeout', async () => {
  await running;
  writeFileSync(${JSON.stringify(continued)}, 'continued after timeout');
}, 1000);
`
  );
  const result = await f.scope.run([process.execPath, 'test', spec], repo, f.env);
  expect(result.code).toBe(1);
  expect(result.output + result.error).toContain('timed out');
  expect(readFileSync(proof, 'utf8')).toBe('closed');
  expect(existsSync(continued)).toBe(false);
  expect(existsSync(childRoot)).toBe(false);
});
test('failed fixture closes still clean other scopes and restore shared state', async () => {
  const first = fixture();
  const second = fixture();
  const third = fixture();
  writeFileSync(first.scope.detachedPids, '0');
  writeFileSync(third.scope.detachedPids, '0');
  process.env = { ...first.env };
  setLogLevel(originalLogLevel === 'error' ? 'silent' : 'error');
  setPlatformPolicies([{ id: 'cli', workspaceRetention: 'age-based' }]);
  try {
    const error = await closeFixtures().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.errors).toHaveLength(2);
    for (const failure of error.errors) {
      expect(failure).toMatchObject({ message: 'Invalid detached test PID' });
    }
    expect(existsSync(first.root)).toBe(true);
    expect(existsSync(second.root)).toBe(false);
    expect(existsSync(third.root)).toBe(true);
    expect(process.env).toEqual(originalEnv);
    expect(getLogLevel()).toBe(originalLogLevel);
    expect(getRegisteredPlatformPolicies).toThrow('Platform policies are not configured');
  } finally {
    unlinkSync(first.scope.detachedPids);
    unlinkSync(third.scope.detachedPids);
    await first.scope.close();
    await second.scope.close();
    await third.scope.close();
  }
});
test('invalid detached process records preserve the fixture', async () => {
  const f = fixture();
  writeFileSync(f.scope.detachedPids, '0');
  await expect(f.scope.close()).rejects.toThrow('Invalid detached test PID');
  expect(existsSync(f.root)).toBe(true);
  unlinkSync(f.scope.detachedPids);
});
test('a refused detached group signal requires proof that the group is gone', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (!child.pid) throw new Error('Missing detached child PID');
  writeFileSync(f.scope.detachedPids, String(child.pid));
  const refusedSignal = spyOn(processTools, 'terminateTree').mockRejectedValue(
    Object.assign(new Error('Signal refused'), { code: 'EPERM' })
  );
  try {
    await expect(f.scope.close()).rejects.toThrow(
      process.platform === 'win32' ? 'Signal refused' : 'Process groups still running'
    );
    expect(existsSync(f.root)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    if (process.platform === 'win32') refusedSignal.mockRestore();
    await f.scope.close();
    expect(existsSync(f.root)).toBe(false);
  } finally {
    refusedSignal.mockRestore();
    child.kill('SIGKILL');
    await exited;
  }
});
for (const launch of ['workflow', 'fire', 'drain'] as const) {
  test(`a timed-out ${launch} launcher stops its detached execution before removal`, async () => {
    setLogLevel('error');
    const outer = fixture();
    const f = fixture();
    const nodePid = join(f.project, 'node.pid');
    writeFileSync(
      join(f.project, 'hold.ts'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('node.pid', String(process.pid));
setInterval(() => {}, 1000);
`
    );
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    writeFileSync(
      join(f.project, '.archon/workflows/hold.yaml'),
      `name: hold
description: hold for teardown proof
worktree:
  enabled: false
nodes:
  - id: hold
    bash: exec ${executable} hold.ts
`
    );
    let args = ['workflow', 'run', 'hold', '--folder', '--no-worktree', '--detach'];
    if (launch !== 'workflow') {
      process.env = { ...f.env };
      registerBuiltinProviders();
      setPlatformPolicies([{ id: 'cli', workspaceRetention: 'age-based' }]);
      const host = await createFileWorkflowHost(join(f.home, 'store'));
      await host.records.codebases.createCodebase({
        name: 'timeout-test',
        default_cwd: realpathSync(f.project),
        kind: 'folder',
      });
      const user = await host.records.users.findOrCreateUserByPlatformIdentity(
        'cli',
        'file-operator'
      );
      if (!user) throw new Error('Missing test user');
      const config = join(f.root, 'trigger.json');
      writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          sourceInstanceId: 'timeout-test',
          schedule: { intervalSeconds: 60, runAtLoad: false },
          binding: {
            bindingId: 'timeout-test',
            bindingRevision: null,
            hostId: 'timeout-test',
            runAsUserId: user.id,
            resource: 'timeout-test',
            capacity: 1,
            overlap: 'queue',
            launch: {
              cwd: f.project,
              workflowName: 'hold',
              inputs: {},
              isolation: { kind: 'in-place' },
            },
          },
        })
      );
      args = ['trigger', 'fire', '--config', config];
      if (launch === 'drain') {
        const blocker = randomUUID();
        await host.deps.store.admitResourceStart({
          resource: 'timeout-test',
          capacity: 1,
          hostId: 'timeout-test',
          overlap: 'queue',
          launch: {
            version: 2,
            run: {
              id: blocker,
              workflow_name: 'holder',
              codebase_id: 'holder',
              user_message: '',
              metadata: {},
            },
            execution: {
              cwd: join(f.root, 'holder'),
              conversationId: blocker,
              isolation: { kind: 'in-place' },
            },
          },
        });
        await host.deps.store.claimPendingWorkflowRun(blocker);
        const queued = await commandResult(() => triggerCommand(host, 'fire', [], { config }));
        expect(queued.code).toBe(0);
        expect(JSON.parse(queued.output).bindings[0].disposition.status).toBe('queued');
        await host.deps.store.completeWorkflowRun(blocker, { duration_ms: 1 });
        args = ['trigger', 'drain', '--host', 'timeout-test'];
      }
    }
    const proof = join(outer.root, 'closed');
    const spec = join(outer.root, 'detached-timeout.test.ts');
    writeFileSync(
      spec,
      `
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as cleanup from ${JSON.stringify(join(repo, 'packages/paths/src/test-utils.ts'))};
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CliTestScope } from ${JSON.stringify(join(import.meta.dir, '../test-support/cli-test-scope.ts'))};
const scope = new CliTestScope(${JSON.stringify(f.root)});
let owners;
let node;
beforeEach(async () => {
  const result = await scope.run(${JSON.stringify([process.execPath, f.entry, ...args])}, ${JSON.stringify(f.project)}, { ...process.env, ARCHON_HOME: ${JSON.stringify(f.home)}, LOG_LEVEL: 'silent' });
  expect(result, result.output + result.error).toMatchObject({ code: 0 });
  while (!existsSync(${JSON.stringify(nodePid)})) await Bun.sleep(10);
  owners = readFileSync(scope.detachedPids, 'utf8').trim().split(String.fromCharCode(10)).map(Number);
  node = Number(readFileSync(${JSON.stringify(nodePid)}, 'utf8').trim());
  for (const owner of owners) process.kill(owner, 0);
  process.kill(node, 0);
});
afterEach(async () => {
  const removeTempTree = cleanup.removeTempTree;
  const removal = spyOn(cleanup, 'removeTempTree').mockImplementation(async root => {
    expect(existsSync(root)).toBe(true);
    for (const owner of owners) expect(() => process.kill(owner, 0)).toThrow();
    expect(() => process.kill(node, 0)).toThrow();
    await removeTempTree(root);
  });
  try { await scope.close(); } finally { removal.mockRestore(); }
  expect(existsSync(scope.root)).toBe(false);
  writeFileSync(${JSON.stringify(proof)}, 'closed');
});
test('forced detached timeout', async () => { await Bun.sleep(60000); }, 50);
`
    );
    const result = await outer.scope.run([process.execPath, 'test', spec], repo, f.env);
    expect(result.code).toBe(1);
    expect(result.output + result.error).toContain('timed out');
    expect(existsSync(proof), result.output + result.error).toBe(true);
    expect(readFileSync(proof, 'utf8')).toBe('closed');
    expect(existsSync(f.root)).toBe(false);
  }, 15000);
}
/** A Claude environment with no login, so only project settings can supply one. */
function withoutClaudeLogin(f: Fixture, claudeConfig: string): NodeJS.ProcessEnv {
  return {
    ...f.env,
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_API_KEY: '',
    CLAUDE_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_USE_MANTLE: '0',
    CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}
/** The file store's runs; a detached launch is awaited until its run settles. */
async function listRuns(f: Fixture, awaitSettled: boolean): Promise<WorkflowRun[]> {
  const store = await createFileWorkflowStore({ root: join(f.home, 'store') });
  let { runs } = await store.listWorkflowRuns();
  const deadline = Date.now() + 15000;
  while (
    awaitSettled &&
    Date.now() < deadline &&
    !runs.some(run => ['failed', 'paused'].includes(run.status))
  ) {
    await Bun.sleep(25);
    ({ runs } = await store.listWorkflowRuns());
  }
  return runs;
}
function isolatedCheckout(project: string): string {
  const paths = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain', '-z'], { cwd: project });
  const worktree = paths.stdout
    .toString()
    .split('\0')
    .filter(field => field.startsWith('worktree '))
    .map(field => field.slice('worktree '.length))
    .find(path => realpathSync(path) !== realpathSync(project));
  if (!worktree) throw new Error('Missing isolated checkout');
  return worktree;
}
test('a CLI user can launch a Claude workflow with files and native authentication', async () => {
  const f = fixture('store: files\ndefaultAssistant: claude\n', 'usable');
  writeFileSync(
    join(f.project, '.archon/workflows/native.yaml'),
    `name: native
description: native credential preflight
provider: claude
worktree:
  enabled: false
nodes:
  - id: review
    approval:
      message: Ready to call Claude?
      decisions:
        - id: approve
        - id: reject
  - id: ai
    depends_on: [review]
    prompt: Say hello
`
  );
  const started = await cli(f, ['workflow', 'run', 'native', '--folder', '--no-worktree']);
  expect(started, started.output + started.error).toMatchObject({ code: 0 });
  const listed = await cli(f, ['workflow', 'runs', '--json']);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.output).runs).toMatchObject([
    { workflow_name: 'native', status: 'paused', user_id: expect.any(String) },
  ]);
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 30000);
for (const nodeOverride of [false, true]) {
  test(`Claude native CLI preflight uses --cwd and node settings (override=${nodeOverride})`, async () => {
    const f = fixture(
      `store: files\ndefaultAssistant: claude\nassistants:\n  claude:\n    settingSources: ${nodeOverride ? '[]' : '[project]'}\n`,
      'real'
    );
    mkdirSync(join(f.project, '.claude'));
    writeFileSync(
      join(f.project, '.claude/settings.json'),
      JSON.stringify({ apiKeyHelper: 'printf project-key' })
    );
    const claudeConfig = join(f.root, 'claude-config');
    mkdirSync(claudeConfig);
    writeFileSync(
      join(f.project, '.archon/workflows/native.yaml'),
      `name: native
description: scoped native credentials
provider: claude
worktree:
  enabled: false
nodes:
  - id: review
    approval:
      message: Ready?
      decisions:
        - id: approve
        - id: reject
  - id: ai
    depends_on: [review]
    ${nodeOverride ? 'settingSources: [project]' : ''}
    prompt: Say hello
`
    );
    const env = withoutClaudeLogin(f, claudeConfig);
    const started = await cli(
      f,
      ['workflow', 'run', 'native', '--cwd', f.project, '--folder', '--no-worktree'],
      env,
      '',
      f.root
    );
    expect(started, started.output + started.error).toMatchObject({ code: 0 });
    const listed = await cli(f, ['workflow', 'runs', '--json']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output).runs).toMatchObject([
      { workflow_name: 'native', status: 'paused' },
    ]);
    expect(existsSync(f.trap)).toBe(false);
  }, 30000);
}
for (const detached of [false, true]) {
  for (const launchOnly of [true, false]) {
    test(`isolated Claude CLI checks the launch checkout, then the worktree (launchOnly=${launchOnly}, detached=${detached})`, async () => {
      const f = fixture(
        'store: files\ndefaultAssistant: claude\nassistants:\n  claude:\n    settingSources: [project]\n',
        'real'
      );
      const git = (...args: string[]): void => {
        const result = Bun.spawnSync(['git', ...args], {
          cwd: f.project,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      };
      git('init', '-b', 'main');
      git('remote', 'add', 'origin', f.project);
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'user.name', 'Fixture');
      writeFileSync(join(f.project, '.gitignore'), launchOnly ? '.claude/\n' : '');
      mkdirSync(join(f.project, '.claude'));
      const settings = join(f.project, '.claude/settings.json');
      writeFileSync(settings, JSON.stringify({ apiKeyHelper: 'printf worktree-key' }));
      writeFileSync(
        join(f.project, '.archon/workflows/native.yaml'),
        `name: native
description: isolated credentials
provider: claude
nodes:
  - id: before
    bash: echo executed > before-count
  - id: review
    depends_on: [before]
    approval:
      message: Ready?
      decisions:
        - id: approve
        - id: reject
  - id: ai
    depends_on: [review]
    prompt: Say hello
`
      );
      git('add', '.gitignore', '.archon');
      if (!launchOnly) git('add', '.claude');
      git('commit', '-m', 'Fixture');
      if (!launchOnly) unlinkSync(settings);
      const claudeConfig = join(f.root, 'claude-config');
      mkdirSync(claudeConfig);
      const env = withoutClaudeLogin(f, claudeConfig);
      const started = await cli(
        f,
        [
          'workflow',
          'run',
          'native',
          '--branch',
          'credential-test',
          '--base',
          'main',
          ...(detached ? ['--detach'] : []),
        ],
        env
      );
      if (!launchOnly) {
        // The login is committed but missing from the launch checkout, so the host check
        // before isolation refuses: no run row, no worktree.
        expect(started, started.output + started.error).toMatchObject({ code: 1 });
        expect(started.error).toContain('no usable login');
        expect(await listRuns(f, false)).toEqual([]);
        expect(() => isolatedCheckout(f.project)).toThrow('Missing isolated checkout');
        expect(existsSync(f.trap)).toBe(false);
        return;
      }
      // The launch checkout's login is gitignored, so the worktree has none: the check in
      // the worktree refuses before any node runs.
      expect(started, started.output + started.error).toMatchObject({ code: detached ? 0 : 1 });
      if (!detached) expect(started.error).toContain('no usable login');
      expect(await listRuns(f, detached)).toMatchObject([
        { workflow_name: 'native', status: 'failed' },
      ]);
      expect(existsSync(join(f.project, 'before-count'))).toBe(false);
      expect(existsSync(join(isolatedCheckout(f.project), 'before-count'))).toBe(false);
      expect(existsSync(f.trap)).toBe(false);
    }, 30000);
  }
}
for (const flags of [[], ['--detach']] as const) {
  test(`file-store CLI refuses missing native login before launch (${flags.join(' ') || 'foreground'})`, async () => {
    const f = fixture('store: files\ndefaultAssistant: claude\n', 'not_connected');
    writeFileSync(
      join(f.project, '.archon/workflows/native.yaml'),
      `name: native
description: refuse before launch
provider: claude
worktree:
  enabled: false
nodes:
  - id: before
    bash: echo executed > before-count
  - id: ai
    depends_on: [before]
    prompt: Say hello
`
    );
    const refused = await cli(f, [
      'workflow',
      'run',
      'native',
      '--folder',
      '--no-worktree',
      ...flags,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.output + refused.error).toContain('no usable login');
    expect(existsSync(join(f.project, 'before-count'))).toBe(false);
    const listed = await cli(f, ['workflow', 'runs', '--json']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output).runs).toEqual([]);
    expect(existsSync(f.trap)).toBe(false);
    expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
  }, 30000);
}
test('pause, approve in another process, and resume without any SQL connection', async () => {
  const f = fixture();
  f.env.GITHUB_APP_ID = '123';
  f.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  f.env.GITHUB_TOKEN = '';
  f.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
  // Per-user GitHub needs stored user tokens, so files refuse it rather than run unscrubbed.
  const perUser = await cli(f, ['workflow', 'run', 'portable', '--folder', '--no-worktree']);
  expect(perUser.code).toBe(1);
  expect(perUser.output + perUser.error).toContain('per-user GitHub');
  expect(perUser.output + perUser.error).toContain('store: database');
  expect(existsSync(join(f.project, 'before-count'))).toBe(false);
  // The GitHub App alone still initializes for file-backed runs.
  f.env.TOKEN_ENCRYPTION_KEY = '';
  const started = await cli(f, ['workflow', 'run', 'portable', '--folder', '--no-worktree']);
  expect(started.error).not.toContain('SQL open trap');
  expect(started, started.output + started.error).toMatchObject({ code: 0 });
  // The foreground renders progress from the file store's committed rows.
  expect(started.error).toContain('[workflow] Transcript: ');
  expect(started.error).toContain('[before] Started\n');
  expect(started.error).toMatch(/\[before\] Completed \(\d/);
  expect(started.error).toContain('[review] Waiting for approval: Approve?\n');
  const listed = await cli(f, ['workflow', 'runs', '--json']);
  expect(listed.code).toBe(0);
  const rows = JSON.parse(listed.output).runs;
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('paused');
  const id = rows[0].id;
  const approved = await cli(f, ['workflow', 'approve', id, 'Ship it', '--json']);
  expect(approved.code).toBe(0);
  expect(JSON.parse(approved.output)).toEqual({
    ok: true,
    runId: id,
    action: 'approve',
    type: 'approval_gate',
    workflowName: 'portable',
    resumable: true,
  });
  const resumed = await cli(f, ['workflow', 'resume', id]);
  expect(resumed.error).not.toContain('SQL open trap');
  expect(resumed.code).toBe(0);
  expect(resumed.error).toContain('[after] Started\n');
  expect(resumed.error).toMatch(/\[after\] Completed \(\d/);
  expect(resumed.error).not.toContain('[before] Started');
  const get = await cli(f, ['workflow', 'get', id, '--json', '--events']);
  expect(get.code).toBe(0);
  expect(JSON.parse(get.output)).toMatchObject({ id, status: 'completed' });
  const final = await cli(f, ['workflow', 'runs', '--json']);
  expect(JSON.parse(final.output).runs).toMatchObject([{ id, status: 'completed' }]);
  const cleanup = await cli(f, ['workflow', 'cleanup']);
  expect(cleanup, cleanup.output + cleanup.error).toMatchObject({ code: 0 });
  expect(readFileSync(join(f.project, 'before-count'), 'utf8')).toBe('executed\n');
  expect(readFileSync(join(f.project, 'result.txt'), 'utf8')).toBe('finished\n');
  const log = readFileSync(join(f.home, 'store/runs', id, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .flatMap(line => {
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !('events' in record))
        throw new Error('Invalid commit line');
      return workflowEventRowSchema.array().parse(record.events);
    });
  expect(log.filter(event => event.event_type === 'workflow_completed')).toHaveLength(1);
  expect(log.filter(event => event.event_type === 'approval_received')).toHaveLength(1);
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 60000);
test('detached JSON resume returns a refusal status to the process', async () => {
  const f = fixture();
  const started = await cli(f, ['workflow', 'run', 'portable', '--folder', '--no-worktree']);
  expect(started, started.output + started.error).toMatchObject({ code: 0 });
  const id = randomUUID();
  const result = await cli(f, ['workflow', 'resume', id, '--detach', '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.output)).toEqual({
    ok: false,
    runId: id,
    action: 'resume',
    error: `Workflow run not found: ${id}`,
  });
}, 30000);
test.each([
  {
    config: 'store: files\n',
    env: { DATABASE_URL: 'postgres://unreachable/archon' },
    message: 'DATABASE_URL',
  },
  {
    config: 'store: files\nconcurrency:\n  providers:\n    claude: 1\n',
    env: {},
    message: 'concurrency.providers',
  },
])(
  'file composition refuses $message before SQL',
  async ({ config, env, message }) => {
    const f = fixture(config);
    const result = await cli(f, ['workflow', 'runs', '--json'], { ...f.env, ...env });
    expect(result.code).toBe(1);
    expect(result.output + result.error).toContain(message);
    expect(result.output + result.error).toContain('store: database');
    expect(existsSync(f.trap)).toBe(false);
    expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
  },
  30000
);
test('wake schedule skips provider and file-store startup checks, as it does on SQL', async () => {
  // The schedule installs an OS timer and never opens the store; a bogus operation proves the
  // command was reached without installing anything.
  const f = fixture('store: files\nconcurrency:\n  providers:\n    claude: 1\n');
  const result = await cli(f, ['workflow', 'wake', 'schedule', 'bogus']);
  expect(result.code).toBe(1);
  expect(result.output + result.error).toContain('Usage: archon workflow wake schedule');
  expect(result.output + result.error).not.toContain('concurrency.providers');
}, 30000);
test('SQL-only AI settings fail explicitly under files', async () => {
  const f = fixture();
  const result = await cli(f, ['ai', 'show']);
  expect(result.code).toBe(1);
  expect(result.output + result.error).toContain('store: database');
  expect(existsSync(f.trap)).toBe(false);
}, 30000);

test('server startup refuses files before opening SQL or binding a port', async () => {
  const f = fixture();
  const entry = join(f.root, 'server.ts');
  writeFileSync(
    entry,
    `import {mock} from 'bun:test';
import {appendFileSync} from 'node:fs';
const fail=()=>{appendFileSync(${JSON.stringify(f.trap)},'open\\n');throw new Error('SQL open trap');};
const connection=await import(${JSON.stringify(join(repo, 'packages/core/src/db/connection.ts'))});
mock.module(${JSON.stringify(join(repo, 'packages/core/src/db/connection.ts'))},()=>({...connection,getDatabase:fail,getDialect:fail,pool:{query:fail,connect:fail}}));
const {startServer}=await import(${JSON.stringify(join(repo, 'packages/server/src/index.ts'))});
try {await startServer();process.exit(1);}catch(error){console.log(error.name+': '+error.message);process.exit(0);}`
  );
  const { output, error, code } = await f.scope.run([process.execPath, entry], f.project, f.env);
  expect(code).toBe(0);
  expect(error).not.toContain('SQL open trap');
  expect(output).toContain('FileStoreUnsupportedError');
  expect(output).toContain('server');
  expect(output).toContain('store: database');
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 30000);

test.each(['head', 'codebases'])(
  'non-git folder lookup preserves malformed %s errors',
  async member => {
    const f = fixture();
    mkdirSync(join(f.home, 'store/host'), { recursive: true });
    writeFileSync(
      join(f.home, member === 'head' ? 'store/head.json' : 'store/host/codebases.json'),
      member === 'head' ? '{"format":99,"seq":0}' : '{'
    );
    const result = await cli(f, ['workflow', 'run', 'portable', '--quiet']);
    expect(result.code).toBe(1);
    expect(result.output + result.error).not.toContain('Not in a git repository');
    expect(result.output + result.error).toContain(member === 'head' ? 'Invalid input' : 'JSON');
    expect(existsSync(f.trap)).toBe(false);
  },
  30000
);

test('non-git folder lookup reports the file lock holder and path', async () => {
  const f = fixture();
  const root = join(f.home, 'store');
  mkdirSync(root, { recursive: true });
  const owner = { host: hostname(), pid: process.pid, instance: 'test-holder' };
  writeFileSync(join(root, 'lock'), JSON.stringify(owner));
  const result = await cli(f, ['workflow', 'run', 'portable', '--quiet']);
  expect(result.code).toBe(1);
  expect(result.output + result.error).not.toContain('Not in a git repository');
  // The lock names its canonical path; Windows temp dirs can be 8.3 short names (RUNNER~1).
  expect(result.output + result.error).toContain(join(realpathSync.native(root), 'lock'));
  expect(result.output + result.error).toContain(String(owner.pid));
  expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(JSON.stringify(owner));
  expect(existsSync(f.trap)).toBe(false);
}, 30000);

test('timer fire admits, queues, skips and drains through files without SQL', async () => {
  const f = fixture();
  writeFileSync(
    join(f.project, '.archon/workflows/register.yaml'),
    `name: register
description: register project
worktree:
  enabled: false
nodes:
  - id: ready
    bash: echo ready
`
  );
  writeFileSync(
    join(f.project, '.archon/workflows/timer.yaml'),
    `name: timer
description: timer resource
worktree:
  enabled: false
nodes:
  - id: proof
    bash: echo timer >> timer-count
  - id: hold
    depends_on: [proof]
    wait:
      duration_ms: 600000
`
  );
  const registered = await cli(f, [
    'workflow',
    'run',
    'register',
    '--folder',
    '--no-worktree',
    '--quiet',
  ]);
  expect(registered, registered.output + registered.error).toMatchObject({ code: 0 });
  const identity = await cli(f, ['trigger', 'whoami']);
  expect(identity, identity.output + identity.error).toMatchObject({ code: 0 });
  const runAsUserId = JSON.parse(identity.output).runAsUserId;
  const config = (overlap: 'queue' | 'skip'): string => {
    const path = join(f.root, `timer-${overlap}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sourceInstanceId: 'timer',
        schedule: { intervalSeconds: 60, runAtLoad: false },
        binding: {
          bindingId: 'timer',
          bindingRevision: null,
          hostId: 'timer-host',
          runAsUserId,
          resource: 'timer',
          capacity: 1,
          overlap,
          launch: {
            cwd: f.project,
            workflowName: 'timer',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      })
    );
    return path;
  };
  const queueConfig = config('queue'),
    skipConfig = config('skip');
  async function fire(path: string): Promise<ResourceStartDisposition> {
    const result = await cli(f, ['trigger', 'fire', '--config', path]);
    expect(result, result.output + result.error).toMatchObject({ code: 0 });
    return z
      .object({ bindings: z.tuple([z.object({ disposition: resourceStartDispositionSchema })]) })
      .parse(JSON.parse(result.output)).bindings[0].disposition;
  }
  async function paused(id: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await cli(f, ['workflow', 'get', id, '--json']);
      expect(result, result.output + result.error).toMatchObject({ code: 0 });
      const row = JSON.parse(result.output);
      if (row.status === 'paused') return;
      expect(row.status).not.toBe('failed');
      await Bun.sleep(25);
    }
    throw new Error(`Timer run ${id} did not pause`);
  }
  const first = await fire(queueConfig);
  expect(first.status).toBe('admitted');
  if (first.status !== 'admitted') throw new Error('First timer was not admitted');
  await paused(first.runId);
  // The paused run gave back its slot but still holds the directory, so later fires for it
  // wait in the queue instead of failing the path lock.
  const queued = await fire(queueConfig);
  expect(queued).toMatchObject({ status: 'queued', blocker: { kind: 'run', id: first.runId } });
  const skipped = await fire(skipConfig);
  expect(skipped).toMatchObject({ status: 'skipped', blocker: { kind: 'run', id: first.runId } });
  const held = await cli(f, ['trigger', 'drain', '--host', 'timer-host']);
  expect(held, held.output + held.error).toMatchObject({ code: 0 });
  expect(existsSync(join(f.home, 'store/runs', queued.requestId))).toBe(false);
  expect(existsSync(join(f.home, 'store/runs', skipped.requestId))).toBe(false);
  const cancelled = await cli(f, ['workflow', 'abandon', first.runId]);
  expect(cancelled, cancelled.output + cancelled.error).toMatchObject({ code: 0 });
  const drained = await cli(f, ['trigger', 'drain', '--host', 'timer-host']);
  expect(drained, drained.output + drained.error).toMatchObject({ code: 0 });
  await paused(queued.requestId);
  const cancelledNext = await cli(f, ['workflow', 'abandon', queued.requestId]);
  expect(cancelledNext, cancelledNext.output + cancelledNext.error).toMatchObject({ code: 0 });
  expect(readFileSync(join(f.project, 'timer-count'), 'utf8')).toBe('timer\ntimer\n');
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 60000);

test('state commands use files, retain scope and CAS, and cleanup preserves latest tombstones', async () => {
  const f = fixture();
  expect(Bun.spawnSync(['git', 'init', '-q', f.project]).exitCode).toBe(0);
  async function state(args: string[], input = '', env = f.env) {
    return cli(f, ['state', ...args], env, input);
  }
  const put = await state(
    ['put', 'notes', '--project', 'owner/repo', '--if-revision', '0'],
    '{"seen":[]}'
  );
  expect(put, put.output + put.error).toMatchObject({ code: 0 });
  expect(JSON.parse(put.output)).toMatchObject({
    revision: 1,
    writer: { kind: 'surface', via: 'cli' },
  });
  const patch = await state(
    ['patch', 'notes', '--project', 'owner/repo'],
    '{"ops":[{"op":"append","path":"/seen","value":1}]}'
  );
  expect(patch, patch.output + patch.error).toMatchObject({ code: 0 });
  const get = await state(['get', 'notes', '--project', 'owner/repo']);
  expect(JSON.parse(get.output)).toMatchObject({ revision: 2, value: { seen: [1] } });
  const conflict = await state(
    ['put', 'notes', '--project', 'owner/repo', '--if-revision', '1'],
    '{}'
  );
  expect(conflict.code).toBe(3);
  const mismatch = await state(
    ['patch', 'notes'],
    '{"ops":[{"op":"set","path":"/wrong","value":true}]}',
    { ...f.env, WORKFLOW_ID: 'unknown-run', ARCHON_NODE_EXECUTION: '{}' }
  );
  expect(mismatch.code).toBe(5);
  expect(JSON.parse(mismatch.output).error).toContain('files does not know WORKFLOW_ID');
  const log = await state(['log', 'notes', '--project', 'owner/repo']);
  expect(JSON.parse(log.output).revisions.map((row: { revision: number }) => row.revision)).toEqual(
    [2, 1]
  );
  expect(
    (await state(['put', 'notes', '--install', '--raw', '--if-revision', '0'], 'hello')).code
  ).toBe(0);
  const raw = await state(['get', 'notes', '--install', '--raw']);
  expect(raw.output).toBe('hello');
  const deleted = await state(['delete', 'notes', '--project', 'owner/repo']);
  expect(deleted.code).toBe(0);
  const list = await state(['list', '--project', 'owner/repo']);
  expect(JSON.parse(list.output)).toMatchObject({
    documents: [{ name: 'notes', revision: 3, deleted: true }],
  });
  // The immutable fixture is born old rather than rewritten to age it.
  const root = join(f.home, 'store');
  const store = await createFileWorkflowStore({ root });
  const input = {
    scope: { kind: 'install' } as const,
    writer: { kind: 'surface', via: 'cli' } as const,
  };
  setSystemTime(new Date('2000-01-01T00:00:00Z'));
  try {
    for (const name of ['old-live', 'old-deleted']) {
      await store.putStateDocument({ ...input, name, value: {}, ifRevision: 0 });
      if (name === 'old-live')
        await store.putStateDocument({ ...input, name, value: { latest: true }, ifRevision: 1 });
      else await store.deleteStateDocument({ ...input, name });
    }
  } finally {
    setSystemTime();
  }
  const before = await readdir(join(root, 'state'), { recursive: true });
  const cleanup = await cli(f, ['workflow', 'cleanup', '7']);
  expect(cleanup, cleanup.output + cleanup.error).toMatchObject({ code: 0 });
  expect(cleanup.output).toContain('2 state revision');
  for (const name of ['old-live', 'old-deleted'])
    expect(
      (await store.listStateRevisions({ kind: 'install' }, name)).map(row => row.revision)
    ).toEqual([2]);
  expect(await store.getStateDocument({ kind: 'install' }, 'old-deleted')).toBeNull();
  const after = await readdir(join(root, 'state'), { recursive: true });
  expect(before.filter(path => !after.includes(path))).toHaveLength(2);
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 30000);

test('file-backed bash and script writes record run identity; checkout writes register their project', async () => {
  const f = fixture();
  const initialized = Bun.spawnSync(['git', 'init', '-q', f.project]);
  expect(initialized.exitCode).toBe(0);
  const registered = await cli(f, ['state', 'put', 'operator', '--if-revision', '0'], f.env, '{}');
  expect(registered, registered.output + registered.error).toMatchObject({ code: 0 });
  writeFileSync(
    join(f.project, '.archon/workflows/state.yaml'),
    `name: state
description: state from exec nodes
worktree:
  enabled: false
nodes:
  - id: script-write
    runtime: bun
    script: |
      const command = JSON.parse(process.env.ARCHON_CLI_COMMAND);
      const child = Bun.spawn([...command, 'state', 'patch', 'ledger'], {stdin:'pipe',stdout:'inherit',stderr:'inherit'});
      child.stdin.write('{"ops":[{"op":"append","path":"/seen","value":"script"}]}');
      child.stdin.end();
      if (await child.exited !== 0) throw new Error('State write failed');
  - id: bash-write
    depends_on: [script-write]
    bash: |
      bun -e 'const command = JSON.parse(process.env.ARCHON_CLI_COMMAND); const child = Bun.spawn([...command, "state", "patch", "ledger"], {stdin:"pipe",stdout:"inherit",stderr:"inherit"}); child.stdin.write(JSON.stringify({ops:[{op:"append",path:"/seen",value:"bash"}]})); child.stdin.end(); process.exit(await child.exited);'
`
  );
  const run = await cli(f, ['workflow', 'run', 'state', '--no-worktree']);
  expect(run, run.output + run.error).toMatchObject({ code: 0 });
  const log = await cli(f, ['state', 'log', 'ledger']);
  expect(log, log.output + log.error).toMatchObject({ code: 0 });
  const revisions = JSON.parse(log.output).revisions;
  expect(revisions).toMatchObject([
    {
      revision: 2,
      value: { seen: ['script', 'bash'] },
      writer: { kind: 'run', nodePath: 'bash-write' },
    },
    { revision: 1, writer: { kind: 'run', nodePath: 'script-write' } },
  ]);
  const runs = await cli(f, ['workflow', 'runs', '--json']);
  expect(
    revisions.every(
      (row: { writer: { runId: string } }) =>
        row.writer.runId === JSON.parse(runs.output).runs[0].id
    )
  ).toBe(true);
  expect(existsSync(join(f.home, 'store/host/codebases.json'))).toBe(true);
  expect(existsSync(f.trap)).toBe(false);
  expect(existsSync(join(f.home, 'archon.db'))).toBe(false);
}, 30000);

for (const action of ['answer', 'respond', 'approve', 'reject'] as const) {
  test(`${action} preserves its JSON answer acknowledgment fields`, async () => {
    const f = fixture();
    writeFileSync(
      join(f.project, '.archon/workflows/portable.yaml'),
      `name: portable
description: JSON answer acknowledgment
worktree:
  enabled: false
nodes:
  - id: review
    wait:
      attention: Continue?
      form: select
      options:
        - { id: approve }
        - { id: reject }
        - { id: retry }
`
    );
    const started = await cli(f, ['workflow', 'run', 'portable', '--folder', '--no-worktree']);
    expect(started, started.output + started.error).toMatchObject({ code: 0 });
    const store = await createFileWorkflowStore({ root: join(f.home, 'store') });
    const {
      runs: [run],
    } = await store.listWorkflowRuns();
    if (!run) throw new Error('Missing paused run');
    const attention = runAttention(run);
    if (attention?.kind !== 'attention') throw new Error('Run not awaiting answer');
    const result = await cli(f, [
      'workflow',
      action,
      run.id,
      ...(action === 'answer' ? ['--choose', 'approve'] : action === 'respond' ? ['retry'] : []),
      '--occurrence',
      attention.occurrence,
      '--json',
    ]);
    expect(result, result.output + result.error).toMatchObject({ code: 0 });
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      runId: run.id,
      action,
      workflowName: 'portable',
      resumable: true,
      ...(action === 'answer'
        ? { answer: { decision: 'approve', text: '' } }
        : action === 'approve'
          ? { type: 'attention' }
          : action === 'reject'
            ? { cancelled: false, maxAttemptsReached: false }
            : { decision: 'retry' }),
    });
  }, 30000);

  test(`${action} accepts an answer at capacity and refuses stale answers in supported modes`, async () => {
    const f = fixture();
    f.env.LOG_LEVEL = 'error';
    writeFileSync(
      join(f.project, '.archon/workflows/portable.yaml'),
      `name: portable
description: answer while resource is full
worktree:
  enabled: false
nodes:
  - id: review
    wait:
      attention: Continue?
      form: select
      options:
        - { id: approve }
        - { id: reject }
        - { id: retry }
  - id: after
    depends_on: [review]
    bash: echo finished >> result.txt
`
    );
    setLogLevel('error');
    registerBuiltinProviders();
    setPlatformPolicies([{ id: 'cli', workspaceRetention: 'age-based' }]);
    process.env = { ...f.env };
    const host = await createFileWorkflowHost(join(f.home, 'store'));
    await host.records.codebases.createCodebase({
      name: 'capacity-test',
      default_cwd: realpathSync(f.project),
      kind: 'folder',
    });
    const user = await host.records.users.findOrCreateUserByPlatformIdentity(
      'cli',
      'file-operator'
    );
    if (!user) throw new Error('Missing test user');
    const config = join(f.root, 'trigger.json');
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        sourceInstanceId: 'answer-test',
        schedule: { intervalSeconds: 60, runAtLoad: false },
        binding: {
          bindingId: 'answer-test',
          bindingRevision: null,
          hostId: 'answer-test',
          runAsUserId: user.id,
          resource: 'answer-test',
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: f.project,
            workflowName: 'portable',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      })
    );
    const fired = await commandResult(() => triggerCommand(host, 'fire', [], { config }));
    expect(fired, fired.output + fired.error).toMatchObject({ code: 0 });
    const store = host.deps.store;
    const {
      runs: [run],
    } = await store.listWorkflowRuns();
    if (!run) throw new Error('Missing resource run');
    const id = run.id;
    expect(run.status).toBe('paused');
    const attention = runAttention(run);
    if (attention?.kind !== 'attention') throw new Error('Run not awaiting answer');
    const args = (occurrence: string): string[] => [
      'workflow',
      action,
      id,
      ...(action === 'answer' ? ['--choose', 'approve'] : action === 'respond' ? ['retry'] : []),
      '--occurrence',
      occurrence,
    ];
    const answer = (occurrence: string, flags: string[] = []) =>
      commandResult(() => {
        const json = flags.includes('--json');
        const detach = flags.includes('--detach');
        const route = {
          commands: workflowCommands,
          host,
          positionals: ['workflow', action, id, ...(action === 'respond' ? ['retry'] : [])],
          values: { occurrence, json, detach, choose: ['approve'] },
          command: 'workflow',
          subcommand: action,
          cwd: f.project,
          effectiveCwd: f.project,
          json,
          detachedRunConfig: undefined,
          inheritedEnv: f.env,
          forgeTrustedEnv: f.env,
        };
        const routes = {
          answer: runWorkflowAnswer,
          respond: runWorkflowRespond,
          approve: runWorkflowApprove,
          reject: runWorkflowReject,
        };
        return routes[action](route);
      });
    const unchangedRun = await store.getWorkflowRun(id);
    const unchangedEvents = await store.listWorkflowEvents(id);
    for (const flags of [
      [],
      ['--json'],
      ...(action === 'answer' ? [] : [['--detach'], ['--detach', '--json']]),
    ]) {
      const refused = await answer('stale', flags);
      expect(refused, refused.output + refused.error).toMatchObject({ code: 1 });
      if (flags.includes('--json')) expect(JSON.parse(refused.output)).toMatchObject({ ok: false });
      expect(refused.output + refused.error).toContain(
        `awaiting occurrence '${attention.occurrence}'`
      );
      expect(await store.getWorkflowRun(id)).toEqual(unchangedRun);
      expect(await store.listWorkflowEvents(id)).toEqual(unchangedEvents);
    }
    const blocker = randomUUID();
    expect(
      await store.admitResourceStart({
        resource: 'answer-test',
        capacity: 1,
        hostId: 'answer-test',
        overlap: 'queue',
        launch: {
          version: 2,
          run: {
            id: blocker,
            workflow_name: 'holder',
            codebase_id: 'holder',
            user_message: '',
            metadata: {},
          },
          execution: {
            cwd: join(f.root, 'holder'),
            conversationId: blocker,
            isolation: { kind: 'in-place' },
          },
        },
      })
    ).toMatchObject({ status: 'admitted' });
    await store.claimPendingWorkflowRun(blocker);
    const answered =
      action === 'answer'
        ? await cli(f, args(attention.occurrence))
        : await answer(attention.occurrence);
    expect(answered, answered.output + answered.error).toMatchObject({ code: 0 });
    expect(answered.output).toContain('answer was recorded');
    expect(answered.output).toContain('waiting for capacity');
    expect(answered.output).toContain(blocker);
    expect(answered.output).toContain('continues when a slot frees');
    expect(answered.output + answered.error).not.toContain('failed to resume');
    expect(answered.output + answered.error).not.toContain('workflow resume');
    expect(answered.output + answered.error).not.toContain('resume_failed');
    expect(answered.output + answered.error).not.toContain('"level":50');
    const waiting = await store.getWorkflowRun(id);
    expect(waiting?.status).toBe('paused');
    expect(waiting?.metadata.capacity_wait).toMatchObject({ since: expect.any(String) });
    expect(waiting && answeredPauseContinuation(waiting)).toBeDefined();
    await store.completeWorkflowRun(blocker, { duration_ms: 1 });
    const woken =
      action === 'answer'
        ? await cli(f, ['workflow', 'wake', '--json'])
        : await commandResult(() => workflowContinuationCommand(host, 'wake', [], { json: true }));
    expect(woken, woken.output + woken.error).toMatchObject({ code: 0 });
    expect(JSON.parse(woken.output)).toMatchObject({
      outcomes: [{ runId: id, kind: 'accepted', status: 'completed' }],
    });
    expect(readFileSync(join(f.project, 'result.txt'), 'utf8')).toBe('finished\n');
    expect(
      (await store.listWorkflowEvents(id)).filter(event => event.event_type === 'wait_answered')
    ).toHaveLength(1);
  }, 30_000);
}

test('independent questions survive separate CLI processes and apply second first', async () => {
  const f = fixture();
  for (const [name, yaml] of Object.entries(multiAttentionWorkflows))
    writeFileSync(join(f.project, '.archon/workflows', `${name}.yaml`), yaml);
  const started = await cli(f, ['workflow', 'run', 'questions', '--folder', '--no-worktree']);
  expect(started, started.output + started.error).toMatchObject({ code: 0 });
  const queue = async () => {
    const result = await cli(f, ['workflow', 'attention', '--json']);
    expect(result, result.error).toMatchObject({ code: 0 });
    return attentionQueueItemSchema.array().parse(JSON.parse(result.output).items);
  };
  const items = (await queue()).sort((a, b) => a.fanOut!.index - b.fanOut!.index);
  expect(items).toHaveLength(2);
  const [first, second] = items;
  for (const item of items) {
    const read = await cli(f, ['workflow', 'attention', item.runId, '--json']);
    expect(read, read.error).toMatchObject({ code: 0 });
    expect(JSON.parse(read.output).item).toEqual(item);
  }
  const answer = async (item: typeof first, choose: string) => {
    if (item.kind !== 'attention') throw new Error('Expected attention');
    const answered = await cli(f, [
      'workflow',
      'answer',
      item.runId,
      '--occurrence',
      item.occurrence,
      '--choose',
      choose,
    ]);
    expect(answered, answered.output + answered.error).toMatchObject({ code: 0 });
  };
  await answer(second, 'defer');
  expect(await queue()).toEqual([first]);
  const store = await createFileWorkflowStore({ root: join(f.home, 'store') });
  const parentId = first.fanOut!.parentRunId;
  expect((await store.getWorkflowRun(parentId))?.status).toBe('paused');
  expect((await store.getWorkflowRun(second.runId))?.status).toBe('completed');
  expect(
    (await store.listWorkflowEvents(first.runId)).filter(e => e.step_name === 'apply')
  ).toEqual([]);
  await answer(first, 'accept');
  expect(await queue()).toEqual([]);
  expect((await store.getWorkflowRun(parentId))?.status).toBe('completed');
  expect((await store.findChildRuns(parentId)).map(r => r.id).sort()).toEqual(
    items.map(i => i.runId).sort()
  );
  expect(
    (await store.listWorkflowEvents(parentId)).find(
      e => e.event_type === 'node_completed' && e.step_name === 'answers'
    )?.data.structured_output
  ).toEqual([
    { key: 'first', decision: 'accept' },
    { key: 'second', decision: 'defer' },
  ]);
  for (const item of items) {
    const events = await store.listWorkflowEvents(item.runId);
    expect(events.filter(e => e.event_type === 'wait_answered')).toHaveLength(1);
    expect(
      events.filter(e => e.event_type === 'node_completed' && e.step_name === 'apply')
    ).toHaveLength(1);
  }
  expect(existsSync(f.trap)).toBe(false);
}, 30_000);
