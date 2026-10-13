/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome, deliver's correction round, and the deliver and
 * ship terminal reports. Run as
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
  const outcome = (inputs: Record<string, string>): { delivered: boolean; reason: string; summary: string } => {
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
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { delivered: boolean; reason: string; summary: string };
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
    expect(result).toMatchObject({ delivered: false, reason: 'needs_human' });
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

  it("reports deliver's own outcome, ready or not", () => {
    const deliver = { INPUTS_ROUTE: 'deliver', INPUTS_CONTRACT: 'READY' };
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'true', INPUTS_DELIVERY: 'https://x/pull/1', INPUTS_DELIVERY_REASON: 'delivered' })
    ).toEqual({
      delivered: true,
      reason: 'delivered',
      summary: 'https://x/pull/1',
    });
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready, red: lint', INPUTS_DELIVERY_REASON: 'ci_other' })
    ).toEqual({
      delivered: false,
      reason: 'ci_other',
      summary: 'Not ready, red: lint',
    });
  });
});

describe("deliver's terminal outcome", () => {
  const outcome = (rounds: object): { ready: boolean; reason: string; pr_url: string; summary: string } => {
    const run = runPackScript('deliver/scripts/outcome', {
      inputs: { INPUTS_ROUNDS: JSON.stringify(rounds), TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { ready: boolean; reason: string; pr_url: string; summary: string };
  };

  it("reports the last round's ending with its pull request", () => {
    expect(
      outcome({ ready: true, reason: 'delivered', pr_url: PR_URL, summary: 'Round 1: delivered. all passed' })
    ).toEqual({
      ready: true,
      reason: 'delivered',
      pr_url: PR_URL,
      summary: `Ready: Round 1: delivered. all passed\n${PR_URL}`,
    });
    const blocked = outcome({ ready: false, reason: 'implement_blocked', pr_url: '', summary: 'Round 1: implement_blocked. x' });
    expect(blocked).toMatchObject({ ready: false, reason: 'implement_blocked', pr_url: '' });
    expect(blocked.summary).toBe('Not ready: Round 1: implement_blocked. x');
  });
});

describe("deliver's round", () => {
  interface Round { round: number; done: boolean; ready: boolean; reason: string; pr_url: string; prior_report: string; light_review: boolean }
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
          INPUTS_CI: 'green',
          INPUTS_CI_SUMMARY: 'all passed',
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
  });

  it('ends typed at the round cap instead of exhausting the loop', () => {
    expect(round({ INPUTS_PREVIOUS: '2', INPUTS_CI: 'pr_caused' })).toMatchObject({
      round: 3,
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
