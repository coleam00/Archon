/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome, deliver's correction round, and the deliver, ship
 * and upkeep terminal reports. Run as
 * the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PR_URL, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });

describe('investigate verdict', () => {
  it.each([
    ['rooted', true],
    ['refuted', false],
    ['inconclusive', false],
  ] as const)('derives rooted from a %s verdict', (verdict, rooted) => {
    const run = runPackScript('investigate/scripts/verdict', {
      inputs: {
        INPUTS_VERDICT: verdict,
        INPUTS_SUMMARY: 'stub',
        INPUTS_REPORT: JSON.stringify({ type: 'archon_artifact', run_id: 'r', path: 'investigation.md' }),
      },
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ verdict, rooted });
  });
});

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
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as ShipOutcome;
  };

  it('reports a refuted investigation as no work owed, in the investigator’s words', () => {
    const result = outcome({
      INPUTS_ROUTE: 'investigate',
      INPUTS_CONTRACT: 'READY',
      INPUTS_INV_VERDICT: 'refuted',
      INPUTS_INV_SUMMARY: 'the cause is owned upstream in the provider SDK',
    });
    expect(result.delivered).toBe(false);
    expect(result.summary).toStartWith('No work owed in this repository: the cause is owned upstream');
    expect(result.summary).toContain('investigation.md');
  });

  it('reports an inconclusive investigation as work not done, with its gap', () => {
    const result = outcome({
      INPUTS_ROUTE: 'investigate',
      INPUTS_CONTRACT: 'READY',
      INPUTS_INV_VERDICT: 'inconclusive',
      INPUTS_INV_SUMMARY: 'the probe could not authenticate',
    });
    expect(result.summary).toStartWith('Not done: the investigation was inconclusive. the probe could not authenticate');
  });

  it('relays every open question when planning stops on a person’s call', () => {
    const result = outcome({
      INPUTS_ROUTE: 'plan',
      INPUTS_CONTRACT: 'READY',
      INPUTS_PLAN_SUMMARY: 'needs a product call',
      INPUTS_OPEN_QUESTIONS: JSON.stringify(['keep the field?', 'which default?']),
    });
    expect(result).toMatchObject({ delivered: false, reason: 'needs_human', pr_url: '' });
    expect(result.summary).toContain('needs a product call\n- keep the field?\n- which default?');
  });

  it('relays questions the planner judged non-blocking with a delivery', () => {
    const result = outcome({
      INPUTS_ROUTE: 'plan',
      INPUTS_CONTRACT: 'READY',
      INPUTS_OPEN_QUESTIONS: JSON.stringify(['rename the flag later?']),
      INPUTS_DELIVERED: 'true',
      INPUTS_DELIVERY: 'https://x/pull/1',
      INPUTS_DELIVERY_REASON: 'delivered',
    });
    expect(result).toMatchObject({ delivered: true, reason: 'delivered' });
    expect(result.summary).toContain('non-blocking:\n- rename the flag later?');
  });

  it('names a blocked item as requested work not done', () => {
    const result = outcome({ INPUTS_CONTRACT: 'BLOCKED', INPUTS_BLOCKED_REASON: 'waits on a release' });
    expect(result.delivered).toBe(false);
    expect(result.summary).toStartWith('Not done: blocked on waits on a release.');
  });

  it('keeps an honest no-action as no delivery needed', () => {
    expect(outcome({}).summary).toStartWith('No delivery needed: triage summary');
  });

  it("reports deliver's own outcome and pull request, ready or not", () => {
    const deliver = { INPUTS_ROUTE: 'deliver', INPUTS_CONTRACT: 'READY', INPUTS_PR_URL: PR_URL };
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'true', INPUTS_DELIVERY: `Ready: done\n${PR_URL}`, INPUTS_DELIVERY_REASON: 'delivered' })
    ).toEqual({
      delivered: true,
      reason: 'delivered',
      pr_url: PR_URL,
      summary: `Ready: done\n${PR_URL}`,
    });
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready, red: lint', INPUTS_DELIVERY_REASON: 'ci_other' })
    ).toEqual({
      delivered: false,
      reason: 'ci_other',
      pr_url: PR_URL,
      summary: 'Not ready, red: lint',
    });
  });
});

