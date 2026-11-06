/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome, deliver's correction round, and the deliver, ship
 * and upkeep terminal reports. Run as
 * the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { PR, PR_URL, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

describe("ship's terminal outcome", () => {
  interface ShipOutcome { delivered: boolean; reason: string; pr_url: string; summary: string }
  const outcome = (inputs: Record<string, string>): ShipOutcome => {
    const run = runPackScript('ship/scripts/outcome', {
      inputs: {
        INPUTS_ROUTE: 'no_action',
        INPUTS_CONTRACT: 'NO_ACTION',
        INPUTS_BLOCKED_REASON: '',
        INPUTS_SUMMARY: 'triage summary',
        INPUTS_INV_VERDICT: 'null',
        INPUTS_INV_SUMMARY: 'null',
        INPUTS_PLAN_SUMMARY: 'null',
        INPUTS_OPEN_QUESTIONS: 'null',
        INPUTS_DELIVERED: 'null',
        INPUTS_DELIVERY: 'null',
        INPUTS_DELIVERY_REASON: 'null',
        INPUTS_PR_URL: 'null',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] }) },
    });
    expect(run.code, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as ShipOutcome;
  };

  it('reports a refuted investigation as not delivered, with its summary', () => {
    const result = outcome({
      INPUTS_ROUTE: 'investigate',
      INPUTS_CONTRACT: 'READY',
      INPUTS_INV_VERDICT: 'refuted',
      INPUTS_INV_SUMMARY: 'the cause is owned upstream in the provider SDK',
    });
    expect(result.delivered).toBe(false);
    expect(result.summary).toContain('the cause is owned upstream in the provider SDK');
  });

  it("reports a deliver round that ended not ready as not delivered, with its reason and pull request", () => {
    expect(
      outcome({
        INPUTS_ROUTE: 'deliver',
        INPUTS_CONTRACT: 'READY',
        INPUTS_PR_URL: PR_URL,
        INPUTS_DELIVERED: 'false',
        INPUTS_DELIVERY: 'Not ready, red: lint',
        INPUTS_DELIVERY_REASON: 'ci_other',
      })
    ).toEqual({ delivered: false, reason: 'ci_other', pr_url: PR_URL, summary: 'Not ready, red: lint' });
  });
});

describe("deliver's report after a node failure", () => {
  const failedReport = (listing: object, artifacts: Record<string, string> = {}): { reason: string; pr_url: string } =>
    JSON.parse(
      runPackScript('deliver/scripts/report', {
        inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
        artifacts: { 'listing.json': JSON.stringify({ runId: 'run', errors: [], ...listing }), ...artifacts },
      }).stdout
    ) as { reason: string; pr_url: string };

  it('names the pull request a round published before the failure, so the next run continues it', () => {
    const published = failedReport(
      { artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json' }] } },
      { 'nodes/publish.json': JSON.stringify({ number: 42, url: PR_URL }) }
    );
    expect(published).toMatchObject({ reason: 'failed', pr_url: PR_URL });
    expect(failedReport({ artifactsByType: {} })).toMatchObject({ reason: 'failed', pr_url: '' });
  });
  it("lets the creation record decide once the publish node's latest invocation failed", () => {
    // Round 1 published PR_URL; round 2's publish failed after its create started.
    const outcomes = (state: string) => JSON.stringify({
      run_id: 'run', first_failed_node: null,
      nodes: [
        { node_id: 'rounds.pr__publish', state: 'completed', loop_group_path: [{ groupId: 'rounds', iteration: 1 }] },
        { node_id: 'rounds.pr__publish', state, loop_group_path: [{ groupId: 'rounds', iteration: 2 }] },
      ],
    });
    for (const secondRound of ['failed', 'completed']) {
      const run = runPackScript('deliver/scripts/report', {
        inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json', NODE_OUTCOMES_FILE: '{ARTIFACTS}/outcomes.json' },
        artifacts: {
          'listing.json': JSON.stringify({ artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json', nodeId: 'pr__publish', loopGroupPath: [{ groupId: 'rounds', iteration: 1 }] }] }, errors: [] }),
          'nodes/publish.json': JSON.stringify({ url: PR_URL }),
          'outcomes.json': outcomes(secondRound),
          'pr-create-started': JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }),
        },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject(
        secondRound === 'failed' ? { reason: 'pr_create_unresolved', pr_url: '' } : { reason: 'failed', pr_url: PR_URL }
      );
    }
  });

  it('does not certify a URL without a complete PR record', () => {
    const result = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null' },
      artifacts: { 'pr-create-started': JSON.stringify({ pr: { url: PR_URL } }) },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: 'pr_create_unresolved',
      pr_url: '', summary: expect.stringContaining('invalid pull-request record'),
    });
  });

  for (const script of ['deliver/scripts/report', 'ship/scripts/report']) {
    it.each(['unverified', 'unreadable', 'directory'])(
      'distinguishes an unresolved %s create from no PR', kind => {
        const run = runPackScript(script, {
          inputs: { INPUTS_OUTCOME: 'null' },
          artifacts: kind === 'directory' ? {} : {
            'pr-create-started': kind === 'unverified' ? JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }) : 'invalid JSON',
          },
          preload: kind === 'directory' ? `import { mkdirSync } from 'node:fs'; mkdirSync('{ARTIFACTS}/pr-create-started');` : undefined,
        });
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ reason: 'pr_create_unresolved', pr_url: '', summary: expect.stringContaining('pr-create-started') });
      }
    );
  }
});

