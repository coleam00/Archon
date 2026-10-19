import {
  resourceStartDispositionSchema,
  type ResourceStartDisposition,
} from '@archon/workflows/schemas/resource-start';
import { z } from '@hono/zod-openapi';
import { answeredPauseContinuation, runAttention } from '@archon/workflows/schemas/workflow-run';
import { workflowEventRowSchema } from '@archon/workflows/schemas/workflow-event';
import { expect, test, setSystemTime } from 'bun:test';
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
import { trackTempRoots } from '@archon/paths/test-utils';
const roots = trackTempRoots();
const repo = join(import.meta.dir, '../../../..');
interface Fixture {
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
  const root = roots(mkdtempSync(join(tmpdir(), 'cli-file-store-')));
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
  return { root, project, home, entry, trap, env };
}
async function cli(
  f: ReturnType<typeof fixture>,
  args: string[],
  env = f.env,
  input = '',
  launchCwd = f.project
): Promise<{ output: string; error: string; code: number }> {
  const child = Bun.spawn([process.execPath, f.entry, ...args], {
    cwd: launchCwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, error, code };
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
    const env = {
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
    test(`isolated Claude CLI checks the worktree account (launchOnly=${launchOnly}, detached=${detached})`, async () => {
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
      const env = {
        ...f.env,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_API_KEY: '',
        CLAUDE_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_MANTLE: '0',
        CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
        CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0',
      };
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
      expect(started, started.output + started.error).toMatchObject({
        code: launchOnly && !detached ? 1 : 0,
      });
      if (launchOnly && !detached) expect(started.error).toContain('no usable login');
      const store = await createFileWorkflowStore({ root: join(f.home, 'store') });
      let { runs } = await store.listWorkflowRuns();
      if (detached) {
        const deadline = Date.now() + 15000;
        while (
          Date.now() < deadline &&
          !runs.some(run => ['failed', 'paused'].includes(run.status))
        ) {
          await Bun.sleep(25);
          ({ runs } = await store.listWorkflowRuns());
        }
      }
      expect(runs).toMatchObject([
        { workflow_name: 'native', status: launchOnly ? 'failed' : 'paused' },
      ]);
      if (!launchOnly)
        expect(existsSync(join(runs[0]?.working_path ?? '', 'before-count'))).toBe(true);
      expect(existsSync(join(f.project, 'before-count'))).toBe(false);
      expect(existsSync(f.trap)).toBe(false);
      if (launchOnly) {
        const paths = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain', '-z'], {
          cwd: f.project,
        });
        const worktrees = paths.stdout
          .toString()
          .split('\0')
          .filter(field => field.startsWith('worktree '))
          .map(field => field.slice('worktree '.length));
        const worktree = worktrees.find(path => realpathSync(path) !== realpathSync(f.project));
        if (!worktree) throw new Error('Missing isolated checkout');
        expect(existsSync(join(worktree, 'before-count'))).toBe(false);
        if (detached) return;
        mkdirSync(join(worktree, '.claude'));
        writeFileSync(
          join(worktree, '.claude/settings.json'),
          JSON.stringify({ apiKeyHelper: 'printf reused-key' })
        );
        unlinkSync(settings);
        const reused = await cli(
          f,
          ['workflow', 'run', 'native', '--branch', 'credential-test', '--base', 'main'],
          env
        );
        expect(reused, reused.output + reused.error).toMatchObject({ code: 0 });
        expect(existsSync(join(worktree, 'before-count'))).toBe(true);
      }
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
  const child = Bun.spawn([process.execPath, entry], {
    cwd: f.project,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
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

  test(`${action} accepts an answer at capacity and refuses stale answers in both modes`, async () => {
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
    writeFileSync(
      join(f.project, '.archon/workflows/register.yaml'),
      'name: register\ndescription: register project\nnodes:\n  - id: ready\n    bash: echo ready\n'
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
          runAsUserId: JSON.parse(identity.output).runAsUserId,
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
    const fired = await cli(f, ['trigger', 'fire', '--config', config]);
    expect(fired, fired.output + fired.error).toMatchObject({ code: 0 });
    const disposition = resourceStartDispositionSchema.parse(
      JSON.parse(fired.output).bindings[0].disposition
    );
    if (disposition.status !== 'admitted') throw new Error('Run not admitted');
    const id = disposition.runId;
    const store = await createFileWorkflowStore({ root: join(f.home, 'store') });
    const deadline = Date.now() + 15_000;
    let run = await store.getWorkflowRun(id);
    while (run?.status !== 'paused' && Date.now() < deadline) {
      expect(run?.status, JSON.stringify(run)).not.toBeOneOf(['failed', 'cancelled']);
      await Bun.sleep(25);
      run = await store.getWorkflowRun(id);
    }
    expect(run?.status).toBe('paused');
    const attention = run && runAttention(run);
    if (attention?.kind !== 'attention') throw new Error('Run not awaiting answer');
    const args = (occurrence: string): string[] => [
      'workflow',
      action,
      id,
      ...(action === 'answer' ? ['--choose', 'approve'] : action === 'respond' ? ['retry'] : []),
      '--occurrence',
      occurrence,
    ];
    for (const flags of [
      [],
      ['--json'],
      ...(action === 'answer' ? [] : [['--detach'], ['--detach', '--json']]),
    ]) {
      const refused = await cli(f, [...args('stale'), ...flags]);
      expect(refused, refused.output + refused.error).toMatchObject({ code: 1 });
      if (flags.includes('--json')) expect(JSON.parse(refused.output)).toMatchObject({ ok: false });
      expect(refused.output + refused.error).toContain(
        `awaiting occurrence '${attention.occurrence}'`
      );
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
    const answered = await cli(f, args(attention.occurrence));
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
    const woken = await cli(f, ['workflow', 'wake', '--json']);
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
