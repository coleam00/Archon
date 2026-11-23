// @archon-test-isolated
/**
 * A run that failed before its checkout was prepared is refused by `workflow resume` with
 * a line that starts it again. The line is run as printed, through `sh -c`, with an
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

test.skipIf(process.platform === 'win32')(
  'the line resume prints for a run with no checkout starts it again from its record, pasted into sh',
  async () => {
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
    writeFileSync(
      join(bin, 'archon'),
      `#!/bin/sh\nexec '${process.execPath}' '${CLI_PATH}' "$@"\n`
    );
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
            'SELECT id, workflow_name, status, working_path, adopted_from_run_id, metadata FROM remote_agent_workflow_runs ORDER BY started_at'
          )
          .all();
      } finally {
        database.close();
      }
    };

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
      ],
      repo,
      env
    );
    expect(first.exitCode, first.stderr).toBe(0);
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
