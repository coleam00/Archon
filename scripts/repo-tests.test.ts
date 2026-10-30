/**
 * `planRequestedRuns` decides where `bun run test <path>` actually runs. The behaviour
 * worth protecting is that an argument naming no owner produces no run at all: answering
 * a mistyped path with a full green suite is the bug this runner exists to remove.
 */
import { describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { archonCliInvocation } from '@archon/paths/cli-command';
import {
  planRequestedRuns,
  planShard,
  rootTestEnv,
  planStepCommand,
  ROOT_TEST_PLAN,
  type RootTestStep,
} from './repo-tests';

const REPO_ROOT = join(import.meta.dir, '..');
const fromRoot = (path: string): string => join(REPO_ROOT, path);

describe('planRequestedRuns', () => {
  test('places a path inside a package with that package', () => {
    const runs = planRequestedRuns([fromRoot('packages/paths/src/skills.test.ts')]);

    expect(runs).toHaveLength(1);
    expect(runs[0].owner.label).toBe('packages/paths');
    expect(runs[0].owner.cwd).toBe(fromRoot('packages/paths'));
    expect(runs[0].args).toEqual(['src/skills.test.ts']);
  });

  test('reads a relative path against the repository root', () => {
    const relativePath = relative(REPO_ROOT, fromRoot('packages/paths/src/skills.test.ts'));

    expect(planRequestedRuns([relativePath])[0].args).toEqual(['src/skills.test.ts']);
  });

  test('keeps a root-owned path at the repository root', () => {
    const runs = planRequestedRuns([fromRoot('scripts/test-inventory.test.ts')]);

    expect(runs).toHaveLength(1);
    expect(runs[0].owner.cwd).toBe(REPO_ROOT);
    expect(runs[0].args).toEqual(['./scripts/test-inventory.test.ts']);
  });

  test.each(['.archon/scripts', '.archon/scripts/', 'scripts', 'scripts/'])(
    'routes the root-owned directory %s',
    selector => {
      expect(planRequestedRuns([selector])).toEqual([
        {
          owner: { label: 'the repository root', cwd: REPO_ROOT },
          args: [`./${selector.replace(/\/$/, '')}`],
        },
      ]);
    }
  );

  test.each([
    'scriptsx',
    'scripts-other/',
    'scripts-other/example.test.ts',
    '.archon/scriptsx',
    '.archon/scripts-other/',
    '.archon/scripts-other/example.test.ts',
  ])('rejects the sibling-prefix selector %s', selector => {
    expect(planRequestedRuns([selector])).toEqual([]);
  });

  test('plans one run per owner, in the order the owners were named', () => {
    const runs = planRequestedRuns([
      fromRoot('packages/isolation/src/resolver.test.ts'),
      fromRoot('packages/paths/src/skills.test.ts'),
      fromRoot('packages/isolation/src/pr-state.test.ts'),
    ]);

    expect(runs.map((run): string => run.owner.label)).toEqual([
      'packages/isolation',
      'packages/paths',
    ]);
    expect(runs[0].args).toEqual(['src/resolver.test.ts', 'src/pr-state.test.ts']);
    expect(runs[1].args).toEqual(['src/skills.test.ts']);
  });

  test('forwards flags and substring filters to the owner the paths named', () => {
    const runs = planRequestedRuns([
      '--bail',
      '-t',
      'resolveSkillDirectories',
      fromRoot('packages/paths/src/skills.test.ts'),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['--bail', '-t', 'resolveSkillDirectories', 'src/skills.test.ts']);
  });

  test('forwards an unplaced argument to every owner the paths named', () => {
    const runs = planRequestedRuns([
      '--bail',
      fromRoot('packages/isolation/src/resolver.test.ts'),
      fromRoot('packages/paths/src/skills.test.ts'),
    ]);

    expect(runs.map((run): string => run.owner.label)).toEqual([
      'packages/isolation',
      'packages/paths',
    ]);
    expect(runs[0].args).toEqual(['--bail', 'src/resolver.test.ts']);
    expect(runs[1].args).toEqual(['--bail', 'src/skills.test.ts']);
  });

  for (const option of ['-t', '--test-name-pattern']) {
    test.each(['scripts', '.archon/scripts'])(
      `forwards ${option} value %s unchanged to root and package owners`,
      pattern => {
        const runs = planRequestedRuns([
          'scripts/pack-scripts-validation.test.ts',
          option,
          pattern,
          'packages/paths/src/archon-paths.test.ts',
        ]);

        expect(runs.map(run => run.args)).toEqual([
          ['./scripts/pack-scripts-validation.test.ts', option, pattern],
          [option, pattern, 'src/archon-paths.test.ts'],
        ]);
        expect(planRequestedRuns([option, pattern])).toEqual([]);
      }
    );
  }

  test('plans no run when no argument names an owner', () => {
    expect(planRequestedRuns(['some/where/nope.test.ts'])).toEqual([]);
    expect(planRequestedRuns(['logger'])).toEqual([]);
    expect(planRequestedRuns([fromRoot('packages/not-a-workspace/src/x.test.ts')])).toEqual([]);
    expect(planRequestedRuns([fromRoot('../outside-the-repo.test.ts')])).toEqual([]);
    // A bare package directory reaches the same outcome down a different branch: the
    // package exists, but there is no selector after it for `bun test` to run.
    expect(planRequestedRuns([fromRoot('packages/paths')])).toEqual([]);
  });
});

describe('planShard', () => {
  test.each(['cli', 'core', 'packages', 'scripts', 'pack'] as const)(
    '--plan %s selects that shard',
    shard => {
      expect(planShard(['--plan', shard])).toBe(shard);
    }
  );

  test.each([[['--plan', 'nope']], [['--plan']], [['--plan', 'scripts', 'scripts/']]])(
    'rejects the malformed request %j',
    requested => {
      expect(() => planShard(requested)).toThrow(
        'Usage: bun run test --plan <cli|core|packages|scripts|pack>'
      );
    }
  );

  test.each([[[]], [['scripts/']], [['-t', '--plan']]])('leaves %j to the router', requested => {
    expect(planShard(requested)).toBeUndefined();
  });
});

describe('rootTestEnv', () => {
  test("names this checkout's CLI for pack tests, even when a host CLI is inherited", () => {
    expect(JSON.parse(rootTestEnv({}).ARCHON_CLI_COMMAND ?? '')).toEqual(archonCliInvocation());
    expect(
      JSON.parse(rootTestEnv({ ARCHON_CLI_COMMAND: '["archon"]' }).ARCHON_CLI_COMMAND ?? '')
    ).toEqual(archonCliInvocation());
  });
});

describe('planStepCommand', () => {
  test('the workspaces step leaves out exactly the packages that run alone', () => {
    const steps: readonly RootTestStep[] = ROOT_TEST_PLAN;
    const solo = steps.flatMap(step => (step.kind === 'workspace' ? [step.package] : []));
    expect(solo.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (step.kind === 'workspace') {
        expect(planStepCommand(step)).toEqual(['bun', '--filter', step.package, 'test']);
      }
      if (step.kind === 'workspaces') {
        expect(planStepCommand(step)).toEqual([
          'bun',
          ...solo.flatMap(name => ['--filter', `!${name}`]),
          '--parallel',
          'test',
        ]);
      }
    }
  });
});

/**
 * `planRequestedRuns` above decides where a run goes. These cover what the script does with
 * that plan, which is the half that enforces the invariant rather than describing it.
 *
 * Each assertion fails on a one-line regression: returning 0 from the zero-owner branch
 * answers a mistyped path with success, which is the defect this runner exists to remove,
 * and dropping the `code !== 0` check turns a failing suite into a green run.
 *
 * `runPlan`'s loop shares that propagation shape, but exercising it would run every suite
 * in the repository. It stays uncovered here by choice, not by oversight.
 */
describe('repo-tests exit codes', () => {
  const SCRIPT = fromRoot('scripts/repo-tests.ts');
  const invoke = (args: string[]): { exitCode: number | null; stderr: string; stdout: string } => {
    const result = Bun.spawnSync(['bun', SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  };

  test('exits non-zero and names what it accepts when no argument routes', () => {
    const { exitCode, stderr } = invoke(['some/where/nope.test.ts']);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('No argument named a test path this runner can place');
  });

  test('exits non-zero with the usage for an unknown plan shard', () => {
    const { exitCode, stderr } = invoke(['--plan', 'nope']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage: bun run test --plan <cli|core|packages|scripts|pack>');
  });

  test('propagates a failing run instead of reporting success', () => {
    // A real file so the argument routes, plus a filter `bun test` cannot match, so the
    // child exits non-zero and the runner has a real failure to carry back.
    const { exitCode } = invoke([
      fromRoot('packages/paths/src/skills.test.ts'),
      '-t',
      'no-such-test-name-exists',
    ]);

    expect(exitCode).not.toBe(0);
  });

  test('exits 0 when the routed run passes', () => {
    const { exitCode, stdout } = invoke([fromRoot('packages/paths/src/skills.test.ts')]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('◀ @archon/paths ./src/skills.test.ts');
  });

  test('bun run test .archon/scripts/ executes the directory tests', () => {
    // `bun test` exits non-zero when `-t` matches nothing it collected, so a zero exit
    // proves the directory selector reached a test inside it. The filter keeps the run to
    // one cheap test instead of the whole directory, and the exit code reads the same
    // whether or not Bun quiets its console output for an agent caller.
    const { exitCode } = Bun.spawnSync(
      ['bun', 'run', 'test', '.archon/scripts/', '-t', 'a blocked item closes nothing'],
      { cwd: REPO_ROOT, stdout: 'ignore', stderr: 'ignore' }
    );

    expect(exitCode).toBe(0);
  });
});
