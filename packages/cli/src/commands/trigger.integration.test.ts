import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const root = await mkdtemp(join(tmpdir(), 'archon-cli-trigger-'));
const previousHome = process.env.ARCHON_HOME;
const previousDatabase = process.env.DATABASE_URL;
const home = join(root, 'home');
const project = join(root, 'project');
process.env.ARCHON_HOME = home;
process.env.DATABASE_URL = '';
const { createCodebase } = await import('@archon/core/db/codebases');
const { closeDatabase, getDatabase } = await import('@archon/core/db/connection');
await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
await writeFile(
  join(project, '.archon', 'config.yaml'),
  'defaults:\n  loadDefaultWorkflows: false\n'
);
await writeFile(
  join(project, '.archon', 'workflows', 'tick.yaml'),
  'name: tick\ndescription: CLI trigger\nworktree:\n  enabled: false\nnodes:\n  - id: actual-cli-node\n    bash: echo cli-trigger-output\n'
);
const codebase = await createCodebase({
  name: 'cli-trigger',
  default_cwd: project,
  kind: 'folder',
});
const repo = join(root, 'repo');
await mkdir(repo);
for (const args of [
  ['init', '-q', '-b', 'dev', repo],
  [
    '-C',
    repo,
    '-c',
    'user.name=Trigger Test',
    '-c',
    'user.email=trigger@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ],
  ['-C', repo, 'remote', 'add', 'origin', repo],
]) {
  const git = Bun.spawnSync(['git', ...args]);
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
}
const target = await createCodebase({
  name: 'trigger-repo',
  default_cwd: repo,
  default_branch: 'dev',
});
await writeFile(
  join(project, '.archon', 'workflows', 'isolated.yaml'),
  'name: isolated\ndescription: Isolated trigger fixture\nnodes:\n  - id: isolated-node\n    bash: echo isolated\n'
);
await writeFile(
  join(home, 'triggers.json'),
  JSON.stringify([
    {
      id: 'regression',
      kind: 'schedule',
      scheduleId: 'daily',
      workflow: 'tick',
      codebaseId: codebase.id,
      sourceRoot: project,
      source: 'project',
      overlap: 'skip',
    },
    {
      id: 'isolated',
      kind: 'schedule',
      scheduleId: 'daily',
      workflow: 'isolated',
      codebaseId: target.id,
      sourceRoot: project,
      source: 'project',
      overlap: 'skip',
    },
  ])
);
const eventFile = join(root, 'event.json');
await writeFile(
  eventFile,
  JSON.stringify({
    kind: 'schedule',
    scheduleId: 'daily',
    eventId: '2026-09-08',
    tick: '2026-09-08T12:00:00Z',
  })
);

afterAll(async () => {
  await closeDatabase();
  await removeTempTree(root);
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
});

async function invoke(triggerId = 'regression') {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'cli.ts'),
      'workflow',
      'trigger',
      triggerId,
      eventFile,
      '--json',
    ],
    {
      cwd: root,
      env: { ...process.env, ARCHON_HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`CLI exited ${String(exit)}: ${stdout}\n${stderr}`);
  return JSON.parse(stdout) as { disposition: string; runId: string; status: string };
}

test('actual CLI processes concurrently deliver one tick and publish one native node', async () => {
  const [first, second] = await Promise.all([invoke(), invoke()]);
  expect(first.runId).toBe(second.runId);
  expect([first.disposition, second.disposition].sort()).toEqual(['accepted', 'duplicate']);
  const nodes = await getDatabase().query<{ step_name: string }>(
    "SELECT step_name FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'node_started'",
    [first.runId]
  );
  expect(nodes.rows.map(row => row.step_name)).toEqual(['actual-cli-node']);
  const { getWorkflowRun } = await import('@archon/core/db/workflows');
  expect((await getWorkflowRun(first.runId))?.status).toBe('completed');
});

test('trigger startup isolates the registered repo while executing a separate shared source', async () => {
  const result = await invoke('isolated');
  expect(result.status).toBe('completed');
  const { getWorkflowRun } = await import('@archon/core/db/workflows');
  const run = await getWorkflowRun(result.runId);
  expect(run?.working_path).not.toBe(repo);
  expect(run?.working_path?.startsWith(home)).toBe(true);
  expect(run?.metadata.workflow_source).toMatchObject({ origin: project });
});
