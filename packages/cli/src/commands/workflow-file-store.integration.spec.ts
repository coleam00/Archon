import {
  resourceStartDispositionSchema,
  type ResourceStartDisposition,
} from '@archon/workflows/schemas/resource-start';
import { z } from '@hono/zod-openapi';
import { workflowEventRowSchema } from '@archon/workflows/schemas/workflow-event';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
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
function fixture(config = 'store: files\n'): Fixture {
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
interactive: true
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
  };
  return { root, project, home, entry, trap, env };
}
async function cli(
  f: ReturnType<typeof fixture>,
  args: string[],
  env = f.env
): Promise<{ output: string; error: string; code: number }> {
  const child = Bun.spawn([process.execPath, f.entry, ...args], {
    cwd: f.project,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, error, code };
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
  const started = await cli(f, [
    'workflow',
    'run',
    'portable',
    '--folder',
    '--no-worktree',
    '--quiet',
  ]);
  expect(started.error).not.toContain('SQL open trap');
  expect(started, started.output + started.error).toMatchObject({ code: 0 });
  const listed = await cli(f, ['workflow', 'runs', '--json']);
  expect(listed.code).toBe(0);
  const rows = JSON.parse(listed.output).runs;
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('paused');
  const id = rows[0].id;
  const approved = await cli(f, ['workflow', 'approve', id, 'Ship it', '--json']);
  expect(approved.code).toBe(0);
  expect(JSON.parse(approved.output)).toMatchObject({ action: 'approve', resumable: true });
  const resumed = await cli(f, ['workflow', 'resume', id]);
  expect(resumed.error).not.toContain('SQL open trap');
  expect(resumed.code).toBe(0);
  const get = await cli(f, ['workflow', 'get', id, '--json', '--events']);
  expect(get.code).toBe(0);
  expect(JSON.parse(get.output)).toMatchObject({ id, status: 'completed' });
  const final = await cli(f, ['workflow', 'runs', '--json']);
  expect(JSON.parse(final.output).runs).toMatchObject([{ id, status: 'completed' }]);
  // Cleanup also prunes state revisions; the file store holds none, so it must not fail.
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
test('SQL-only commands fail explicitly under files', async () => {
  const f = fixture();
  for (const args of [
    ['ai', 'show'],
    ['state', 'get', 'notes'],
  ]) {
    const result = await cli(f, args);
    expect(result.code).toBe(1);
    expect(result.output + result.error).toContain('store: database');
  }
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
  const queued = await fire(queueConfig);
  expect(queued).toMatchObject({ status: 'queued', blocker: { kind: 'run', id: first.runId } });
  const skipped = await fire(skipConfig);
  expect(skipped).toMatchObject({
    status: 'skipped',
    blocker: { kind: 'request', id: queued.requestId },
  });
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