describe("ship's continued pull request", () => {
  const continues = (caller: string, triage: string): { code: number; stdout: string; stderr: string } =>
    runPackScript('ship/scripts/continues', { inputs: { INPUTS_CALLER: caller, INPUTS_TRIAGE: triage } });

  it("is the caller's whichever route triage took, else triage's", () => {
    expect(JSON.parse(continues('42', 'null').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('', '42').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('42', '42').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('null', 'null').stdout)).toEqual({ pull_request: null });
    expect(JSON.parse(continues('none', 'null').stdout)).toEqual({ pull_request: null });
  });

  it('refuses when the caller decided none but triage routed the run to continue one', () => {
    const result = continues('none', '42');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the caller decided the run continues no pull request, but triage routed it to continue 42');
  });

  it('refuses when the caller and triage name different pull requests', () => {
    const result = continues('42', '43');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the caller resolved pull request 42, but triage routed the run to continue 43');
  });
});

describe("deliver's round", () => {
  interface Round { round: number; done: boolean; ready: boolean; reason: string; pr_url: string; prior_report: string; light_review: boolean; contract_left: string[] | null; summary: string }
  const round = (inputs: Record<string, string>): Round =>
    JSON.parse(
      runPackScript('deliver/scripts/round', {
        inputs: {
          INPUTS_PREVIOUS: '',
          INPUTS_PRIOR_REPORT: '',
          INPUTS_PREVIOUS_PR_URL: '',
          INPUTS_GREEN: 'true',
          INPUTS_RED_CAUSE: '',
          INPUTS_IMPLEMENT_SUMMARY: 'built',
          INPUTS_PR_URL: PR_URL,
          INPUTS_REVIEW_READY: 'true',
          INPUTS_REVIEW_ACTION: 'none',
          INPUTS_REVIEW_SUMMARY: 'clean',
          INPUTS_REVIEW_CONTRACT_LEFT: '[]',
          INPUTS_PREVIOUS_CONTRACT_LEFT: '',
          INPUTS_CI: 'green',
          INPUTS_CI_SUMMARY: 'all passed',
          INPUTS_THREADS_OPEN: '0',
          INPUTS_THREADS_SUMMARY: 'no thread open',
          INPUTS_SETTLE_ASK: 'null',
          INPUTS_SETTLE_SUMMARY: 'null',
          ...inputs,
        },
      }).stdout
    ) as Round;

  it('delivers on a passing review and green CI', () => {
    expect(round({})).toMatchObject({ round: 1, done: true, ready: true, reason: 'delivered', pr_url: PR_URL });
  });

  it('stops on red the change introduced, before any pull request', () => {
    const ended = round({ INPUTS_GREEN: 'false', INPUTS_RED_CAUSE: 'introduced', INPUTS_PR_URL: 'null' });
    expect(ended).toMatchObject({ done: true, ready: false, reason: 'implement_blocked', pr_url: '' });
  });

  it('keeps an earlier round’s pull request when this round opened none', () => {
    const ended = round({
      INPUTS_PREVIOUS: '1',
      INPUTS_PREVIOUS_PR_URL: PR_URL,
      INPUTS_GREEN: 'false',
      INPUTS_PR_URL: 'null',
    });
    expect(ended).toMatchObject({ round: 2, reason: 'implement_blocked', pr_url: PR_URL });
  });

  it('goes again for open findings and a red the change caused, and stops on any other red', () => {
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'correct', INPUTS_CI: 'null' })).toMatchObject({
      done: false,
      reason: 'review_open',
    });
    expect(round({ INPUTS_CI: 'pr_caused' })).toMatchObject({ done: false, reason: 'ci_pr_caused' });
    expect(round({ INPUTS_CI: 'other' })).toMatchObject({ done: true, ready: false, reason: 'ci_other' });
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'replan', INPUTS_CI: 'null' })).toMatchObject({
      done: true,
      reason: 'replan',
    });
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'ask', INPUTS_CI: 'null' })).toMatchObject({
      done: true,
      ready: false,
      reason: 'ask',
    });
  });

  it('does not end ready while a review thread is open, and asks on one no round can settle', () => {
    const open = round({ INPUTS_THREADS_OPEN: '2', INPUTS_THREADS_SUMMARY: '2 review threads are unresolved' });
    expect(open).toMatchObject({ done: false, ready: false, reason: 'threads_open' });
    const asked = round({
      INPUTS_THREADS_OPEN: '1',
      INPUTS_SETTLE_ASK: 'true',
      INPUTS_SETTLE_SUMMARY: 'a person decides the API name',
    });
    expect(asked).toMatchObject({ done: true, ready: false, reason: 'ask' });
    expect(asked.summary).toContain('a person decides the API name');
    // A CI red decides the round before the threads do.
    expect(round({ INPUTS_THREADS_OPEN: '1', INPUTS_CI: 'other' })).toMatchObject({ reason: 'ci_other' });
  });
});
