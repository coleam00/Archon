/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome, deliver's correction round, and the deliver and
 * ship terminal reports. Run as
 * the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { LENSES } from '../../workflows/sdlc/.shared/review-lenses';
import { PR_URL, forgePrRecord, runPackScript } from './deliver-checks-harness';

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
    expect(outcome({ ...deliver, INPUTS_DELIVERED: 'true', INPUTS_DELIVERY: 'https://x/pull/1' })).toEqual({
      delivered: true,
      reason: 'delivered',
      summary: 'https://x/pull/1',
    });
    expect(outcome({ ...deliver, INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready, red: lint' })).toEqual({
      delivered: false,
      reason: 'not_ready',
      summary: 'Not ready, red: lint',
    });
  });
});

describe("deliver's terminal outcome", () => {
  const outcome = (inputs: Record<string, string>): { ready: boolean; pr_url: string; summary: string } => {
    const run = runPackScript('deliver/scripts/outcome', {
      inputs: {
        INPUTS_PR: JSON.stringify(forgePrRecord()),
        INPUTS_REVIEW_ACTION: 'none',
        INPUTS_FIRST_STATE: 'null',
        INPUTS_FIRST_SUMMARY: 'null',
        INPUTS_ACTION: 'null',
        INPUTS_STATE: 'null',
        INPUTS_CI_SUMMARY: 'null',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { ready: boolean; pr_url: string; summary: string };
  };

  it('reports the pull request as ready when CI is green after the initial review', () => {
    expect(outcome({ INPUTS_FIRST_STATE: 'green', INPUTS_FIRST_SUMMARY: 'all passed' })).toEqual({
      ready: true,
      pr_url: PR_URL,
      summary: PR_URL,
    });
  });

  it('reads the last correction round over the initial CI check', () => {
    const result = outcome({
      INPUTS_FIRST_STATE: 'red',
      INPUTS_FIRST_SUMMARY: 'the change broke a test',
      INPUTS_ACTION: 'none',
      INPUTS_STATE: 'green',
      INPUTS_CI_SUMMARY: 'all passed',
    });
    expect(result.ready).toBe(true);
  });

  it('reports red the change did not cause as not ready, with the root cause', () => {
    const result = outcome({ INPUTS_FIRST_STATE: 'red', INPUTS_FIRST_SUMMARY: 'the base fails the same way' });
    expect(result.ready).toBe(false);
    expect(result.pr_url).toBe(PR_URL);
    expect(result.summary).toStartWith('Not ready, red: the base fails the same way');
  });

  it('reports a review that ended asking for a replan as not ready, without CI', () => {
    const result = outcome({ INPUTS_REVIEW_ACTION: 'correct', INPUTS_ACTION: 'replan', INPUTS_STATE: '' });
    expect(result.ready).toBe(false);
    expect(result.summary).toStartWith('Not ready, the review asks for a replan');
  });

  it('reports a blocked pull request as not ready, never as red', () => {
    const result = outcome({ INPUTS_FIRST_STATE: 'blocked', INPUTS_FIRST_SUMMARY: 'awaits approval' });
    expect(result.ready).toBe(false);
    expect(result.summary).toStartWith('Not ready, blocked: awaits approval');
  });
});

describe("deliver's correction round", () => {
  const round = (inputs: Record<string, string>): { again: boolean; action: string; state: string } =>
    JSON.parse(
      runPackScript('deliver/scripts/round', {
        inputs: {
          INPUTS_ACTION: 'none',
          INPUTS_DISCOVERIES: '[]',
          INPUTS_STATE: 'null',
          INPUTS_CAUSED_BY_CHANGE: 'null',
          INPUTS_CI_SUMMARY: 'null',
          ...inputs,
        },
      }).stdout
    ) as { again: boolean; action: string; state: string };

  it('asks for another round when the review wants corrections, before CI runs', () => {
    expect(round({ INPUTS_ACTION: 'correct' })).toMatchObject({ again: true, state: '' });
  });

  it('asks for another round only for a red the change caused', () => {
    expect(round({ INPUTS_STATE: 'red', INPUTS_CAUSED_BY_CHANGE: 'true' }).again).toBe(true);
    expect(round({ INPUTS_STATE: 'red', INPUTS_CAUSED_BY_CHANGE: 'false' }).again).toBe(false);
    expect(round({ INPUTS_STATE: 'green', INPUTS_CAUSED_BY_CHANGE: 'false' }).again).toBe(false);
  });

  it('ends the rounds on a replan without CI', () => {
    expect(round({ INPUTS_ACTION: 'replan' })).toMatchObject({ again: false, action: 'replan' });
  });
});

describe('lens-status', () => {
  const lensStatus = (
    entries: object[],
    inputs: Record<string, string> = {}
  ): { required: string[]; missing: string[] } => {
    const listing = {
      runId: 'run',
      artifactsByType: {
        'review-coverage': [{ nodeId: 'review__coverage', path: 'coverage.json' }],
        'review-lens': entries.filter(entry => !('structure' in entry)),
        'structure-review': entries.filter(entry => 'structure' in entry),
      },
      errors: [],
    };
    const run = runPackScript('review/scripts/lens-status', {
      inputs: {
        INPUTS_CONTINUATION: 'false',
        INPUTS_TIER: 'full',
        INPUTS_ERRORS: 'true',
        INPUTS_DOCS: 'false',
        INPUTS_SCOPE_DOCS: 'false',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ARCHON_NODE_EXECUTION: JSON.stringify({ path: 'review__lens-status', invocation: { loopPath: [] } }),
        ...inputs,
      },
      artifacts: {
        'listing.json': JSON.stringify(listing),
        'coverage.json': JSON.stringify({ full: true, errors: true, docs: false, lenses: [] }),
      },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { required: string[]; missing: string[] };
  };
  const lens = (nodeId: string, extra: object = {}): object => ({ nodeId, path: `${nodeId}.md`, ...extra });

  it('names every enabled lens that left no completed artifact', () => {
    const status = lensStatus([
      lens('review__seams'),
      lens('review__tests'),
      lens('review__simplify__simplify', { structure: true }),
    ]);
    expect(status.required).toEqual(['seams', 'code', 'tests', 'simplify', 'errors']);
    expect(status.missing).toEqual(['code', 'errors']);
  });

  it("never counts another review's or another loop iteration's lens", () => {
    const status = lensStatus([
      lens('review__seams'),
      lens('recheck__code'),
      lens('review__tests', { loopGroupPath: [{ groupId: 'corrections', iteration: 1 }] }),
      lens('review__simplify__simplify', { structure: true }),
      lens('review__errors'),
    ]);
    expect(status.missing).toEqual(['code', 'tests']);
  });

  it('requires nothing on a continuation round', () => {
    expect(lensStatus([], { INPUTS_CONTINUATION: 'true' })).toMatchObject({ required: [], missing: [] });
  });
});

describe('review lens gating', () => {
  // Seams and focused gate before the coverage node exists, so their `when:` restates
  // the first two lines of enabledLenses; this holds the two in step.
  it("keeps seams' and focused's gates in step with enabledLenses", async () => {
    const source = await Bun.file(
      join(import.meta.dir, '../../workflows/sdlc/review/archon-review.yaml')
    ).text();
    const workflow = Bun.YAML.parse(source) as { nodes: { id: string; when?: string }[] };
    const when = (id: string): string | undefined => workflow.nodes.find(node => node.id === id)?.when;
    expect(when('seams')).toBe("$mode.output.continuation == false && $INPUTS.seams != 'false'");
    expect(when('focused')).toBe("$mode.output.continuation == false && $INPUTS.tier == 'focused'");
  });

  it('names exactly the lens nodes the review graph declares', async () => {
    const source = await Bun.file(
      join(import.meta.dir, '../../workflows/sdlc/review/archon-review.yaml')
    ).text();
    const workflow = Bun.YAML.parse(source) as {
      nodes: { id: string; output_type?: string; include?: string }[];
    };
    const lensNodes = workflow.nodes
      .filter(node => node.output_type === 'review-lens' || node.include === 'archon-simplify')
      .map(node => node.id);
    expect<string[]>([...LENSES].sort()).toEqual(lensNodes.sort());
  });
});
