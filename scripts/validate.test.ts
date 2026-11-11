/**
 * CI selects checks by id (`bun run validate --only workflow-fixtures`), so a mistyped or removed id
 * must fail loudly. Selecting nothing and exiting 0 would leave a job that reports green while
 * running no check at all.
 */
import { trackTempRoots } from '@archon/paths/test-utils';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT_TEST_PLAN } from './repo-tests';
import { VALIDATE_CHECKS, parseOnly, selectChecks, runCheckCommands } from './validate';

const track = trackTempRoots();

describe('validate check selection', () => {
  test('defaults include formatting and omit fixtures', () => {
    expect(selectChecks([]).map(check => check.id)).toEqual([
      'cli-import-boundary',
      'package-edges',
      'generated-files',
      'type-check',
      'lint',
      'ratchet',
      'format',
      'installer',
      'package-tests',
      'cli-tests',
      'core-tests',
      'script-tests',
    ]);
    expect(selectChecks(['workflow-fixtures', 'format']).map(check => check.id)).toEqual([
      'format',
      'workflow-fixtures',
    ]);
  });

  test('generated-files retains each required freshness check in order', () => {
    expect(selectChecks(['generated-files'])[0].commands).toEqual([
      ['bun', 'run', 'check:pi-vendor-map'],
      ['bun', 'run', 'check:capability-matrix'],
      ['bun', 'run', 'check:provider-contract-schema'],
      ['bun', 'run', 'check:chat-contract-schema'],
      ['bun', 'run', 'check:api-types'],
      ['bun', 'run', 'check:workflow-output-types'],
      ['bun', 'run', 'check:script-api-types'],
    ]);
  });

  test('a selection runs in declaration order, not argument order', () => {
    expect(selectChecks(['script-tests', 'lint']).map(check => check.id)).toEqual([
      'lint',
      'script-tests',
    ]);
  });

  test('an unknown id fails instead of selecting nothing', () => {
    expect(() => selectChecks(['docs_build'])).toThrow(/Unknown check id: docs_build/);
  });

  interface MatrixLeg {
    check: string;
    part: string;
  }
  interface WorkflowJob {
    'runs-on'?: string;
    strategy?: { matrix: { include?: MatrixLeg[] } };
    steps?: { if?: string; run?: string; env?: Record<string, string> }[];
  }
  const readWorkflow = (): { jobs: Record<string, WorkflowJob> } =>
    Bun.YAML.parse(
      readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8')
    ) as { jobs: Record<string, WorkflowJob> };
  /** The check ids a step selects; `${{ matrix.check }}` stands for every leg's check. */
  const stepChecks = (job: WorkflowJob, run: string): string[] =>
    [...run.matchAll(/bun run validate --only (\S+)/g)].flatMap(match =>
      match[1] === '${{'
        ? (job.strategy?.matrix.include ?? []).map(leg => leg.check)
        : match[1].split(',')
    );

  test('every check is selected by a CI job', () => {
    const selected = new Set(
      Object.values(readWorkflow().jobs).flatMap(job =>
        (job.steps ?? []).flatMap(step => stepChecks(job, step.run ?? ''))
      )
    );
    expect(VALIDATE_CHECKS.map(check => check.id).filter(id => !selected.has(id))).toEqual([]);
  });

  test('on each OS the test legs run every part of every workspace shard', () => {
    // A missing leg, or a part list such as 1/3 and 2/3 without 3/3, would leave some test
    // groups unrun on that OS while every leg reports green.
    // Each OS has its own job: `test` on Linux, `test-windows` on Windows.
    const workspaceChecks = ['cli-tests', 'core-tests', 'package-tests'];
    const { jobs } = readWorkflow();
    for (const [id, runsOn] of [
      ['test', 'ubuntu-latest'],
      ['test-windows', 'windows-latest'],
    ]) {
      const job = jobs[id];
      expect({ id, runsOn: job['runs-on'] }).toEqual({ id, runsOn });
      const legs = job.strategy?.matrix.include ?? [];
      for (const check of workspaceChecks) {
        const parts = legs.filter(leg => leg.check === check).map(leg => leg.part);
        // One part count per shard, so an empty list (the shard dropped from this OS) fails too.
        const counts = [...new Set(parts.map(part => Number(part.split('/')[1])))];
        const count = counts[0] ?? 0;
        expect({ id, check, counts, parts: parts.sort() }).toEqual({
          id,
          check,
          counts: [Math.max(count, 1)],
          parts: Array.from(
            { length: count },
            (_, index) => `${String(index + 1)}/${String(count)}`
          ),
        });
      }
      expect(legs.filter(leg => !workspaceChecks.includes(leg.check))).toEqual([]);

      // One validate step, running the leg's own check and part.
      const validateSteps = (job.steps ?? []).filter(step =>
        (step.run ?? '').includes('bun run validate')
      );
      expect(validateSteps).toHaveLength(1);
      expect(validateSteps[0].run).toContain('bun run validate --only ${{ matrix.check }}');
      expect(validateSteps[0].env?.ARCHON_TEST_PART).toBe('${{ matrix.part }}');
    }
  });

  test('the scripts shard runs on every OS', () => {
    const { jobs } = readWorkflow();
    for (const [id, runsOn] of [
      ['test-scripts', 'ubuntu-latest'],
      ['test-scripts-windows', 'windows-latest'],
    ]) {
      const job = jobs[id];
      const checks = (job.steps ?? []).flatMap(step => stepChecks(job, step.run ?? ''));
      expect({ id, runsOn: job['runs-on'], runsScripts: checks.includes('script-tests') }).toEqual({
        id,
        runsOn,
        runsScripts: true,
      });
    }
  });

  test.each([
    ['pack-tests', 'run-pack-tests'],
    ['workflow-fixtures', 'run-pack-fixtures'],
  ])('%s runs in CI only when the %s decision selects it', (check, output) => {
    // An unconditional `--only <check>` would put the slow pack checks back on every PR.
    const workflow = Bun.YAML.parse(
      readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8')
    ) as { jobs: Record<string, { steps?: { if?: string; run?: string }[] }> };
    const steps = Object.values(workflow.jobs)
      .flatMap(job => job.steps ?? [])
      .filter(step =>
        [...(step.run ?? '').matchAll(/bun run validate --only (\S+)/g)].some(match =>
          match[1].split(',').includes(check)
        )
      );
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.if ?? '').toContain(`needs.changes.outputs.${output} == 'true'`);
    }
  });

  test('the checks run every shard of the test plan and name no other', () => {
    const planned = VALIDATE_CHECKS.flatMap(check => check.commands).flatMap(command =>
      command[3] === '--plan' ? [command[4]] : []
    );
    expect(new Set(planned)).toEqual(new Set(ROOT_TEST_PLAN.map(step => step.shard)));
  });

  test('check ids are unique', () => {
    const ids = VALIDATE_CHECKS.map(check => check.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe('validate argument parsing', () => {
  test('--only accepts repetition and comma-separated ids', () => {
    expect(parseOnly(['--only', 'lint,format', '--only=script-tests'])).toEqual([
      'lint',
      'format',
      'script-tests',
    ]);
  });

  test('a stray argument fails instead of being forwarded to a check', () => {
    expect(() => parseOnly(['--fix'])).toThrow(/unsupported argument: --fix/);
  });

  test('--only without a value fails', () => {
    expect(() => parseOnly(['--only'])).toThrow(/--only needs a check id/);
  });
});

describe('grouped check execution', () => {
  test('runs commands in order and stops at the first failure', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = track(mkdtempSync(join(tmpdir(), 'validate-commands-')));
    const append = (value: string): readonly [string, ...string[]] => [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync('order', '${value}');`,
    ];
    expect(await runCheckCommands([append('a'), append('b')], root)).toBe(0);
    expect(readFileSync(join(root, 'order'), 'utf8')).toBe('ab');
    expect(
      await runCheckCommands(
        [append('c'), [process.execPath, '-e', 'process.exit(23)'], append('d')],
        root
      )
    ).toBe(23);
    expect(readFileSync(join(root, 'order'), 'utf8')).toBe('abc');
  });
});
