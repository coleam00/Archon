/**
 * The test-value judge's records: the metric's mapping from verdicts, calibration
 * scoring against labels, and the judge identity both carry.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Case,
  type JudgeSlot,
  judgeIdentity,
  judgeSlots,
  scoreCalibration,
  testValueRecords,
} from '../../workflows/sdlc/.shared/test-value';
import { trackTempRoots } from './temp-roots';

const track = trackTempRoots();
const PR_A = 'https://github.example.com/acme/widgets/pull/1';
const PR_B = 'https://github.example.com/acme/widgets/pull/2';
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILE = 'src/widget.test.ts';

function verdict(name: string, protects: boolean) {
  return { file: FILE, name, protects, reason: 'why' };
}

describe('testValueRecords', () => {
  it('counts each judged pull request under its runs and the judge identity, and skips a failed judge', () => {
    const slots = judgeSlots(
      [
        { tests: [verdict('widget > keeps order', true), verdict('widget > logs the probe', false)] },
        { archon_failed: true, error: 'judge failed', status: 'failed' },
      ],
      2
    );
    const prs = [
      { url: PR_A, merged_at: '2026-10-05T12:00:00Z', runs: [RUN] },
      { url: PR_B, merged_at: '2026-10-06T12:00:00Z', runs: [RUN] },
    ];
    const { metrics, skipped } = testValueRecords(prs, slots, 'test-value-judge:abc');
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
  const cases: Case[] = [
    {
      pr: PR_A,
      tests: [
        { file: FILE, name: 'widget > keeps order for %s (lists, sets)', protects: true },
        { file: FILE, name: 'widget > preserves deletion', protects: true },
        { file: FILE, name: 'widget > logs the probe', protects: false },
        { file: FILE, name: 'widget > rewords the error', protects: false },
      ],
    },
  ];

  it('scores every labeled test once, joins a parameterized test to its labeled cases, and counts an unlisted test as disagreement', () => {
    const slots: JudgeSlot[] = [
      {
        ok: true,
        tests: [
          verdict('widget > keeps order for ${kind}', true),
          verdict('widget > preserves ${change}', true),
          verdict('widget > logs the probe', false),
        ],
      },
    ];
    const { metrics, disagreements } = scoreCalibration(cases, slots, 'test-value-judge:abc');
    const values = (name: string) => metrics.filter(row => row.name === name).map(row => row.value);
    expect(values('sdlc.tests_unprotective_judge_agreement')).toEqual([1, 1, 1, 0]);
    expect(values('sdlc.tests_unprotective_judge_catch_rate')).toEqual([1, 0]);
    expect(new Set(metrics.map(row => row.subject)).size).toBe(4);
    expect(disagreements).toEqual([
      { pr: PR_A, file: FILE, name: 'widget > rewords the error', label: false, verdict: null, reason: 'the judge did not list this test' },
    ]);
  });

  it('gives a judge that always answers "protects" a catch rate of 0', () => {
    const slots: JudgeSlot[] = [{ ok: true, tests: cases[0]?.tests.map(test => verdict(test.name, true)) ?? [] }];
    const { metrics } = scoreCalibration(cases, slots, 'test-value-judge:abc');
    expect(metrics.filter(row => row.name === 'sdlc.tests_unprotective_judge_catch_rate').map(row => row.value)).toEqual([0, 0]);
  });
});

describe('judgeIdentity', () => {
  it('changes with the inlined criteria, and the metric and agreement records carry the same identity', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'test-value-judge-')));
    writeFileSync(join(dir, 'judge.yaml'), 'name: judge\n');
    const identity = judgeIdentity(dir, 'criteria');
    expect(judgeIdentity(dir, 'criteria')).toBe(identity);
    expect(judgeIdentity(dir, 'reworded criteria')).not.toBe(identity);

    const metric = testValueRecords([{ url: PR_A, merged_at: '2026-10-05T12:00:00Z', runs: [RUN] }], [{ ok: true, tests: [] }], identity);
    const scored = scoreCalibration([{ pr: PR_A, tests: [{ file: FILE, name: 'a', protects: true }] }], [{ ok: true, tests: [] }], identity);
    const instruments = [...metric.metrics, ...scored.metrics].flatMap(row => (row.instrument === undefined ? [] : [[row.instrument, row.instrument_node]]));
    expect(instruments).toEqual([
      [identity, 'judge'],
      [identity, 'judge'],
      [identity, 'judge'],
    ]);
  });
});
