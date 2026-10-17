import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();
const cli = join(import.meta.dir, 'fixtures', 'workflow-cli-without-title.ts');
const agentShellCli = join(import.meta.dir, 'fixtures', 'workflow-cli-with-agent-shell.ts');
test('real bash/script nodes commit state with run attribution; CLI conflicts and mismatch refuse writes', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-runtime-')));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon', 'workflows', 'ledger.yaml'),
    `name: ledger
description: Commit durable state from real exec nodes
worktree:
  enabled: false
nodes:
  - id: commit-script
    runtime: bun
    script: |
      const command = JSON.parse(process.env.ARCHON_CLI_COMMAND);
      const child = Bun.spawn([...command, 'state', 'patch', 'review/ledger'], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
      child.stdin.write(JSON.stringify({ops:[{op:'append', path:'/seen', value:process.env.WORKFLOW_ID}]}));
      child.stdin.end();
      if (await child.exited !== 0) throw new Error('State commit failed');
  - id: commit-bash
    depends_on: [commit-script]
    bash: |
      bun -e 'const command = JSON.parse(process.env.ARCHON_CLI_COMMAND); const child = Bun.spawn([...command, "state", "patch", "review/ledger"], {stdin:"pipe",stdout:"inherit",stderr:"inherit"}); child.stdin.write(JSON.stringify({ops:[{op:"set",path:"/bash",value:true}]})); child.stdin.end(); process.exit(await child.exited);'
`
  );
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    WORKFLOW_ID: '',
    ARCHON_NODE_EXECUTION: '',
    ARCHON_TELEMETRY_DISABLED: '1',
  };
  const run = async (
    args: string[],
    input = '',
    overrides: NodeJS.ProcessEnv = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: project,
      env: { ...env, ...overrides },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(input);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const workflow = await run(['workflow', 'run', 'ledger', '--folder']);
  expect(workflow.code, workflow.stdout + workflow.stderr).toBe(0);
  const db = new Database(join(home, 'archon.db'), { readonly: true });
  let rows: { revision: number; writer_run_id: string; writer_node_path: string; value: string }[];
  let runId: string;
  try {
    rows = db
      .query<
        { revision: number; writer_run_id: string; writer_node_path: string; value: string },
        []
      >(
        'SELECT revision, writer_run_id, writer_node_path, value FROM remote_agent_state_revisions ORDER BY revision'
      )
      .all();
    const recorded = db
      .query<{ id: string; status: string }, []>(
        'SELECT id, status FROM remote_agent_workflow_runs'
      )
      .get();
    expect(recorded?.status).toBe('completed');
    if (!recorded) throw new Error('Run was not recorded');
    runId = recorded.id;
  } finally {
    db.close();
  }
  expect(rows.map(row => row.revision)).toEqual([1, 2]);
  expect(rows.map(row => row.writer_node_path)).toEqual(['commit-script', 'commit-bash']);
  expect(rows.every(row => row.writer_run_id === runId)).toBe(true);
  expect(JSON.parse(rows[1].value)).toEqual({ seen: [runId], bash: true });
  const gets = await run(['state', 'get', 'review/ledger']);
  expect(gets.code, gets.stderr).toBe(0);
  expect(JSON.parse(gets.stdout)).toMatchObject({ revision: 2, value: { seen: [runId] } });
  const puts = await Promise.all(
    [0, 1].map(value =>
      run(['state', 'put', 'review/ledger', '--if-revision', '2'], JSON.stringify({ value }))
    )
  );
  expect(puts.map(result => result.code).sort()).toEqual([0, 3]);
  const conflict = puts.find(result => result.code === 3);
  if (!conflict) throw new Error('Missing CAS loser');
  expect(JSON.parse(conflict.stdout)).toMatchObject({ ok: false, code: 3 });
  const mismatch = await run(
    ['state', 'patch', 'review/ledger'],
    '{"ops":[{"op":"set","path":"/wrong","value":true}]}',
    { WORKFLOW_ID: '00000000-0000-4000-8000-000000000001', ARCHON_NODE_EXECUTION: '{}' }
  );
  expect(mismatch.code).toBe(5);
  expect(JSON.parse(mismatch.stdout)).toMatchObject({
    error: expect.stringContaining('different store'),
    code: 5,
  });
  const oversized = await run(
    ['state', 'put', 'review/ledger', '--if-revision', '3'],
    JSON.stringify('x'.repeat(65536))
  );
  expect(oversized.code).toBe(4);
  const log = await run(['state', 'log', 'review/ledger']);
  expect(JSON.parse(log.stdout)).toMatchObject({
    revisions: [
      { revision: 3, writer: { kind: 'surface', via: 'cli' } },
      { revision: 2 },
      { revision: 1 },
    ],
  });
}, 30_000);

test("an agent's shell write records its run and node in the state log", async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-agent-')));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon', 'workflows', 'notes.yaml'),
    `name: notes
description: An agent keeps its own notes in state
provider: claude
worktree:
  enabled: false
nodes:
  - id: keep-notes
    prompt: Record that you ran.
`
  );
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    WORKFLOW_ID: '',
    ARCHON_NODE_EXECUTION: '',
    ARCHON_TELEMETRY_DISABLED: '1',
  };
  const run = async (fixture: string, args: string[]): Promise<{ code: number; out: string }> => {
    const child = Bun.spawn([process.execPath, fixture, ...args], {
      cwd: project,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out: stdout + stderr };
  };
  const workflow = await run(agentShellCli, ['workflow', 'run', 'notes', '--folder']);
  expect(workflow.code, workflow.out).toBe(0);
  const db = new Database(join(home, 'archon.db'), { readonly: true });
  let runId: string | undefined;
  try {
    runId = db.query<{ id: string }, []>('SELECT id FROM remote_agent_workflow_runs').get()?.id;
  } finally {
    db.close();
  }
  const log = await run(cli, ['state', 'log', 'agent/notes']);
  expect(log.code, log.out).toBe(0);
  expect(JSON.parse(log.out)).toMatchObject({
    revisions: [
      {
        revision: 1,
        value: { noted: true },
        writer: { kind: 'run', runId, nodePath: 'keep-notes' },
      },
    ],
  });
}, 30_000);

test('an operator write auto-registers an unregistered checkout under its workflow project key', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-checkout-')));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(project);
  const initialized = Bun.spawnSync(['git', 'init', '-q', project], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
  const child = Bun.spawn([process.execPath, cli, 'state', 'put', 'ledger', '--if-revision', '0'], {
    cwd: project,
    env: {
      ...process.env,
      ARCHON_HOME: home,
      DATABASE_URL: '',
      WORKFLOW_ID: '',
      ARCHON_NODE_EXECUTION: '',
      ARCHON_TELEMETRY_DISABLED: '1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write('{}');
  child.stdin.end();
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, output + errors).toBe(0);
  expect(JSON.parse(output)).toMatchObject({
    revision: 1,
    writer: { kind: 'surface', via: 'cli' },
  });
  const db = new Database(join(home, 'archon.db'), { readonly: true });
  try {
    expect(
      db
        .query<{ project_key: string }, []>('SELECT project_key FROM remote_agent_state_revisions')
        .get()?.project_key
    ).toBe('_local/project');
    expect(
      db.query<{ name: string }, []>('SELECT name FROM remote_agent_codebases').get()?.name
    ).toBe('project');
  } finally {
    db.close();
  }
});
