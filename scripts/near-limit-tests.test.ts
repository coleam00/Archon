import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS, trackTempRoots } from '@archon/paths/test-utils';
import { bunTestCommand, bunTestEnv } from './bun-test-command';
import { nearLimit, reportTimes, testLimits } from './near-limit-tests';

const track = trackTempRoots();

describe('testLimits', () => {
  test('reads each form a test call gives its limit, by the line of its name', () => {
    const source = [
      "import { testTimeout } from '@archon/paths/test-utils';",
      'const SLOW = 45_000;',
      "test('literal', () => {}, 90_000);",
      "it('raised small budget', () => {}, testTimeout(18_000));",
      "test('raised large budget', () => {}, testTimeout(SLOW));",
      "test('constant', () => {}, SLOW);",
      "test('options', () => {}, { timeout: 30_000 });",
      "test('default', () => {});",
      "test.each([1, 2])('row %s', () => {}, 60_000);",
      "test.skip('skipped', () => {}, 25_000);",
      "test('unread', () => {}, budgetFor('x'));",
      "test('quoted key', () => {}, { 'timeout': 5_000 });",
      "describe('inner', () => { const SLOW = 1_000; test('shadowed', () => {}, SLOW); });",
      'let changing = 1_000;',
      "test('let binding', () => {}, changing);",
      "test('spread options', () => {}, { ...shared });",
      'const opts = { timeout: 60_000 };',
      "test('options by name', () => {}, opts);",
      "test('later spread', () => {}, { timeout: 60_000, ...{ timeout: 1_000 } });",
      "test('later key wins', () => {}, { timeout: 60_000, timeout: 1_000 });",
      "test('a', () => {}, 1_000); test('b', () => {}, 60_000);",
      "test('same limits', () => {}, 1_000); test('same', () => {}, 1_000);",
      "describe('local helper', () => { const testTimeout = (ms: number) => ms; test('x', () => {}, testTimeout(60_000)); });",
    ].join('\n');
    expect([...testLimits(source)]).toEqual([
      [3, 90_000],
      [4, DEFAULT_TEST_TIMEOUT_MS],
      [5, 45_000],
      [6, 45_000],
      [7, 30_000],
      [8, DEFAULT_TEST_TIMEOUT_MS],
      [9, 60_000],
      [10, 25_000],
      [11, undefined],
      [12, 5_000],
      [13, 1_000],
      [15, undefined],
      [16, undefined],
      [18, undefined],
      [19, undefined],
      [20, 1_000],
      [21, undefined],
      [22, 1_000],
      [23, undefined],
    ]);
  });

  // Bun is the subject: the line it reports is the key, and a multiline call reports its
  // name's line, not the call's first line.
  test('finds the limit of every test at the line Bun reports it', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'near-limit-bun-')));
    const source = [
      "import { test } from 'bun:test';",
      "test('single line', () => {}, 1_000);",
      'test.each([1])(',
      "  'each row %s',",
      '  () => {},',
      '  2_000',
      ');',
      'test.skipIf(false)(',
      "  'skip if',",
      '  () => {},',
      '  3_000',
      ');',
      'test(',
      "  'plain',",
      '  () => {},',
      '  4_000',
      ');',
    ].join('\n');
    writeFileSync(join(root, 'a.test.ts'), source);
    const report = join(root, 'report.xml');
    const run = Bun.spawnSync(
      bunTestCommand(['./a.test.ts', '--reporter=junit', `--reporter-outfile=${report}`]),
      { cwd: root, env: bunTestEnv(), stdout: 'pipe', stderr: 'pipe' }
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const limits = testLimits(source);
    const resolved = reportTimes(readFileSync(report, 'utf8'), 'root').map(time => [
      time.name,
      limits.get(time.line),
    ]);
    expect(resolved).toEqual([
      ['single line', 1_000],
      ['each row %s', 2_000],
      ['skip if', 3_000],
      ['plain', 4_000],
    ]);
  });
});

describe('the near-limit list', () => {
  test('lists tests over half their limit, an unread limit against the default', () => {
    const source = [
      "test('slow', () => {}, 30_000);",
      "test('fine', () => {}, 30_000);",
      "test('unread', () => {}, budget());",
      "test('default', () => {});",
    ].join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4">
  <testsuite name="src/a.test.ts" file="src/a.test.ts">
    <testcase name="slow" time="20.5" file="src/a.test.ts" line="1" />
    <testcase name="fine" time="14" file="src/a.test.ts" line="2" />
    <testcase name="unread" time="10.5" file="src/a.test.ts" line="3" />
    <testcase name="default" time="10" file="src/a.test.ts" line="4" />
  </testsuite>
</testsuites>`;
    const times = reportTimes(xml, 'packages/cli');
    expect(times[0]).toEqual({
      path: 'packages/cli/src/a.test.ts',
      line: 1,
      name: 'slow',
      seconds: 20.5,
    });
    const limits = testLimits(source);
    const listed = nearLimit(times, time => limits.get(time.line));
    expect(listed.map(test => [test.name, test.limitMs])).toEqual([
      ['slow', 30_000],
      ['unread', undefined],
    ]);
  });

  test('a testcase without its time is a reporter bug, not a fast test', () => {
    expect(() =>
      reportTimes(
        '<testsuites><testcase name="x" file="a.test.ts" line="1" /></testsuites>',
        'root'
      )
    ).toThrow('Malformed JUnit testcase');
  });
});
