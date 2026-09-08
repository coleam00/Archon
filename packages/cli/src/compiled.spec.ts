import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  pluginMetadataSchema,
  resolveResultSchema,
  publicResultSchemas,
  PINNED_MERGE_OP,
  RESOLVE_OP,
  CHECKS_STATE_OP,
} from '@archon/forge';

// Run explicitly after build:binaries. The ordinary CLI suite needs no compiled artifact.
const input = process.env.ARCHON_TEST_BINARY;
if (!input) throw new Error('Set ARCHON_TEST_BINARY to the production build output');
const source = resolve(input);
let root: string;
let executable: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon standalone '));
  const bin = join(root, 'bin');
  await mkdir(bin);
  executable = join(bin, process.platform === 'win32' ? 'archon.exe' : 'archon');
  // Copy only the executable, never adjacent chunks or repository files.
  await copyFile(source, executable);
  await chmod(executable, 0o755);
  env = {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    TEMP: root,
    TMP: root,
    HOME: root,
    USERPROFILE: root,
    ARCHON_HOME: join(root, 'home'),
    ARCHON_TELEMETRY_DISABLED: '1',
    ARCHON_EXECUTABLE: '',
    ARCHON_EXECUTABLE_ARGS: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    DATABASE_URL: '',
    LOG_LEVEL: 'silent',
  };
  await mkdir(join(root, '.archon'));
  await mkdir(join(root, 'home'));
});

afterAll(async () => {
  if (root) await removeTempTree(root);
});

