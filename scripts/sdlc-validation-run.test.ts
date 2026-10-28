import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import { EXEC_NODE_ENVIRONMENT_NAMES } from '../packages/workflows/src/exec-environment';
import { COMPOSED_NODE } from '../packages/workflows/src/compiled-command';
import { buildNodeShellEnvironment } from '../packages/workflows/src/dag/references';
import { inputEnvKey } from '../packages/workflows/src/schemas/node-bindings';
import { getRunScratchDir } from '../packages/paths/src/run-paths';
import { scratchDir } from '../.archon/workflows/sdlc/.shared/scratch';
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
  return {
    ...(process.env as Record<string, string>),
    ARTIFACTS_DIR: artifacts,
    ARCHON_RUN_ENV_KEYS: JSON.stringify([...EXEC_NODE_ENVIRONMENT_NAMES, ...Object.keys(bindings)]),
    ...bindings,
  };
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

  it('keeps a partly unrun gate incomplete even when another group failed', () => {
    const f = checkout();
    const result = run(f, [
      { name: 'api tests', argv: sh('exit 1'), group: 'api' },
      { name: 'web tests', argv: ['archon-no-such-command-for-this-test'], group: 'web' },
    ]);
    expect(result.output?.status).toBe('incomplete');
    expect(result.output?.summary).toContain('web tests could not start');
    expect(result.output?.summary).toContain('Failed: api tests failed (exit 1).');
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

function result(bindings: { run?: unknown; classification?: unknown }): {
  exitCode: number;
  output: unknown;
} {
  const f = checkout();
  const out = Bun.spawnSync([process.execPath, join(PACK, 'result.ts')], {
    cwd: f.cwd,
    env: env(f.artifacts, {
      INPUTS_RUN: JSON.stringify(bindings.run ?? null),
      INPUTS_CLASSIFICATION: JSON.stringify(bindings.classification ?? null),
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = out.stdout.toString().trim();
  return { exitCode: out.exitCode, output: stdout === '' ? null : JSON.parse(stdout) };
}

describe("the pack's scratch directory", () => {
  it('is the run scratch directory the engine removes when the run ends', () => {
    expect(scratchDir('/artifacts', '')).toBe(getRunScratchDir('/artifacts'));
  });

  it('is the only scratch directory the pack commands name', async () => {
    const engineScratch = `$ARTIFACTS_DIR/${relative('/artifacts', getRunScratchDir('/artifacts')).split(sep).join('/')}/`;
    const sdlc = join(import.meta.dir, '..', '.archon', 'workflows', 'sdlc');
    const named: string[] = [];
    for await (const file of new Bun.Glob('*/commands/*.md').scan(sdlc)) {
      const text = readFileSync(join(sdlc, file), 'utf8');
      for (const [path] of text.matchAll(/\$\{?ARTIFACTS_DIR\}?\/\S*scratch\S*/g)) named.push(path);
    }
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(path => !path.startsWith(engineScratch))).toEqual([]);
  });
});

describe("the gate's environment", () => {
  it.each(['', 'null', '{}', '["INPUTS_DISCOVERY", 42]', 'invalid-json'])(
    'refuses a gate with an invalid run-key list: %s',
    manifest => {
      const f = checkout();
      mkdirSync(f.artifacts, { recursive: true });
      const result = Bun.spawnSync([process.execPath, join(PACK, 'run-checks.ts')], {
        cwd: f.cwd,
        env: env(f.artifacts, {
          ARCHON_RUN_ENV_KEYS: manifest,
          INPUTS_DISCOVERY: JSON.stringify({
            checks: declared([{ name: 'gate', argv: sh('touch ran') }]),
            notes: '',
          }),
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).not.toBe('');
      expect(existsSync(join(f.cwd, 'ran'))).toBe(false);
    }
  );

  it("runs the checks without the run's identity or the node's bindings", () => {
    const f = checkout();
    mkdirSync(f.artifacts, { recursive: true });
    const seen = join(f.artifacts, 'seen.json');
    const names = ['plan', 'base-branch', 'foo_bar', 'MixedCase', 'revision2'];
    const bindings = Object.fromEntries(names.map(name => [name, 'bound value']));
    const discovery = JSON.stringify({
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
    });
    const node = {
      id: 'gate',
      kind: 'exec' as const,
      runtime: 'bun' as const,
      script: 'run-checks',
      with: { ...bindings, discovery },
      [COMPOSED_NODE]: { origin: 'block', inputs: { composed: 'composed value' } },
    };
    const nodeEnv = buildNodeShellEnvironment(
      node,
      {
        workflowRun: {
          id: 'run-123',
          user_message: '',
          metadata: { inputs_values: { run: 'run value' } },
        },
        artifactsDir: f.artifacts,
        stateDir: '',
        baseBranch: 'dev',
        docsDir: '',
        nodeOutputs: new Map(),
        loopBodyScopes: [],
      },
      {
        PROJECT_SETTING: 'kept',
        INPUTS_PROJECT_SETTING: 'kept too',
        INPUTS_PLAN: 'project value shadowed by binding',
        ARCHON_RUN_ENV_KEYS: '["INPUTS_PROJECT_SETTING"]',
        INPUTS: 'project setting without the binding prefix',
        PROJECT_INPUTS_SETTING: 'project setting containing the binding prefix',
      },
      {
        artifactsDir: f.artifacts,
        stateDir: '',
        logDir: '',
        workflowId: 'run-123',
        baseBranch: 'dev',
        userMessage: '',
        loopUserInput: '',
        loopPrevOutput: '',
        rejectionReason: '',
        typedArtifactsFile: '',
        nodeExecution: null,
      }
    );
    expect(nodeEnv.INPUTS_PLAN).toBe('bound value');
    expect(JSON.parse(nodeEnv.ARCHON_RUN_ENV_KEYS ?? 'null').sort()).toEqual(
      [
        ...EXEC_NODE_ENVIRONMENT_NAMES,
        ...[...names, 'discovery', 'run', 'composed'].map(inputEnvKey),
      ].sort()
    );
    const result = Bun.spawnSync([process.execPath, join(PACK, 'run-checks.ts')], {
      cwd: f.cwd,
      env: { ...process.env, INPUTS_HOST_SETTING: 'host value', ...nodeEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const gate = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>;
    expect(gate.PROJECT_SETTING).toBe('kept');
    expect(gate.INPUTS_PROJECT_SETTING).toBe('kept too');
    expect(gate.INPUTS_HOST_SETTING).toBe('host value');
    expect(gate.INPUTS).toBe('project setting without the binding prefix');
    expect(gate.PROJECT_INPUTS_SETTING).toBe('project setting containing the binding prefix');
    for (const key of EXEC_NODE_ENVIRONMENT_NAMES) expect(gate[key]).toBeUndefined();
    expect(gate.INPUTS_DISCOVERY).toBeUndefined();
    for (const name of [...names, 'run', 'composed'])
      expect(gate[inputEnvKey(name)]).toBeUndefined();
  });
});

describe('validation result', () => {
  it('reports a gate the timeout stopped as incomplete, never green or red', () => {
    const { output } = result({});
    expect(output).toMatchObject({ green: false, red_cause: 'incomplete' });
  });

  it('derives green and incomplete from the run, and takes red causes from classify', () => {
    expect(result({ run: { status: 'green', summary: 'all passed' } }).output).toEqual({
      green: true,
      red_cause: '',
      summary: 'all passed',
    });
    expect(result({ run: { status: 'incomplete', summary: 'x could not start' } }).output).toEqual({
      green: false,
      red_cause: 'incomplete',
      summary: 'x could not start',
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
    });
  });

  it('refuses a red run that reached it unclassified', () => {
    const { exitCode, output } = result({ run: { status: 'red', summary: 'tests failed' } });
    expect(exitCode).not.toBe(0);
    expect(output).toBeNull();
  });
});
