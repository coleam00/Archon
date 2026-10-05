/**
 * ci-cause holds a CI classifier's claim to its structured evidence: where each
 * failure lives against the pull request's changed files, the base commit's result,
 * and any re-run's. The deliver fixtures pin the routes; these pin the rule.
 */
import { describe, expect, it } from 'bun:test';
import { runPackScript } from './deliver-checks-harness';

interface Claim {
  paths?: string[];
  base?: string;
  rerun?: string;
  claim: string;
}

function decide({ paths = [], base = 'unknown', rerun = 'not_rerun', claim }: Claim): {
  cause: string;
  evidence: string;
} {
  const run = runPackScript('deliver/scripts/ci-cause', {
    inputs: {
      INPUTS_CHANGED: JSON.stringify({ files: ['src/feature.ts', 'src/feature.test.ts'] }),
      INPUTS_FAILING_CHECKS: JSON.stringify(['test (windows-latest)']),
      INPUTS_FAILING_PATHS: JSON.stringify(paths),
      INPUTS_BASE: base,
      INPUTS_RERUN: rerun,
      INPUTS_CLAIM: claim,
      INPUTS_EVIDENCE: 'stub evidence',
    },
  });
  expect(run.code).toBe(0);
  return JSON.parse(run.stdout) as { cause: string; evidence: string };
}

describe('ci-cause', () => {
  it('classifies a failure in a changed file as introduced, whatever the claim', () => {
    for (const path of ['src/feature.test.ts', 'D:\\a\\repo\\repo\\src\\feature.test.ts:98']) {
      const decided = decide({ paths: [path], base: 'fails', claim: 'inherited' });
      expect(decided.cause).toBe('introduced');
      expect(decided.evidence).toContain('which this pull request changes');
    }
  });

  it('accepts inherited only when the base commit fails the same check', () => {
    expect(decide({ paths: ['src/other.ts'], base: 'fails', claim: 'inherited' }).cause).toBe(
      'inherited'
    );
    expect(decide({ paths: ['src/other.ts'], base: 'passes', claim: 'inherited' }).cause).toBe(
      'introduced'
    );
  });

  it('accepts environment for an untouched flake, but not one a re-run reproduced', () => {
    expect(decide({ paths: ['src/other.ts'], rerun: 'passes', claim: 'environment' }).cause).toBe(
      'environment'
    );
    expect(decide({ paths: ['src/other.ts'], rerun: 'fails', claim: 'environment' }).cause).toBe(
      'introduced'
    );
  });

  it('records the facts the decision rests on', () => {
    const { evidence } = decide({ paths: ['src/other.ts'], rerun: 'passes', claim: 'environment' });
    expect(evidence).toContain('Failing paths: src/other.ts.');
    expect(evidence).toContain('Re-run: passes. Claimed: environment.');
    expect(evidence).toContain('stub evidence');
  });
  it('passes an unavailable claim through to the operator, unless a changed file fails', () => {
    expect(decide({ claim: 'unavailable' }).cause).toBe('unavailable');
    expect(decide({ paths: ['src/feature.ts'], claim: 'unavailable' }).cause).toBe('introduced');
  });

  it('accepts environment for a failure outside the change that passed when re-run', () => {
    expect(decide({ paths: ['src/other.test.ts'], base: 'passes', rerun: 'passes', claim: 'environment' }).cause).toBe(
      'environment'
    );
  });
});
