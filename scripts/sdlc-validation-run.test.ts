import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';

/**
 * archon-validate's runner and result scripts, run as the engine runs them: a Bun
 * subprocess in the checkout, bindings in env, the result on stdout. The timeout
 * case uses `execFile`'s own timeout, which is how the engine stops a script node.
 */
const track = trackTempRoots();
const PACK = join(import.meta.dir, '..', '.archon', 'workflows', 'sdlc', 'validate', 'scripts');
const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  argv: string[];
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function checkout(): { cwd: string; artifacts: string } {
  const root = track(mkdtempSync(join(tmpdir(), 'validation-run-')));
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, '.archon', 'tracked'), { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, '.archon', 'tracked', 'config.yaml'), 'tracked: true\n');
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  mkdirSync(join(cwd, '.archon', 'injected'));
  writeFileSync(join(cwd, '.archon', 'injected', 'workflow.yaml'), 'injected\n');
  return { cwd, artifacts: join(root, 'artifacts') };
}

function env(artifacts: string, bindings: Record<string, string>): Record<string, string> {
  return { ...(process.env as Record<string, string>), ARTIFACTS_DIR: artifacts, ...bindings };
}

function run(
  f: { cwd: string; artifacts: string },
  checks: Check[],
  quarantine: string[] = []
): { exitCode: number; output: { status: string; summary: string } | null; stderr: string } {
  mkdirSync(f.artifacts, { recursive: true });
  const result = Bun.spawnSync([process.execPath, join(PACK, 'run-checks.ts')], {
    cwd: f.cwd,
    env: env(f.artifacts, {
      INPUTS_DISCOVERY: JSON.stringify({ checks, quarantine, notes: 'test gate' }),
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString().trim();
  return {
    exitCode: result.exitCode,
    output: stdout === '' ? null : (JSON.parse(stdout) as { status: string; summary: string }),
    stderr: result.stderr.toString(),
  };
}

function report(artifacts: string): string {
  return readFileSync(join(artifacts, 'validation.md'), 'utf8');
}

const sh = (script: string): string[] => ['bash', '-c', script];

describe('run-checks', () => {
  it('reports green only when every declared check exits 0', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'types', argv: sh('exit 0') },
      { name: 'tests', argv: sh('exit 0') },
    ]);
    expect(result.output).toEqual({
      status: 'green',
      summary: 'Every check passed: types, tests.',
    });
    expect(report(f.artifacts)).toContain('`bash -c exit 0` passed (exit 0)');
  });

  it('stops at the first failure, records its exit status and output tail, and never runs later checks', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'types', argv: sh('exit 0') },
      { name: 'tests', argv: sh('echo "expected 2, got 3"; exit 3') },
      { name: 'build', argv: sh('touch built') },
    ]);
    expect(result.output?.status).toBe('red');
    expect(result.output?.summary).toContain('tests failed (exit 3)');
    const text = report(f.artifacts);
    expect(text).toContain('failed (exit 3)');
    expect(text).toContain('expected 2, got 3');
    expect(text).toMatch(/## 3\. build\n\n`bash -c touch built` never ran\./);
    expect(existsSync(join(f.cwd, 'built'))).toBe(false);
  });

  it('reports a check that could not start as incomplete, not red', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'lint', argv: sh('exit 0') },
      { name: 'tests', argv: ['archon-no-such-command-for-this-test'] },
    ]);
    expect(result.output?.status).toBe('incomplete');
    expect(result.output?.summary).toContain('tests could not start');
    expect(result.output?.summary).toContain('Passed first: lint.');
  });

  it("reports a project that defines no checks as green with discover's notes", () => {
    const f = checkout();
    const result = run(f, []);
    expect(result.output).toEqual({
      status: 'green',
      summary: 'No checks defined by this project. test gate',
    });
  });

  it('moves quarantined run scaffolding aside while the checks run and restores it', () => {
    const f = checkout();
    const result = run(
      f,
      [{ name: 'clean tree', argv: sh('test ! -e .archon/injected && test -e .archon/tracked') }],
      ['.archon/injected']
    );
    expect(result.output?.status).toBe('green');
    expect(readFileSync(join(f.cwd, '.archon', 'injected', 'workflow.yaml'), 'utf8')).toBe(
      'injected\n'
    );
    expect(report(f.artifacts)).toContain('- `.archon/injected`');
  });

  it('refuses to quarantine a tracked path or one outside .archon/, before moving anything', () => {
    for (const path of ['.archon/tracked', 'README.md', '.archon/../x', '/etc']) {
      const f = checkout();
      const result = run(f, [{ name: 'gate', argv: sh('touch ran') }], ['.archon/injected', path]);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toBeNull();
      expect(result.stderr).toContain('Refusing to quarantine');
      expect(existsSync(join(f.cwd, '.archon', 'injected', 'workflow.yaml'))).toBe(true);
      expect(existsSync(join(f.cwd, 'ran'))).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')(
    "on the node's timeout, stops the whole check process tree, restores the quarantine and records the stop",
    async () => {
      const f = checkout();
      mkdirSync(f.artifacts, { recursive: true });
      const pidFile = join(f.artifacts, 'grandchild.pid');
      // The check starts a grandchild, as `bun run <script>` does, then waits on it.
      const checks: Check[] = [
        { name: 'types', argv: sh('exit 0') },
        { name: 'slow gate', argv: sh(`sleep 600 & echo $! > '${pidFile}'; wait`) },
        { name: 'build', argv: sh('touch built') },
      ];
      const stopped = execFileAsync(process.execPath, [join(PACK, 'run-checks.ts')], {
        cwd: f.cwd,
        timeout: 3000,
        env: env(f.artifacts, {
          INPUTS_DISCOVERY: JSON.stringify({
            checks,
            quarantine: ['.archon/injected'],
            notes: '',
          }),
        }),
      });
      const rejection = (await stopped.then(
        () => null,
        (error: unknown) => error
      )) as { killed?: boolean; code?: unknown; stdout?: string } | null;
      // The engine's timeout test: killed by execFile, no exit code. Anything else
      // would read to the engine as a finished or failed node rather than a timeout.
      expect(rejection?.killed).toBe(true);
      expect(rejection?.code).toBeNull();
      expect(rejection?.stdout).toBe('');

      const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
      const alive = (): boolean => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(20);
      expect(alive()).toBe(false);

      expect(existsSync(join(f.cwd, '.archon', 'injected', 'workflow.yaml'))).toBe(true);
      expect(existsSync(join(f.cwd, 'built'))).toBe(false);
      const text = report(f.artifacts);
      expect(text).toContain("did not finish: the node's time limit stopped it (SIGTERM)");
      expect(text).toMatch(/## 3\. build\n\n`bash -c touch built` never ran\./);
    }
  );
});

function result(bindings: { comparison?: unknown; run?: unknown; classification?: unknown }): {
  exitCode: number;
  output: unknown;
} {
  const f = checkout();
  const out = Bun.spawnSync([process.execPath, join(PACK, 'result.ts')], {
    cwd: f.cwd,
    env: env(f.artifacts, {
      INPUTS_COMPARISON: JSON.stringify(bindings.comparison ?? null),
      INPUTS_RUN: JSON.stringify(bindings.run ?? null),
      INPUTS_CLASSIFICATION: JSON.stringify(bindings.classification ?? null),
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = out.stdout.toString().trim();
  return { exitCode: out.exitCode, output: stdout === '' ? null : JSON.parse(stdout) };
}

describe('validation result', () => {
  it('reports a gate the timeout stopped as incomplete, never green or red', () => {
    const { output } = result({});
    expect(output).toMatchObject({ green: false, red_cause: 'incomplete', evidence: null });
  });

  it('derives green and incomplete from the run, and takes red causes from classify', () => {
    expect(result({ run: { status: 'green', summary: 'all passed' } }).output).toEqual({
      green: true,
      red_cause: '',
      summary: 'all passed',
      evidence: null,
    });
    expect(result({ run: { status: 'incomplete', summary: 'x could not start' } }).output).toEqual({
      green: false,
      red_cause: 'incomplete',
      summary: 'x could not start',
      evidence: null,
    });
    expect(
      result({
        run: { status: 'red', summary: 'tests failed' },
        classification: { red_cause: 'inherited', summary: 'fails on the base too' },
      }).output
    ).toEqual({
      green: false,
      red_cause: 'inherited',
      summary: 'fails on the base too',
      evidence: null,
    });
  });

  it('refuses a red run that reached it unclassified', () => {
    const { exitCode, output } = result({ run: { status: 'red', summary: 'tests failed' } });
    expect(exitCode).not.toBe(0);
    expect(output).toBeNull();
  });

  it('passes the comparison verdict through unchanged', () => {
    const comparison = { green: false, red_cause: 'interaction', summary: 's', evidence: null };
    expect(result({ comparison }).output).toEqual(comparison);
  });
});