describe("upkeep's terminal outcome", () => {
  const outcome = (inputs: Record<string, string>): { delivered: boolean; pr_url: string; summary: string } => {
    const run = runPackScript('upkeep/scripts/outcome', {
      inputs: { INPUTS_SUMMARY: 'already current', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json', ...inputs },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { delivered: boolean; pr_url: string; summary: string };
  };

  it("reports deliver's pull request, and none when no update was needed", () => {
    expect(
      outcome({ INPUTS_ACTION: 'update', INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready: ci_other', INPUTS_PR_URL: PR_URL })
    ).toEqual({ delivered: false, pr_url: PR_URL, summary: 'Not ready: ci_other' });
    expect(
      outcome({ INPUTS_ACTION: 'no_action', INPUTS_DELIVERED: 'null', INPUTS_DELIVERY: 'null', INPUTS_PR_URL: 'null' })
    ).toMatchObject({ delivered: false, pr_url: '' });
  });
});

describe("deliver's terminal outcome", () => {
  interface Outcome { ready: boolean; reason: string; pr_url: string; ci_rerun: string; summary: string }
  const outcome = (rounds: object): Outcome => {
    const run = runPackScript('deliver/scripts/outcome', {
      inputs: { INPUTS_ROUNDS: JSON.stringify(rounds), TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as Outcome;
  };

  it("reports the last round's ending with its pull request", () => {
    expect(
      outcome({ ready: true, reason: 'delivered', pr_url: PR_URL, ci_rerun: 'green', contract_left: [], summary: 'Round 1: delivered. all passed' })
    ).toEqual({
      ready: true,
      reason: 'delivered',
      pr_url: PR_URL,
      ci_rerun: 'green',
      summary: `Ready: Round 1: delivered. all passed\n${PR_URL}`,
    });
    const blocked = outcome({ ready: false, reason: 'implement_blocked', pr_url: '', ci_rerun: 'none', contract_left: null, summary: 'Round 1: implement_blocked. x' });
    expect(blocked).toMatchObject({ ready: false, reason: 'implement_blocked', pr_url: '' });
    expect(blocked.summary).toBe('Not ready: Round 1: implement_blocked. x');
  });

  it('lists the contract items the latest review left open', () => {
    const partial = outcome({
      ready: true,
      reason: 'delivered',
      pr_url: PR_URL,
      ci_rerun: 'none',
      contract_left: ['acceptance: the console shows it (deferred)'],
      summary: 'Round 1: delivered. all passed',
    });
    expect(partial.summary).toBe(
      `Ready: Round 1: delivered. all passed\n${PR_URL}\n\nLeft open, so the pull request does not close its issue:\n- acceptance: the console shows it (deferred)`
    );
  });
});

describe("deliver's round", () => {
  interface Round { round: number; done: boolean; ready: boolean; review_ready: boolean; reason: string; pr_url: string; prior_report: string; light_review: boolean; ci_rerun: string; contract_left: string[] | null; summary: string }
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
          INPUTS_CI_RERUN: 'none',
          INPUTS_CI_SUMMARY: 'all passed',
          ...inputs,
        },
      }).stdout
    ) as Round;

  it('delivers on a passing review and green CI', () => {
    expect(round({})).toMatchObject({ round: 1, done: true, ready: true, reason: 'delivered', pr_url: PR_URL });
  });

  it.each(['correct', 'replan', 'needs_human'])('does not certify empty coverage after a %s review', action => {
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: action, INPUTS_CI: 'null' })).toMatchObject({
      ready: false,
      review_ready: false,
      contract_left: [],
    });
  });

  it('uses the deciding review verdict independently of coverage, CI and the round cap', () => {
    expect(round({})).toMatchObject({ review_ready: true, contract_left: [] });
    expect(round({ INPUTS_CI: 'other' })).toMatchObject({ ready: false, review_ready: true });
    expect(round({ INPUTS_PREVIOUS: '3', INPUTS_REVIEW_READY: 'false', INPUTS_CI: 'null' })).toMatchObject({
      reason: 'round_cap', review_ready: false, contract_left: [],
    });
    expect(round({ INPUTS_REREVIEW_READY: 'false', INPUTS_REREVIEW_ACTION: 'correct', INPUTS_REREVIEW_CONTRACT_LEFT: '[]' })).toMatchObject({
      review_ready: false, contract_left: [],
    });
    expect(round({ INPUTS_REVIEW_READY: 'null', INPUTS_REVIEW_CONTRACT_LEFT: 'null', INPUTS_PREVIOUS_CONTRACT_LEFT: '[]' })).toMatchObject({
      review_ready: false, contract_left: [],
    });
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
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'needs_human', INPUTS_CI: 'null' })).toMatchObject({
      done: true,
      ready: false,
      reason: 'needs_human',
    });
  });

  it('lets the light review of the reshape delta decide the round', () => {
    const rereview = { INPUTS_REREVIEW_ACTION: 'correct', INPUTS_REREVIEW_SUMMARY: 'reshape broke it', INPUTS_CI: 'null' };
    const open = round({ ...rereview, INPUTS_REREVIEW_READY: 'false' });
    expect(open).toMatchObject({ done: false, ready: false, reason: 'review_open' });
    expect(open.summary).toContain('reshape broke it');
    expect(round({ INPUTS_REREVIEW_READY: 'true', INPUTS_REREVIEW_ACTION: 'none' })).toMatchObject({ reason: 'delivered' });
  });

  it("records the CI agent's re-run, and none when CI never ran", () => {
    expect(round({ INPUTS_CI_RERUN: 'green' })).toMatchObject({ reason: 'delivered', ci_rerun: 'green' });
    expect(round({ INPUTS_CI: 'other', INPUTS_CI_RERUN: 'red' })).toMatchObject({ reason: 'ci_other', ci_rerun: 'red' });
    expect(
      round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'correct', INPUTS_CI: 'null', INPUTS_CI_RERUN: 'null' })
    ).toMatchObject({ reason: 'review_open', ci_rerun: 'none' });
  });

  it('ends typed at the round cap instead of exhausting the loop', () => {
    expect(round({ INPUTS_PREVIOUS: '2', INPUTS_CI: 'pr_caused' })).toMatchObject({ round: 3, done: false });
    expect(round({ INPUTS_PREVIOUS: '3', INPUTS_CI: 'pr_caused' })).toMatchObject({
      round: 4,
      done: true,
      ready: false,
      reason: 'round_cap',
    });
  });

  it('reviews the next round light only after a CI fix', () => {
    expect(round({ INPUTS_CI: 'pr_caused' }).light_review).toBe(true);
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'correct', INPUTS_CI: 'null' }).light_review).toBe(
      false
    );
  });

  it("carries the deciding review's open contract items, or an earlier round's when no review ran", () => {
    const left = '["acceptance: the console shows it"]';
    expect(round({ INPUTS_REVIEW_CONTRACT_LEFT: left }).contract_left).toEqual(['acceptance: the console shows it']);
    expect(
      round({ INPUTS_REVIEW_CONTRACT_LEFT: left, INPUTS_REREVIEW_READY: 'true', INPUTS_REREVIEW_ACTION: 'none', INPUTS_REREVIEW_CONTRACT_LEFT: '[]' })
        .contract_left
    ).toEqual([]);
    const blocked = { INPUTS_GREEN: 'false', INPUTS_REVIEW_READY: 'null', INPUTS_REVIEW_CONTRACT_LEFT: 'null' };
    expect(round({ ...blocked, INPUTS_PREVIOUS_CONTRACT_LEFT: left }).contract_left).toEqual(['acceptance: the console shows it']);
    expect(round(blocked).contract_left).toBeNull();
  });

  it('points the next round at the published review report', () => {
    expect(round({}).prior_report).toEndWith('/review/report.md');
    expect(round({ INPUTS_GREEN: 'false', INPUTS_PRIOR_REPORT: '/earlier/report.md', INPUTS_REVIEW_READY: 'null' }).prior_report).toBe(
      '/earlier/report.md'
    );
  });
});

describe('review lens gating', () => {
  // The route agent's schema, the mode node's rerun selection and the lens nodes must
  // name the same lenses; this holds the three in step.
  it('gates every lens node on the route or rerun boolean of the same name', async () => {
    const source = await Bun.file(
      join(import.meta.dir, '../../workflows/sdlc/review/archon-review.yaml')
    ).text();
    const workflow = Bun.YAML.parse(source) as {
      nodes: {
        id: string;
        when?: string;
        output_type?: string;
        output_format?: { properties: Record<string, unknown> };
      }[];
    };
    const lenses = workflow.nodes.filter(node => node.output_type === 'review-lens');
    const route = workflow.nodes.find(node => node.id === 'route');
    const ids = lenses.map(node => node.id);
    expect(Object.keys(route?.output_format?.properties ?? {}).sort()).toEqual([...ids, 'reason'].sort());
    const mode = Object.keys(workflow.nodes.find(node => node.id === 'mode')?.output_format?.properties ?? {});
    expect(mode).toEqual(expect.arrayContaining(ids));
    for (const lens of lenses) {
      expect(lens.when).toBe(
        `$mode.output.continuation == false && $route.output.${lens.id} == true || $mode.output.${lens.id} == true`
      );
    }
  });
});
