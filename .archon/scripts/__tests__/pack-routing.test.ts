/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome and the deliver and ship terminal reports. Run as
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
  const outcome = (inputs: Record<string, string>): { delivered: boolean; summary: string } => {
    const run = runPackScript('ship/scripts/outcome', {
      inputs: {
        INPUTS_ROUTE: 'no_action',
        INPUTS_CONTRACT: 'NO_ACTION',
        INPUTS_BLOCKED_REASON: '',
        INPUTS_SUMMARY: 'triage summary',
        INPUTS_INV_VERDICT: 'null',
        INPUTS_INV_SUMMARY: 'null',
        INPUTS_PLAN_SUMMARY: 'null',
        INPUTS_DELIVERED: 'null',
        INPUTS_DELIVERY: 'null',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { delivered: boolean; summary: string };
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

  it('reports a planning stop in the planner’s words', () => {
    const result = outcome({ INPUTS_ROUTE: 'plan', INPUTS_CONTRACT: 'READY', INPUTS_PLAN_SUMMARY: 'needs a product call' });
    expect(result.summary).toStartWith('Not done: planning stopped. needs a product call');
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
      summary: 'https://x/pull/1',
    });
    expect(outcome({ ...deliver, INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready, red: lint' })).toEqual({
      delivered: false,
      summary: 'Not ready, red: lint',
    });
  });
});

describe("deliver's terminal outcome", () => {
  const outcome = (inputs: Record<string, string>): { ready: boolean; pr_url: string; summary: string } => {
    const run = runPackScript('deliver/scripts/outcome', {
      inputs: {
        INPUTS_PR: JSON.stringify(forgePrRecord()),
        INPUTS_PR_URL: 'null',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { ready: boolean; pr_url: string; summary: string };
  };

  it('reports the flipped pull request as ready on green', () => {
    expect(outcome({ INPUTS_STATE: 'green', INPUTS_CI_SUMMARY: 'all passed', INPUTS_PR_URL: PR_URL })).toEqual({
      ready: true,
      pr_url: PR_URL,
      summary: PR_URL,
    });
  });

  it('reports red as not ready, with the root cause', () => {
    const result = outcome({ INPUTS_STATE: 'red', INPUTS_CI_SUMMARY: 'lint fails in src/a.ts' });
    expect(result.ready).toBe(false);
    expect(result.pr_url).toBe(PR_URL);
    expect(result.summary).toStartWith('Not ready, red: lint fails in src/a.ts');
  });

  it('reports CI with no result as not ready, never as red', () => {
    const result = outcome({ INPUTS_STATE: 'blocked', INPUTS_CI_SUMMARY: 'awaits approval' });
    expect(result.ready).toBe(false);
    expect(result.summary).toStartWith('Not ready, CI has no result: awaits approval');
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
    expect(when('seams')).toBe('$mode.output.continuation == false');
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
