/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * late-CI attention route, the investigation's derived outcome, and ship's terminal
 * report. Run as the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { LENSES } from '../../workflows/sdlc/.shared/review-lenses';
import { runPackScript } from './deliver-checks-harness';

const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });

describe('ci-attention-route', () => {
  const route = (red: string, postFix = ''): { attention: boolean; red_cause: string } =>
    JSON.parse(
      runPackScript('deliver/scripts/ci-attention-route', {
        inputs: { INPUTS_RED_CAUSE: red, INPUTS_POST_FIX_CAUSE: postFix },
      }).stdout
    ) as { attention: boolean; red_cause: string };

  it('routes red the change is not shown to cause to the operator, unavailable evidence included', () => {
    expect(route('inherited')).toEqual({ attention: true, red_cause: 'inherited' });
    expect(route('unavailable')).toEqual({ attention: true, red_cause: 'unavailable' });
    expect(route('')).toEqual({ attention: false, red_cause: '' });
  });

  it('routes on the cause classified after the CI fix when there is one', () => {
    expect(route('', 'environment')).toEqual({ attention: true, red_cause: 'environment' });
  });
});

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

  it('reports a delivered pull request', () => {
    const result = outcome({ INPUTS_ROUTE: 'deliver', INPUTS_CONTRACT: 'READY', INPUTS_DELIVERED: 'https://x/pull/1' });
    expect(result).toEqual({ delivered: true, summary: 'https://x/pull/1' });
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
      new URL('../../workflows/sdlc/review/archon-review.yaml', import.meta.url).pathname
    ).text();
    const workflow = Bun.YAML.parse(source) as { nodes: { id: string; when?: string }[] };
    const when = (id: string): string | undefined => workflow.nodes.find(node => node.id === id)?.when;
    expect(when('seams')).toBe('$mode.output.continuation == false');
    expect(when('focused')).toBe("$mode.output.continuation == false && $INPUTS.tier == 'focused'");
  });

  it('names exactly the lens nodes the review graph declares', async () => {
    const source = await Bun.file(
      new URL('../../workflows/sdlc/review/archon-review.yaml', import.meta.url).pathname
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
