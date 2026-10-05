import { describe, expect, it } from 'bun:test';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

function coverage(
  continuation: boolean,
  tier: string,
  focused: unknown = null,
  extra: Record<string, string> = {}
): ScriptRun {
  return runPackScript('review/scripts/resolve-review-coverage', {
    inputs: {
      INPUTS_CONTINUATION: String(continuation),
      INPUTS_TIER: tier,
      INPUTS_FOCUSED: JSON.stringify(focused),
      INPUTS_ERRORS: 'false',
      INPUTS_DOCS: 'auto',
      INPUTS_SCOPE_DOCS: 'false',
      ...extra,
    },
  });
}

describe('effective review coverage', () => {
  it('runs full specialists without a focused producer on a full first round', () => {
    const run = coverage(false, 'full');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      full: true,
      errors: false,
      docs: false,
      lenses: ['seams', 'code', 'tests', 'simplify'],
    });
  });

  for (const fullReview of [false, true]) {
    it(`routes the certified focused judgment ${String(fullReview)}`, () => {
      const run = coverage(false, 'focused', { full_review: fullReview, reason: 'concrete judgment' });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ full: fullReview });
      expect(JSON.parse(run.stdout).lenses).toEqual(
        fullReview ? ['seams', 'focused', 'code', 'tests', 'simplify'] : ['seams', 'focused']
      );
    });
  }

  it('enables errors from its input and docs from the scope selection under auto', () => {
    const run = coverage(false, 'full', null, { INPUTS_ERRORS: 'true', INPUTS_SCOPE_DOCS: 'true' });
    expect(JSON.parse(run.stdout)).toMatchObject({ errors: true, docs: true });
  });

  for (const tier of ['focused', 'full']) {
    it(`keeps every lens off during ${tier} continuation`, () => {
      const run = coverage(true, tier, { full_review: true, reason: 'prior escalation' }, { INPUTS_ERRORS: 'true' });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ full: false, errors: false, docs: false, lenses: [] });
    });
  }

  it('refuses an enabled focused round whose focused reviewer did not report', () => {
    const run = coverage(false, 'focused', null);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('enabled focused review must declare');
  });
});
