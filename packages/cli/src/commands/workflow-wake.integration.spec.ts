import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const roots: string[] = [];
const children = new Set<Bun.Subprocess>();
afterEach(async () => {
  for (const child of children) {
    child.kill();
    await child.exited;
  }
  children.clear();
  for (const root of roots.splice(0)) await removeTempTree(root);
});
const cli = resolve(import.meta.dir, '../cli.ts');
const repo = resolve(import.meta.dir, '../../../..');
interface Fixture {
  root: string;
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
}
interface RunRow {
  id: string;
  status: string;
  metadata: string;
  conversation_id: string;
  user_id: string | null;
}
function row(f: Fixture): RunRow {
  const db = new Database(join(f.home, 'archon.db'), { readonly: true });
  try {
    const run = db
      .query<
        RunRow,
        []
      >('SELECT * FROM remote_agent_workflow_runs ORDER BY started_at DESC LIMIT 1')
      .get();
    if (!run) throw new Error('no run');
    return run;
  } finally {
    db.close();
  }
}
async function runProcess(
  f: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: f.root,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  children.delete(child);
  return { exitCode, stdout, stderr };
}
async function seed(wait: string, secondWait = ''): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'archon-cold-wake-'));
  roots.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.archon/workflows'), { recursive: true });
  const workflowPath = join(project, '.archon/workflows/cold.yaml');
  writeFileSync(
    workflowPath,
    `name: cold\ndescription: cold continuation\nprovider: claude\ninputs:\n  proof:\n    required: true\nnodes:\n  - id: first\n    wait:\n${wait}\n${secondWait}  - id: finish\n    depends_on: [${secondWait ? 'second' : 'first'}]\n    bash: echo "frozen-$INPUTS_PROOF-$WAKE_CONFIG_PROOF" >> marker\n`
  );
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    LOG_LEVEL: 'silent',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  const fixture = { root, project, home, env };
  const entry = join(root, 'seed.ts');
  const path = (p: string): string => JSON.stringify(join(repo, p));
  writeFileSync(
    entry,
    `
import { registerBuiltinProviders } from ${path('packages/providers/src/index.ts')};
import { createWorkflowDeps } from ${path('packages/core/src/workflows/store-adapter.ts')};
import { loadConfig } from ${path('packages/core/src/config/config-loader.ts')};
import { createCodebase } from ${path('packages/core/src/db/codebases.ts')};
import { getOrCreateConversation } from ${path('packages/core/src/db/conversations.ts')};
import { closeDatabase } from ${path('packages/core/src/db/connection.ts')};
import { findOrCreateUserByPlatformIdentity } from ${path('packages/core/src/db/users.ts')};
import { InProcessWorkflowEngine } from ${path('packages/workflows/src/in-process-engine.ts')};
import { prepareWorkflowSource, recordSelectedWorkflow } from ${path('packages/workflows/src/executor.ts')};
import { discoverWorkflowsWithConfig } from ${path('packages/workflows/src/workflow-discovery.ts')};
import { HeadlessPlatform } from ${path('packages/core/src/workflows/headless-platform.ts')};
import { startRunLiveOwner } from ${path('packages/core/src/services/run-live-owner.ts')};
import { setPlatformPolicies } from ${path('packages/core/src/platforms/registry.ts')};
registerBuiltinProviders();
setPlatformPolicies([]);
const cwd = ${JSON.stringify(project)};
const codebase = await createCodebase({ name: 'cold', default_cwd: cwd, kind: 'folder' });
const user = await findOrCreateUserByPlatformIdentity('cli', 'cold-operator');
const conversation = await getOrCreateConversation('cli', 'cold-fixture', codebase.id, undefined, user.id);
const deps = createWorkflowDeps();
const source = await prepareWorkflowSource(deps, { sourceRoot: cwd });
const discovery = await discoverWorkflowsWithConfig(cwd, loadConfig, source.roots);
const workflow = discovery.workflows.find(entry => entry.workflow.name === 'cold')?.workflow;
if (!workflow) throw new Error(JSON.stringify(discovery.errors));
await recordSelectedWorkflow(source.anchor.root, workflow.name);
const owner = await startRunLiveOwner(source.runId);
try {
 const result = await new InProcessWorkflowEngine(deps).submit({
  platform: new HeadlessPlatform(), conversationId: conversation.id,
  origin: { conversationId: conversation.id, userId: user.id }, cwd, workflow, userMessage: 'original request',
  options: { codebaseId: codebase.id, preparedSource: source, inputs: { proof: 'original-input' },
    runConfig: { layer: { envVars: { WAKE_CONFIG_PROOF: 'original-config' } }, source: { kind: 'cli', label: 'cold-fixture' } } }
 });
 if (!('paused' in result)) throw new Error(JSON.stringify(result));
} finally { await owner.close(); await closeDatabase(); }
`
  );
  const seeded = await runProcess(fixture, [entry]);
  expect(seeded.exitCode, seeded.stderr || seeded.stdout).toBe(0);
  expect(row(fixture).status).toBe('paused');
  writeFileSync(workflowPath, 'name: changed\nnodes:\n  - id: fail\n    bash: exit 1\n');
  return fixture;
}
function metadata(f: Fixture): {
  wait: { resumeAt: string; signaledAt?: string };
  continuation_retry_at?: string;
} {
  return JSON.parse(row(f).metadata) as ReturnType<typeof metadata>;
}
async function due(f: Fixture): Promise<void> {
  const deadline = Date.parse(metadata(f).wait.resumeAt);
  if (deadline > Date.now()) await Bun.sleep(deadline - Date.now() + 10);
}
function events(f: Fixture, type: string): number {
  const db = new Database(join(f.home, 'archon.db'), { readonly: true });
  try {
    return (
      db
        .query<
          { count: number },
          [string]
        >('SELECT COUNT(*) AS count FROM remote_agent_workflow_events WHERE event_type = ?')
        .get(type)?.count ?? 0
    );
  } finally {
    db.close();
  }
}

