// @archon-test-isolated
/**
 * A run that failed before its checkout was prepared, and a run that was abandoned, are
 * refused by `workflow resume` with a line that starts it again; abandon prints it too. The line is run as printed, through `sh -c`, with an
 * `archon` on PATH that is this checkout's CLI: real git, real SQLite, the CLI in its own
 * process. The workflow name starts with `@` and its source path holds `'`, `$` and a
 * space, the cases a quoted command got wrong.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

// Pauses at its only node, so the run's row holds its inputs without spawning a node.
const PROBE = `name: "@restart-probe"
description: restart probe
mutates_checkout: false
inputs:
  note: { required: true }
nodes:
  - id: hold
    wait: { attention: hold, form: approval }
`;

const NOTE = `it's $HOME and "quoted"`;

interface Row {
  id: string;
  workflow_name: string;
  status: string;
  working_path: string | null;
  adopted_from_run_id: string | null;
  item_id: string | null;
  metadata: string;
}

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A git repo, a definitions source holding the probe, a scratch home and `archon` on PATH. */
async function setUp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-restart-')));
  tempRoots.push(root);
  const repo = join(root, 'repo');
  const source = join(root, "O'Brien $pack src");
  const archonHome = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(source, '.archon', 'workflows'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, 'docs', 'readme.md'), 'repo\n');
  writeFileSync(join(source, '.archon', 'workflows', 'probe.yaml'), PROBE);
  writeFileSync(join(bin, 'archon'), `#!/bin/sh\nexec '${process.execPath}' '${CLI_PATH}' "$@"\n`);
  chmodSync(join(bin, 'archon'), 0o755);
  const env = {
    WORKFLOW_ID: '',
    ARCHON_NODE_EXECUTION: '',
    ARCHON_TRIGGER_HOST: '',
    DATABASE_URL: '',
    ARCHON_HOME: archonHome,
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_APP_ID: '',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'],
  ]) {
    const result = await run(['git', ...args], repo, env);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  const rows = (): Row[] => {
    const database = new Database(join(archonHome, 'archon.db'), { readonly: true });
    try {
      return database
        .query<Row, []>(
          'SELECT id, workflow_name, status, working_path, adopted_from_run_id, item_id, metadata FROM remote_agent_workflow_runs ORDER BY started_at'
        )
        .all();
    } finally {
      database.close();
    }
  };

  return { repo, source, archonHome, env, rows };
}

/** Start the probe, which ends paused at its only node with no live owner. */
async function startProbe(
  { repo, source, env }: Awaited<ReturnType<typeof setUp>>,
  extra: string[] = []
) {
  const first = await run(
    [
      'archon',
      'workflow',
      'run',
      '@restart-probe',
      'the message',
      '--no-worktree',
      '--workflow-source',
      source,
      '--input',
      `note=${NOTE}`,
      ...extra,
    ],
    repo,
    env
  );
  expect(first.exitCode, first.stderr).toBe(0);
}

test.skipIf(process.platform === 'win32')(
  'the line resume prints for a run with no checkout starts it again from its record, pasted into sh',
  async () => {
    const setup = await setUp();
    const { repo, source, archonHome, env, rows } = setup;
    await startProbe(setup);
    const [started] = rows();
    if (!started) throw new Error('The first run left no row');

    // What a start whose worktree could not be prepared leaves: failed, with no working path.
    const database = new Database(join(archonHome, 'archon.db'));
    database
      .query(
        "UPDATE remote_agent_workflow_runs SET status = 'failed', working_path = NULL WHERE id = ?"
      )
      .run(started.id);
    database.close();

    const resume = await run(['archon', 'workflow', 'resume', started.id], repo, env);
    expect(resume.exitCode).not.toBe(0);
    const line = /Start it again with: (.+)$/m.exec(resume.stderr + resume.stdout)?.[1]?.trim();
    expect(line).toBe(`archon workflow run --supersedes ${started.id}`);

    const restarted = await run(['sh', '-c', line ?? ''], repo, env);
    expect(restarted.exitCode, restarted.stderr + restarted.stdout).toBe(0);

    const next = rows().find(row => row.id !== started.id);
    expect(next).toMatchObject({
      workflow_name: '@restart-probe',
      status: 'paused',
      adopted_from_run_id: started.id,
    });
    const metadata = JSON.parse(next?.metadata ?? '{}') as {
      inputs?: Record<string, unknown>;
      continuation?: unknown;
      workflow_source?: { definitions?: unknown };
    };
    expect(metadata.inputs?.note).toBe(NOTE);
    expect(metadata.continuation).toEqual({ mode: 'supersede' });
    expect(metadata.workflow_source?.definitions).toEqual({ from: 'source', root: source });
    // The restart got the checkout the first start skipped: a worktree of its own.
    expect(next?.working_path).not.toBe(repo);
    expect(next?.working_path).toBeString();
  },
  120_000
);

test.skipIf(process.platform === 'win32')(
  'abandon and the resume refusal of a cancelled run print the line that starts it again on its item',
  async () => {
    const setup = await setUp();
    const { repo, env, rows } = setup;
    await startProbe(setup, ['--item', 'issue-7']);
    const [started] = rows();
    if (!started) throw new Error('The first run left no row');
    expect(started.item_id).toBeString();

    const restartLine = /with: (archon workflow run --supersedes \S+)$/m;
    const abandon = await run(['archon', 'workflow', 'abandon', started.id], repo, env);
    expect(abandon.exitCode, abandon.stderr).toBe(0);
    const line = restartLine.exec(abandon.stdout)?.[1];
    expect(line).toBe(`archon workflow run --supersedes ${started.id}`);

    const resume = await run(['archon', 'workflow', 'resume', started.id], repo, env);
    expect(resume.exitCode).not.toBe(0);
    expect(restartLine.exec(resume.stderr + resume.stdout)?.[1]).toBe(line);

    const restarted = await run(['sh', '-c', line ?? ''], repo, env);
    expect(restarted.exitCode, restarted.stderr + restarted.stdout).toBe(0);
    const next = rows().find(row => row.id !== started.id);
    expect(next).toMatchObject({
      workflow_name: '@restart-probe',
      status: 'paused',
      adopted_from_run_id: started.id,
      item_id: started.item_id,
    });
    const metadata = JSON.parse(next?.metadata ?? '{}') as { inputs?: Record<string, unknown> };
    expect(metadata.inputs?.note).toBe(NOTE);
  },
  120_000
);
