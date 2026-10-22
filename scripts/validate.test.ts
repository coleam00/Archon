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
      'merge-sweep-contract',
      'type-check',
      'lint',
      'mock-modules',
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
    ]);
  });

  test('the sweep conformance test runs in defaults and the unconditional static CI step', () => {
    const check = selectChecks([]).find(check => check.id === 'merge-sweep-contract');
    expect(check?.commands).toEqual([
      ['bun', 'run', 'test', '.archon/scripts/__tests__/merge-sweep-contract.test.ts'],
    ]);
    const job = readWorkflow().jobs.static;
    expect(
      (job.steps ?? [])
        .filter(step => step.if === undefined)
        .flatMap(step => stepChecks(job, step.run ?? ''))
    ).toContain('merge-sweep-contract');
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
    os: string;
    check: string;
    part: string;
  }
  interface WorkflowJob {
    strategy?: { matrix: { os?: string[]; include?: MatrixLeg[] } };
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
    const { test: testJob } = readWorkflow().jobs;
    const legs = testJob.strategy?.matrix.include ?? [];
    const workspaceChecks = ['cli-tests', 'core-tests', 'package-tests'];
    const oses = ['ubuntu-latest', 'windows-latest'];
    for (const os of oses) {
      for (const check of workspaceChecks) {
        const parts = legs.filter(leg => leg.os === os && leg.check === check).map(leg => leg.part);
        // One part count per shard, so an empty list (the shard dropped from this OS) fails too.
        const counts = [...new Set(parts.map(part => Number(part.split('/')[1])))];
        const count = counts[0] ?? 0;
        expect({ os, check, counts, parts: parts.sort() }).toEqual({
          os,
          check,
          counts: [Math.max(count, 1)],
          parts: Array.from(
            { length: count },
            (_, index) => `${String(index + 1)}/${String(count)}`
          ),
        });
      }
    }
    expect(
      legs.filter(leg => !oses.includes(leg.os) || !workspaceChecks.includes(leg.check))
    ).toEqual([]);

    // One validate step per OS, each running the leg's own check and part.
    const validateSteps = (testJob.steps ?? []).filter(step =>
      (step.run ?? '').includes('bun run validate')
    );
    expect(validateSteps.map(step => step.if).sort()).toEqual([
      "runner.os == 'Linux'",
      "runner.os == 'Windows'",
    ]);
    for (const step of validateSteps) {
      expect(step.run).toContain('bun run validate --only ${{ matrix.check }}');
      expect(step.env?.ARCHON_TEST_PART).toBe('${{ matrix.part }}');
    }
  });

  test('the scripts shard runs on every OS', () => {
    const job = readWorkflow().jobs['test-scripts'];
    for (const os of ['Linux', 'Windows']) {
      const checks = (job.steps ?? [])
        .filter(step => step.if === `runner.os == '${os}'`)
        .flatMap(step => stepChecks(job, step.run ?? ''));
      expect({ os, runsScripts: checks.includes('script-tests') }).toEqual({
        os,
        runsScripts: true,
      });
    }
    expect(job.strategy?.matrix.os).toEqual(['ubuntu-latest', 'windows-latest']);
  });

  test('pack tests run in CI only on a dispatch that asks for them', () => {
    // An unconditional `--only pack-tests` would put the slow pack tests back on every PR.
    const workflow = Bun.YAML.parse(
      readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8')
    ) as {
      on: { workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } };
      jobs: Record<string, { steps?: { if?: string; run?: string }[] }>;
    };
    expect(workflow.on.workflow_dispatch.inputs['pack-tests']).toMatchObject({
      type: 'boolean',
      default: false,
    });
    const packSteps = Object.values(workflow.jobs)
      .flatMap(job => job.steps ?? [])
      .filter(step =>
        [...(step.run ?? '').matchAll(/bun run validate --only (\S+)/g)].some(match =>
          match[1].split(',').includes('pack-tests')
        )
      );
    expect(packSteps.length).toBeGreaterThan(0);
    for (const step of packSteps) expect(step.if ?? '').toContain('inputs.pack-tests');
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
