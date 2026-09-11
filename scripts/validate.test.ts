/**
 * CI selects checks by id (`bun run validate --only workflow-fixtures`), so a mistyped or removed id
 * must fail loudly. Selecting nothing and exiting 0 would leave a job that reports green while
 * running no check at all.
 */
import { describe, expect, test } from 'bun:test';
import { VALIDATE_CHECKS, parseOnly, selectChecks } from './validate';

describe('validate check selection', () => {
  test('no selection runs every check in declaration order', () => {
    expect(selectChecks([]).map(check => check.id)).toEqual(VALIDATE_CHECKS.map(check => check.id));
  });

  test('a selection runs in declaration order, not argument order', () => {
    expect(selectChecks(['tests', 'lint']).map(check => check.id)).toEqual(['lint', 'tests']);
  });

  test('an unknown id fails instead of selecting nothing', () => {
    expect(() => selectChecks(['docs_build'])).toThrow(/Unknown check id: docs_build/);
  });

  test('check ids are unique', () => {
    const ids = VALIDATE_CHECKS.map(check => check.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe('validate argument parsing', () => {
  test('--only accepts repetition and comma-separated ids', () => {
    expect(parseOnly(['--only', 'lint,format', '--only=tests'])).toEqual([
      'lint',
      'format',
      'tests',
    ]);
  });

  test('a stray argument fails instead of being forwarded to a check', () => {
    expect(() => parseOnly(['--fix'])).toThrow(/unsupported argument: --fix/);
  });

  test('--only without a value fails', () => {
    expect(() => parseOnly(['--only'])).toThrow(/--only needs a check id/);
  });
});
