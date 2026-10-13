import { describe, expect, it } from 'bun:test';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

function coverage(continuation: boolean, tier: string, focused: unknown = null): ScriptRun {
  return runPackScript('review/scripts/resolve-review-coverage', {
    inputs: {
      INPUTS_CONTINUATION: String(continuation),
      INPUTS_TIER: tier,
      INPUTS_FOCUSED: JSON.stringify(focused),
    },
  });
}

describe('effective review coverage', () => {
  it('runs full specialists without a focused producer on a full first round', () => {
    const run = coverage(false, 'full');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ full: true });
  });

  for (const fullReview of [false, true]) {
    it(`routes the certified focused judgment ${String(fullReview)}`, () => {
      const run = coverage(false, 'focused', {
        full_review: fullReview,
        reason: 'concrete judgment',
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ full: fullReview });
    });
  }

  for (const tier of ['focused', 'full']) {
    it(`keeps specialists off during ${tier} continuation`, () => {
      const run = coverage(true, tier, { full_review: true, reason: 'prior escalation' });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ full: false });
    });
  }

  for (const focused of [
    null,
    {},
    { full_review: 'false', reason: 'bad type' },
    { full_review: false, reason: ' ' },
  ]) {
    it(`refuses invalid enabled focused output ${JSON.stringify(focused)}`, () => {
      const run = coverage(false, 'focused', focused);
      expect(run.code).not.toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('enabled focused review must declare');
    });
  }
});
