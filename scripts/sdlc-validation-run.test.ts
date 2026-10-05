import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';
import { NODE_CONTRACT_ENV } from '../.archon/workflows/sdlc/.shared/node-env';
import type { Discovery } from '../.archon/workflows/sdlc/validate/scripts/run-checks';

/**
 * archon-validate's runner and result scripts, run as the engine runs them: a Bun
 * subprocess in the checkout, bindings in env, the result on stdout. The timeout
 * case uses `execFile`'s own timeout, which is how the engine stops a script node.
 */
const track = trackTempRoots();
const PACK = join(import.meta.dir, '..', '.archon', 'workflows', 'sdlc', 'validate', 'scripts');
const execFileAsync = promisify(execFile);

/** A check as discover declares it; the group defaults to one shared gate. */
type Check = Omit<Discovery['checks'][number], 'group'> & { group?: string };
const declared = (checks: Check[]): Discovery['checks'] =>
  checks.map(check => ({ group: 'gate', ...check }));

function checkout(): { cwd: string; artifacts: string } {
  const root = track(mkdtempSync(join(tmpdir(), 'validation-run-')));
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  return { cwd, artifacts: join(root, 'artifacts') };
}

function env(artifacts: string, bindings: Record<string, string>): Record<string, string> {
  return { ...(process.env as Record<string, string>), ARTIFACTS_DIR: artifacts, ...bindings };
}

function run(
  f: { cwd: string; artifacts: string },
  checks: Check[]
): { exitCode: number; output: { status: string; summary: string } | null; stderr: string } {
  mkdirSync(f.artifacts, { recursive: true });
  const result = Bun.spawnSync([process.execPath, join(PACK, 'run-checks.ts')], {
    cwd: f.cwd,
    env: env(f.artifacts, {
      INPUTS_DISCOVERY: JSON.stringify({ checks: declared(checks), notes: 'test gate' }),
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

  it('runs every independent group, stopping each at its own first failure', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'api lint', argv: sh('echo "lint broke"; exit 2'), group: 'api' },
      { name: 'api tests', argv: sh('touch api-tested'), group: 'api' },
      { name: 'web tests', argv: sh('echo "web 1 failing"; exit 1'), group: 'web' },
      { name: 'cli tests', argv: sh('exit 0'), group: 'cli' },
    ]);
    expect(result.output?.status).toBe('red');
    expect(result.output?.summary).toContain('api lint failed (exit 2)');
    expect(result.output?.summary).toContain('web tests failed (exit 1)');
    expect(result.output?.summary).toContain('Passed: cli tests.');
    expect(existsSync(join(f.cwd, 'api-tested'))).toBe(false);
    const text = report(f.artifacts);
    expect(text).toContain('lint broke');
    expect(text).toContain('web 1 failing');
    expect(text).toMatch(
      /## 2\. api tests \(group: api\)\n\n`bash -c touch api-tested` never ran\./
    );
  });

  it('reports a check that could not start as incomplete, not red', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'lint', argv: sh('exit 0') },
      { name: 'tests', argv: ['archon-no-such-command-for-this-test'] },
    ]);
    expect(result.output?.status).toBe('incomplete');
    expect(result.output?.summary).toContain('tests could not start');
    expect(result.output?.summary).toContain('Passed: lint.');
  });

  it("reports a project that defines no checks as green with discover's notes", () => {
    const f = checkout();
    const result = run(f, []);
    expect(result.output).toEqual({
      status: 'green',
      summary: 'No checks defined by this project. test gate',
    });
  });

  it.skipIf(process.platform === 'win32')(
    "on the node's timeout, stops the whole check process tree and records the stop",
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
            checks: declared(checks),
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

describe("the gate's environment", () => {
  it("names exactly the engine's exec-node contract", () => {
    expect([...NODE_CONTRACT_ENV].sort()).toEqual([...EXEC_NODE_ENVIRONMENT_NAMES].sort());
  });

  it("runs the checks without the run's identity or the node's bindings", () => {
    const f = checkout();
    mkdirSync(f.artifacts, { recursive: true });
    const seen = join(f.artifacts, 'seen.json');
    const result = Bun.spawnSync([process.execPath, join(PACK, 'run-checks.ts')], {
      cwd: f.cwd,
      env: env(f.artifacts, {
        WORKFLOW_ID: 'run-123',
        PROJECT_SETTING: 'kept',
        INPUTS_DISCOVERY: JSON.stringify({
          checks: [
            {
              name: 'env',
              argv: [
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))`,
              ],
              group: 'gate',
            },
          ],
          notes: '',
        }),
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const gate = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>;
    expect(gate.PROJECT_SETTING).toBe('kept');
    expect(gate.WORKFLOW_ID).toBeUndefined();
    expect(gate.ARTIFACTS_DIR).toBeUndefined();
    expect(gate.INPUTS_DISCOVERY).toBeUndefined();
  });
});

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