describe('cold CLI continuation host', () => {
  test('two fresh processes wake a one-second wait once using captured source', async () => {
    const f = await seed('      duration_ms: 1000');
    const original = row(f);
    expect(original.user_id).toBeString();
    await due(f);
    const outputs = await Promise.all([
      runProcess(f, [cli, 'workflow', 'wake', '--json']),
      runProcess(f, [cli, 'workflow', 'wake', '--json']),
    ]);
    for (const output of outputs) expect(output.exitCode, output.stderr || output.stdout).toBe(0);
    const batches = outputs.map(output => JSON.parse(output.stdout) as { accepted: number });
    expect(batches.reduce((sum, batch) => sum + batch.accepted, 0)).toBe(1);
    expect(row(f)).toMatchObject({
      id: original.id,
      status: 'completed',
      conversation_id: original.conversation_id,
      user_id: original.user_id,
    });
    expect(readFileSync(join(f.project, 'marker'), 'utf8')).toBe(
      'frozen-original-input-original-config\n'
    );
    expect(events(f, 'workflow_completed')).toBe(1);
    const again = await runProcess(f, [cli, 'workflow', 'wake', '--json']);
    expect(JSON.parse(again.stdout).accepted).toBe(0);
  }, 30_000);

  test('signals an exact event, rejects its stale occurrence, then completes the next one', async () => {
    const f = await seed(
      '      event: ready\n      deadline_ms: 60000',
      '  - id: second\n    depends_on: [first]\n    wait:\n      event: ready\n      deadline_ms: 60000\n'
    );
    const id = row(f).id;
    const first = metadata(f).wait.resumeAt;
    const signal = (resumeAt: string): ReturnType<typeof runProcess> =>
      runProcess(f, [
        cli,
        'workflow',
        'signal',
        id,
        '--event',
        'ready',
        '--resume-at',
        resumeAt,
        '--data',
        '{"answer":42}',
        '--json',
      ]);
    const a = await signal(first);
    expect(a.exitCode, a.stderr || a.stdout).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({
      ok: true,
      signaled: true,
      accepted: 1,
      outcomes: [{ status: 'paused' }],
    });
    const second = metadata(f).wait.resumeAt;
    expect(second).not.toBe(first);
    const stale = await signal(first);
    expect(stale.exitCode).toBe(1);
    expect(metadata(f).wait.signaledAt).toBeUndefined();
    expect(events(f, 'wait_signaled')).toBe(1);
    const b = await signal(second);
    expect(b.exitCode, b.stderr || b.stdout).toBe(0);
    expect(row(f).status).toBe('completed');
    expect(events(f, 'wait_signaled')).toBe(2);
    const db = new Database(join(f.home, 'archon.db'), { readonly: true });
    try {
      expect(
        db
          .query<
            { data: string },
            []
          >("SELECT data FROM remote_agent_workflow_events WHERE event_type = 'wait_signaled' LIMIT 1")
          .get()?.data
      ).toContain('42');
    } finally {
      db.close();
    }
  }, 30_000);

  test('a valid signal survives a visible container refusal without claiming', async () => {
    const f = await seed('      event: ready\n      deadline_ms: 60000');
    const db = new Database(join(f.home, 'archon.db'));
    try {
      db.run(
        "UPDATE remote_agent_workflow_runs SET metadata = json_set(metadata, '$.isolation', 'container')"
      );
    } finally {
      db.close();
    }
    const output = await runProcess(f, [
      cli,
      'workflow',
      'signal',
      row(f).id,
      '--event',
      'ready',
      '--resume-at',
      metadata(f).wait.resumeAt,
      '--json',
    ]);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      signaled: true,
      accepted: 0,
      outcomes: [{ kind: 'unavailable', reason: expect.stringContaining('container') }],
    });
    expect(row(f).status).toBe('paused');
    expect(metadata(f).wait.signaledAt).toBeString();
  }, 30_000);

  test('refuses missing paths, external origins and missing captures before claim', async () => {
    const f = await seed('      duration_ms: 1000');
    const original = row(f);
    await due(f);
    const reset = (): Database => {
      const db = new Database(join(f.home, 'archon.db'));
      db.run('UPDATE remote_agent_workflow_runs SET metadata = ?, working_path = ?', [
        original.metadata,
        f.project,
      ]);
      db.run("UPDATE remote_agent_conversations SET platform_type = 'cli'");
      return db;
    };
    let db = reset();
    db.run('UPDATE remote_agent_workflow_runs SET working_path = ?', [join(f.root, 'missing')]);
    db.close();
    let output = await runProcess(f, [cli, 'workflow', 'wake', '--json']);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      accepted: 0,
      outcomes: [{ reason: expect.stringContaining('working path') }],
    });
    expect(row(f).status).toBe('paused');
    db = reset();
    db.run("UPDATE remote_agent_conversations SET platform_type = 'telegram'");
    db.close();
    output = await runProcess(f, [cli, 'workflow', 'wake', '--json']);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      accepted: 0,
      outcomes: [{ reason: expect.stringContaining('telegram') }],
    });
    db = reset();
    db.close();
    const source = JSON.parse(original.metadata) as { workflow_source: { root: string } };
    await removeTempTree(source.workflow_source.root);
    output = await runProcess(f, [cli, 'workflow', 'wake', '--json']);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      accepted: 0,
      outcomes: [{ reason: expect.stringContaining('recorded workflow source') }],
    });
    expect(row(f).status).toBe('paused');
    expect(events(f, 'workflow_completed')).toBe(0);
  }, 30_000);

  test('watch wakes a later deadline and SIGTERM exits during idle sleep', async () => {
    const f = await seed('      duration_ms: 3000');
    const child = Bun.spawn([process.execPath, cli, 'workflow', 'wake', '--watch', '--json'], {
      cwd: f.root,
      env: f.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.add(child);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const deadline = Date.now() + 15_000;
    while (row(f).status !== 'completed' && Date.now() < deadline) await Bun.sleep(25);
    expect(row(f).status).toBe('completed');
    child.kill('SIGTERM');
    const exitCode = await child.exited;
    // Windows has no catchable SIGTERM: Bun terminates the child outright (143), so only
    // POSIX can prove the handler drains and exits cleanly.
    if (process.platform !== 'win32') expect(exitCode).toBe(0);
    children.delete(child);
    const passes = (await stdout)
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { accepted: number });
    expect(passes[0]?.accepted).toBe(0);
    expect(passes.some(pass => pass.accepted === 1)).toBe(true);
    expect(await stderr).not.toContain('fatal');
    expect(readFileSync(join(f.project, 'marker'), 'utf8')).toBe(
      'frozen-original-input-original-config\n'
    );
  }, 30_000);
});
