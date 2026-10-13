import { describe, expect, it } from 'bun:test';
import { packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

// A dry run executes one loop iteration, so the round counter, the cap and what one
// round carries into the next are proved here, against the script itself.
const reviewed = {
  INPUTS_GREEN: 'true',
  INPUTS_RED_CAUSE: '',
  INPUTS_PR_URL: 'https://github.com/example/repo/pull/1',
  INPUTS_REVIEW_READY: 'true',
  INPUTS_REVIEW_ACTION: 'none',
};

function round(inputs: Record<string, string>): Record<string, unknown> {
  const run = runPackScript('prp/scripts/round', {
    inputs: {
      INPUTS_PREVIOUS: '',
      INPUTS_PRIOR_REPORT: '',
      INPUTS_PREVIOUS_PR_URL: '',
      INPUTS_CI: 'null',
      ...inputs,
    },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe('an archon-prp delivery round', () => {
  it('repeats while the review or a PR-caused CI red needs another round', () => {
    expect(
      round({ ...reviewed, INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'correct' })
    ).toMatchObject({
      round: 1,
      done: false,
      ready: false,
      reason: 'review_open',
      light_review: false,
    });
    // A correction for CI gets the light review: the code lens alone, on the delta.
    expect(round({ ...reviewed, INPUTS_PREVIOUS: '1', INPUTS_CI: 'pr_caused' })).toMatchObject({
      round: 2,
      done: false,
      reason: 'ci_pr_caused',
      light_review: true,
    });
  });

  it('ends ready only on green CI, and not ready on a cause outside the PR', () => {
    expect(round({ ...reviewed, INPUTS_CI: 'green' })).toMatchObject({
      done: true,
      ready: true,
      reason: 'delivered',
    });
    expect(round({ ...reviewed, INPUTS_CI: 'other' })).toMatchObject({
      done: true,
      ready: false,
      reason: 'ci_other',
    });
  });

  it('hands a validation red the change did not cause on to review', () => {
    expect(
      round({ ...reviewed, INPUTS_GREEN: 'false', INPUTS_RED_CAUSE: 'inherited', INPUTS_CI: 'green' })
    ).toMatchObject({ reason: 'delivered' });
    expect(
      round({ ...reviewed, INPUTS_GREEN: 'false', INPUTS_RED_CAUSE: 'introduced' })
    ).toMatchObject({ done: true, reason: 'implement_blocked' });
  });

  it('ends typed at the cap instead of starting a round the loop cannot finish', () => {
    expect(round({ ...reviewed, INPUTS_PREVIOUS: '2', INPUTS_CI: 'pr_caused' })).toMatchObject({
      round: 3,
      done: true,
      ready: false,
      reason: 'round_cap',
    });
  });

  it('carries the PR and the last published review into a round that never reached them', () => {
    const result = round({
      INPUTS_PREVIOUS: '1',
      INPUTS_PRIOR_REPORT: '/run/review/report.md',
      INPUTS_PREVIOUS_PR_URL: 'https://github.com/example/repo/pull/1',
      INPUTS_GREEN: 'true',
      INPUTS_RED_CAUSE: '',
      INPUTS_PR_URL: 'null',
      INPUTS_REVIEW_READY: 'null',
      INPUTS_REVIEW_ACTION: 'null',
      INPUTS_CI: 'null',
    });
    expect(result).toMatchObject({
      round: 2,
      pr_url: 'https://github.com/example/repo/pull/1',
      prior_report: '/run/review/report.md',
    });
  });
});

// Each READY route carries its own state label.
describe("archon-prp's triage labels", () => {
  it('labels a READY item with the route archon-prp takes on it', () => {
    for (const [route, label] of [
      ['deliver', 'archon-ready'],
      ['plan', 'archon-plan'],
      ['investigate', 'archon-issue'],
    ]) {
      const run = runPackScript('prp/scripts/verdict', {
        inputs: {
          INPUTS_ITEM: '{"repo":{"host":"","path":""},"number":0}',
          INPUTS_PUBLISH: 'false',
          INPUTS_CONTRACT: 'READY',
          INPUTS_ROUTE: route,
          INPUTS_COMPLEXITY: 'small',
          INPUTS_SUMMARY: 'Ready',
          INPUTS_BLOCKED_REASON: '',
          INPUTS_BLOCKED_BY: '[]',
          INPUTS_AREA_LABELS: '[]',
          INPUTS_PROPOSED_EDITS: '{"title":"","body":""}',
          INPUTS_REPORT: '{"path":"triage.md"}',
        },
      });
      expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
      expect(JSON.parse(run.stdout).labels).toContain(label);
    }
  });
});

// The planner judges `ready` itself, so a ready plan may still carry questions for
// the owner; the outcome relays them whether delivery ran or not.
describe("archon-prp's outcome", () => {
  function outcome(inputs: Record<string, string>): { ready: boolean; reason: string; summary: string } {
    const run = runPackScript('prp/scripts/outcome', {
      inputs: { INPUTS_ROUTE: 'plan', INPUTS_SUMMARY: 'Ready', INPUTS_ROUNDS: 'null', ...inputs },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    return JSON.parse(run.stdout) as { ready: boolean; reason: string; summary: string };
  }

  it("relays a ready plan's non-blocking questions on a delivered ending", () => {
    const result = outcome({
      INPUTS_OPEN_QUESTIONS: JSON.stringify(['Keep the default timeout? Non-blocking.']),
      INPUTS_ROUNDS: JSON.stringify({
        ready: true,
        reason: 'delivered',
        pr_url: 'https://github.com/example/repo/pull/1',
        summary: 'Round 1: delivered.',
      }),
    });
    expect(result).toMatchObject({ ready: true, reason: 'delivered' });
    expect(result.summary).toContain('- Keep the default timeout? Non-blocking.');
  });

  it('stops needs_human with the blocking question when the plan is not ready', () => {
    const result = outcome({ INPUTS_OPEN_QUESTIONS: JSON.stringify(['Which storage shape?']) });
    expect(result).toMatchObject({ ready: false, reason: 'needs_human' });
    expect(result.summary).toContain('- Which storage shape?');
  });
});
