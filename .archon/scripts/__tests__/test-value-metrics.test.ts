/**
 * The test-value judge's records: the metric's mapping from verdicts, calibration
 * scoring against labels, and the judge identity both carry.
 */
import { describe, expect, it } from 'bun:test';
import {
  type Case,
  type JudgeSlot,
  judgeSlots,
  scoreCalibration,
  testValueRecords,
} from '../../workflows/sdlc/.shared/test-value';
import { holdsTestCode } from '../../workflows/sdlc/metrics-test-value-judge/scripts/test-code';

const PR_A = 'https://github.example.com/acme/widgets/pull/1';
const PR_B = 'https://github.example.com/acme/widgets/pull/2';
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILE = 'src/widget.test.ts';

function verdict(name: string, protects: boolean) {
  return { file: FILE, name, protects, reason: 'why' };
}

describe('testValueRecords', () => {
  it('counts each judged pull request under its runs and the judge identity, and skips a failed judge', () => {
    const prs = [
      { url: PR_A, merged_at: '2026-10-05T12:00:00Z', runs: [RUN] },
      { url: PR_B, merged_at: '2026-10-06T12:00:00Z', runs: [RUN] },
    ];
    const judged = judgeSlots(prs, [
      { tests: [verdict('widget > keeps order', true), verdict('widget > logs the probe', false)] },
      { archon_failed: true, error: 'judge failed', status: 'failed' },
    ]);
    const { metrics, skipped } = testValueRecords(judged, 'test-value-judge:abc');
    const counted = {
      kind: 'count',
      unit: 'tests',
      subject: PR_A,
      at: '2026-10-05T12:00:00Z',
      runs: [RUN],
      instrument: 'test-value-judge:abc',
      instrument_node: 'judge',
    };
    expect(metrics).toEqual([
      { ...counted, name: 'sdlc.tests_added', value: 2 },
      { ...counted, name: 'sdlc.tests_unprotective', value: 1 },
    ]);
    expect(skipped).toEqual([{ url: PR_B, error: 'failed: judge failed' }]);
  });
});

describe('scoreCalibration', () => {
  const entry: Case = {
    pr: PR_A,
    tests: [
      { file: FILE, name: 'widget > keeps order for %s (lists, sets)', protects: true },
      { file: FILE, name: 'widget > preserves deletion', protects: true },
      { file: FILE, name: 'widget > logs the probe', protects: false },
      { file: FILE, name: 'widget > rewords the error', protects: false },
    ],
  };
  const judgedAs = (slot: JudgeSlot) => scoreCalibration([{ item: entry, slot }], 'test-value-judge:abc');

  it('scores every labeled test once, joins a parameterized test to its labeled cases, and counts an unlisted test as disagreement even when a shorter name starts it', () => {
    const { metrics, disagreements } = judgedAs({
      ok: true,
      tests: [
        verdict('widget > keeps order for ${kind}', true),
        verdict('widget > preserves ${change}', true),
        verdict('widget > logs the probe', false),
        verdict('widget > rewords', true),
      ],
    });
    const values = (name: string) => metrics.filter(row => row.name === name).map(row => row.value);
    expect(values('sdlc.tests_unprotective_judge_agreement')).toEqual([1, 1, 1, 0]);
    expect(values('sdlc.tests_unprotective_judge_catch_rate')).toEqual([1, 0]);
    expect(new Set(metrics.map(row => row.subject)).size).toBe(4);
    expect(disagreements).toEqual([
      { pr: PR_A, file: FILE, name: 'widget > rewords the error', label: false, verdict: null, reason: 'the judge did not list this test' },
    ]);
  });

  it('refuses a label that two verdicts could join', () => {
    const tests = [verdict('widget > logs the probe', false), verdict('widget > logs the probe!', true)];
    expect(() => judgedAs({ ok: true, tests })).toThrow('widget > logs the probe');
  });

  it('refuses the whole score when the judge failed on any case', () => {
    expect(() => judgedAs({ ok: false, error: 'failed: judge failed' })).toThrow(PR_A);
  });

  it('gives a judge that always answers "protects" a catch rate of 0', () => {
    const { metrics } = judgedAs({ ok: true, tests: entry.tests.map(test => verdict(test.name, true)) });
    expect(metrics.filter(row => row.name === 'sdlc.tests_unprotective_judge_catch_rate').map(row => row.value)).toEqual([0, 0]);
  });
});

describe('holdsTestCode', () => {
  it('reads a test suite defined outside test files, and not source or docs that only mention tests', () => {
    const suite = "+      const listed = await listQueue(source);\n+      expect(listed).toEqual([]);";
    expect(holdsTestCode('src/store-conformance/attention.ts', suite)).toBe(true);
    expect(holdsTestCode('tools/check.py', '+def test_rejects_empty(tmp_path):')).toBe(true);
    expect(holdsTestCode('pkg/store/conformance.go', '+func TestRoundTrip(t *testing.T) {')).toBe(true);
    expect(holdsTestCode('src/widget.test.ts', '+const x = 1;')).toBe(true);
    expect(holdsTestCode('src/keys.ts', '+  if (PLACEHOLDER.test(name)) return name;')).toBe(false);
    expect(holdsTestCode('docs/testing.md', "+test('keeps order', () => {});")).toBe(false);
  });

  it('counts added and unchanged lines, not hunk headers or removed lines', () => {
    expect(holdsTestCode('src/queue.ts', '@@ -1,3 +1,3 @@ export function test(x) {\n-  expect(x);\n+  return x;')).toBe(false);
    expect(holdsTestCode('src/suite.ts', '       expect(\n-        listed(run)\n+        listed(run).values\n       ).toContain(run.id);')).toBe(true);
    expect(holdsTestCode('src/queue.ts', null)).toBe(false);
  });
});
