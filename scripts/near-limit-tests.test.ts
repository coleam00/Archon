import { describe, expect, test } from 'bun:test';
import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';
import { nearLimit, reportTimes, testLimits } from './near-limit-tests';

describe('testLimits', () => {
  test('reads each form a test call gives its limit, by the line the call starts on', () => {
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
