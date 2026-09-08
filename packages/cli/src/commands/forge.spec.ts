import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import { archonCliLaunchEnv } from '@archon/paths/cli-launch';
const exec = promisify(execFile);
const track = trackTempRoots();
const cli = resolve(import.meta.dir, '../cli.ts');
const plugin = resolve(
  import.meta.dir,
  '../../../forge/src/dispatch/fixtures/well-behaved-plugin.ts'
);
async function fixture(
  remote?: string
): Promise<{ root: string; home: string; env: NodeJS.ProcessEnv }> {
  const root = track(await mkdtemp(join(tmpdir(), 'forge CLI space ')));
  const home = join(root, 'home');
  await mkdir(home);
  // Only remote-reading scenarios need a repository. Sample hooks add fixture
  // I/O to the real CLI's time budget without exercising any forge behavior.
  if (remote) {
    await exec('git', ['init', '-q', '--template=', root]);
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
  }
  await writeFile(
    join(home, 'forge.json'),
    JSON.stringify({
      hosts: {
        'fixture.test': {
          plugin: 'well-behaved',
          command: process.execPath,
          args: [plugin, '{}'],
        },
      },
    })
  );
  const env = {
    ...process.env,
    ...archonCliLaunchEnv(),
    ARCHON_HOME: home,
    ARCHON_TELEMETRY_DISABLED: '1',
    EXAMPLE_TOKEN: 'test-only-token',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  return { root, home, env };
}
async function invoke(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env,
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
describe('forge CLI real subprocess', () => {
  it('resolves a qualified identity through the configured interpreter', async () => {
    const f = await fixture('https://fixture.test/owner/repo.git');
    const resolution = await invoke(f.root, f.env, ['forge', 'resolve', '--json']);
    expect(resolution.code).toBe(0);
    const repo = (JSON.parse(resolution.stdout) as { repo: unknown }).repo;
    expect(repo).toEqual({ host: 'fixture.test', path: 'owner/repo' });
    expect(resolution.stderr).toContain('"op":"resolve"');
    expect(resolution.stdout + resolution.stderr).not.toContain('test-only-token');
  });
  it('checks a qualified identity through the configured interpreter with separate audit output', async () => {
    const f = await fixture();
    const result = await invoke(f.root, f.env, [
      'forge',
      'checks',
      '--ref',
      JSON.stringify({ repo: { host: 'fixture.test', path: 'owner/repo' }, number: 42 }),
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'green', head_sha: 'a'.repeat(40) });
    expect(result.stderr).toContain('"op":"checks.state"');
    expect(result.stderr).toContain('fixture.test/owner/repo#42');
    expect(result.stdout + result.stderr).not.toContain('test-only-token');
  });
  it('builtin GitHub uses the executable handshake and resolve protocol', async () => {
    const f = await fixture('git@github.com:owner/repo.git');
    const result = await invoke(f.root, f.env, ['forge', 'resolve', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      forge: 'github',
      repo: { host: 'github.com', path: 'owner/repo' },
    });
  });
  it('missing GitHub credentials stay missing across workflow re-entry even with a repo env file', async () => {
    const f = await fixture();
    await mkdir(join(f.root, '.archon'));
    await writeFile(join(f.root, '.archon/.env'), 'GH_TOKEN=must-not-restore\n');
    const result = await invoke(f.root, f.env, [
      'forge',
      'checks',
      '--ref',
      JSON.stringify({ repo: { host: 'github.com', path: 'owner/repo' }, number: 42 }),
      '--json',
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'no_credential' });
    expect(result.stdout + result.stderr).not.toContain('must-not-restore');
  });
  it('rejects malformed refs without echoing their contents', async () => {
    const f = await fixture();
    const result = await invoke(f.root, f.env, [
      'forge',
      'checks',
      '--ref',
      'private-secret-value',
      '--json',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('private-secret-value');
  });
  it('executes the real deliver probe with the recorded number despite a different cwd remote', async () => {
    const f = await fixture('https://unrelated.test/other/repo');
    const script = resolve(
      import.meta.dir,
      '../../../../.archon/workflows/sdlc/deliver/scripts/check-ci.py'
    );
    const child = Bun.spawn(['uv', 'run', 'python', script], {
      cwd: f.root,
      env: {
        ...f.env,
        INPUTS_REF: JSON.stringify({
          repo: { host: 'fixture.test', path: 'owner/repo' },
          number: 42,
        }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: 'concluded' });
    expect(stderr).toContain('fixture.test/owner/repo#42');
    expect(stderr).not.toContain('unrelated.test');
  });
  it('injects source launch argv and retains forge operations in the actual workflow transcript', async () => {
    const f = await fixture();
    const workflows = join(f.root, '.archon/workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(
      join(workflows, 'forge-proof.yaml'),
      "name: forge-proof\ndescription: Verify engine forge transcript integration\nnodes:\n  - id: read\n    runtime: bun\n    script: |\n      const argv = [process.env.ARCHON_EXECUTABLE, ...JSON.parse(process.env.ARCHON_EXECUTABLE_ARGS), 'forge', 'resolve', '--json'];\n      const child = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' });\n      process.exit(await child.exited);\n"
    );
    const result = await invoke(
      f.root,
      { ...f.env, ARCHON_EXECUTABLE: '', ARCHON_EXECUTABLE_ARGS: '' },
      ['workflow', 'run', 'forge-proof', '--folder', '--json']
    );
    if (result.code !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.code).toBe(0);
    const files = await readdir(f.home, { recursive: true });
    const transcripts = files.filter(file => file.endsWith('.jsonl') && file.includes('logs'));
    let evidence = '';
    for (const file of transcripts) evidence += await readFile(join(f.home, file), 'utf8');
    expect(evidence).toContain('exec_output');
    expect(evidence).toContain('forge_op');
    expect(evidence).toContain('resolve');
    expect(evidence).not.toContain('test-only-token');
  }, 60000);
});