async function invoke(
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
  request?: unknown
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    stdin: request === undefined ? 'ignore' : new Blob([JSON.stringify(request)]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe('production executable moved outside the repository', () => {
  test('loads help and the real plugin metadata', async () => {
    const help = await invoke(['forge', '--help']);
    expect(help.code).toBe(0);
    expect(JSON.parse(help.stdout)).toHaveProperty('usage');
    const result = await invoke(['forge', '__github', 'metadata']);
    expect(result.code).toBe(0);
    expect(pluginMetadataSchema.parse(JSON.parse(result.stdout))).toMatchObject({
      name: 'github',
      hosts: ['github.com'],
      capabilities: [
        RESOLVE_OP,
        CHECKS_STATE_OP,
        PINNED_MERGE_OP,
        ...Object.keys(publicResultSchemas),
      ],
    });
  });

  test('resolves through executable discovery, handshake, operation and audit', async () => {
    for (const args of [
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/fixture/standalone.git'],
    ]) {
      const git = Bun.spawn(['git', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      const [code, , stderr] = await Promise.all([
        git.exited,
        new Response(git.stdout).text(),
        new Response(git.stderr).text(),
      ]);
      if (code) throw new Error(stderr);
    }
    const result = await invoke(['forge', 'resolve', '--json']);
    expect(result.code).toBe(0);
    expect(resolveResultSchema.parse(JSON.parse(result.stdout))).toMatchObject({
      forge: 'github',
      repo: { host: 'github.com', path: 'fixture/standalone' },
      plugin: { name: 'github' },
    });
    expect(result.stderr).toContain('"type":"forge_op"');
    expect(result.stderr).toContain('"outcome":"ok"');
  });

  test('loads operation validation and the GitHub checks chunk on demand', async () => {
    const resolve = await invoke(['forge', '__github', 'op', 'resolve'], {}, { repo: null });
    expect(resolve.code).toBe(1);
    expect(JSON.parse(resolve.stdout)).toMatchObject({ kind: 'invalid_request' });
    const checks = await invoke(
      ['forge', '__github', 'op', 'checks.state'],
      {},
      {
        ref: { repo: { host: 'github.com', path: 'fixture/standalone' }, number: 42 },
      }
    );
    expect(checks.code).toBe(1);
    expect(JSON.parse(checks.stdout)).toMatchObject({ kind: 'no_credential' });
  });

  test('loads every public and pinned operation chunk on demand', async () => {
    for (const op of [PINNED_MERGE_OP, ...Object.keys(publicResultSchemas)]) {
      const result = await invoke(['forge', '__github', 'op', op], {}, {});
      expect({ op, code: result.code, result: JSON.parse(result.stdout) }).toEqual({
        op,
        code: 1,
        result: expect.objectContaining({ kind: 'invalid_request' }),
      });
    }
  });

  test('dispatches qualified checks to a configured executable and retains its audit', async () => {
    const config = join(root, 'forge-fixture.json');
    await writeFile(
      config,
      JSON.stringify({
        hosts: {
          'fixture.test': {
            plugin: 'well-behaved',
            command: process.execPath,
            args: [
              resolve(import.meta.dir, '../../forge/src/dispatch/fixtures/well-behaved-plugin.ts'),
              '{}',
            ],
          },
        },
      })
    );
    const checks = await invoke(
      [
        'forge',
        'checks',
        '--config',
        config,
        '--ref',
        JSON.stringify({
          repo: { host: 'fixture.test', path: 'owner/other' },
          number: 42,
        }),
        '--json',
      ],
      { EXAMPLE_TOKEN: 'fixture-only-token' }
    );
    expect(checks.code).toBe(0);
    expect(JSON.parse(checks.stdout)).toMatchObject({ state: 'green', head_sha: 'a'.repeat(40) });
    expect(checks.stderr).toContain('fixture.test/owner/other#42');
    expect(checks.stdout + checks.stderr).not.toContain('fixture-only-token');
  });

  test('preserves env boot and does not restore scrubbed credentials on re-entry', async () => {
    await writeFile(join(root, '.env'), 'GH_TOKEN=ambient-must-be-stripped\n');
    await writeFile(join(root, '.archon', '.env'), 'GH_TOKEN=owned-test-token\n');
    const boot = await invoke(['forge', '--help'], { ARCHON_VERBOSE_BOOT: '1' });
    expect(boot.code).toBe(0);
    expect(boot.stderr).toContain('loaded 1 keys');
    const checks = await invoke(
      [
        'forge',
        'checks',
        '--ref',
        JSON.stringify({
          repo: { host: 'github.com', path: 'fixture/standalone' },
          number: 42,
        }),
        '--json',
      ],
      { ARCHON_EXECUTABLE: executable }
    );
    expect(checks.code).toBe(1);
    expect(JSON.parse(checks.stdout)).toMatchObject({ kind: 'no_credential' });
    expect(checks.stderr).toContain('"op":"checks.state"');
    expect(checks.stdout + checks.stderr).not.toContain('owned-test-token');
    await writeFile(join(root, '.env'), '');
    await writeFile(join(root, '.archon', '.env'), '');
  });

  test('loads non-forge routes, embedded version and bundled workflows', async () => {
    const version = await invoke(['version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain('Build: binary');
    const workflows = await invoke(['workflow', 'list', '--json']);
    expect(workflows.code).toBe(0);
    expect(workflows.stdout).toContain('archon');
    expect(() => {
      JSON.parse(workflows.stdout);
    }).not.toThrow();
    const missing = await invoke([
      'workflow',
      'get',
      '00000000-0000-0000-0000-000000000000',
      '--json',
    ]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: 'not_found' });
  }, 30_000);

  test('loads doctor checks without a repository or configured services', async () => {
    const doctor = await invoke(['doctor']);
    // Missing optional tools or credentials are legitimate doctor findings.
    expect([0, 1]).toContain(doctor.code);
    expect(doctor.stdout).toContain('verifying your setup');
    expect(doctor.stdout).toContain('Bundled');
    expect(doctor.stdout + doctor.stderr).not.toContain('unknown: check threw');
  }, 60_000);

  test('executes a workflow, re-enters forge and reads the persisted run and transcript', async () => {
    const workflows = join(root, '.archon', 'workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(
      join(workflows, 'compiled-reentry.yaml'),
      "name: compiled-reentry\ndescription: Verify compiled workflow re-entry and audit retention\nnodes:\n  - id: resolve\n    runtime: bun\n    script: |\n      const argv = [process.env.ARCHON_EXECUTABLE, ...JSON.parse(process.env.ARCHON_EXECUTABLE_ARGS), 'forge', 'resolve', '--json'];\n      const child = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' });\n      process.exit(await child.exited);\n"
    );
    const run = await invoke(['workflow', 'run', 'compiled-reentry', '--no-worktree', '--json']);
    if (run.code) throw new Error(run.stdout + run.stderr);
    const list = await invoke(['workflow', 'runs', '--all', '--json']);
    expect(list.code).toBe(0);
    const runs = JSON.parse(list.stdout) as { runs: { id: string }[] };
    expect(runs.runs).toHaveLength(1);
    const get = await invoke(['workflow', 'get', runs.runs[0].id, '--json']);
    expect(get.code).toBe(0);
    const record = JSON.parse(get.stdout) as { status: string; transcript_path: string };
    expect(record.status).toBe('completed');
    const transcript = await readFile(record.transcript_path, 'utf8');
    expect(transcript).toContain('exec_output');
    expect(transcript).toContain('forge_op');
    expect(transcript).toContain('fixture/standalone');
  }, 60_000);

  test('drains large JSON and reports a closed stdout pipe as failure', async () => {
    const workflows = join(root, '.archon', 'workflows');
    await mkdir(workflows, { recursive: true });
    const description = 'standalone pipe fixture '.repeat(20_000).trim();
    await writeFile(
      join(workflows, 'pipe.yaml'),
      `name: pipe\ndescription: ${description}\nnodes:\n  - id: noop\n    bash: echo ok\n`
    );
    const args = ['workflow', 'list', '--full', '--json'];
    const complete = await invoke(args);
    expect(complete.code).toBe(0);
    expect(complete.stdout).toContain(description);
    expect(() => {
      JSON.parse(complete.stdout);
    }).not.toThrow();
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.once('data', () => child.stdout.destroy());
    child.stderr.resume();
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    expect(code).toBe(1);
  }, 30_000);
});
