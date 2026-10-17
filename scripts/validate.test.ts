/**
 * CI selects checks by id (`bun run validate --only workflow-fixtures`), so a mistyped or removed id
 * must fail loudly. Selecting nothing and exiting 0 would leave a job that reports green while
 * running no check at all.
 */
import { trackTempRoots } from '@archon/paths/test-utils';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
      'format',
      'installer',
      'package-tests',
      'script-tests',
    ]);
    expect(selectChecks(['workflow-fixtures', 'format']).map(check => check.id)).toEqual([
      'format',
      'workflow-fixtures',
    ]);
  });

  test('generated-files retains each required freshness check in order', () => {
    expect(selectChecks(['generated-files'])[0].commands).toEqual([
      ['bun', 'run', 'check:bundled'],
      ['bun', 'run', 'check:pi-vendor-map'],
      ['bun', 'run', 'check:capability-matrix'],
      ['bun', 'run', 'check:provider-contract-schema'],
      ['bun', 'run', 'check:chat-contract-schema'],
      ['bun', 'run', 'check:api-types'],
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

  test('every check is selected by a CI job', () => {
    // CI is the full validation, so a check no job selects runs nowhere.
    const workflow = Bun.YAML.parse(
      readFileSync(resolve(import.meta.dir, '../.github/workflows/test.yml'), 'utf8')
    ) as { jobs: Record<string, { steps?: { run?: string }[] }> };
    const selected = new Set(
      Object.values(workflow.jobs)
        .flatMap(job => job.steps ?? [])
        .flatMap(step => [...(step.run ?? '').matchAll(/bun run validate --only (\S+)/g)])
        .flatMap(match => match[1].split(','))
    );
    expect(VALIDATE_CHECKS.map(check => check.id).filter(id => !selected.has(id))).toEqual([]);
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
