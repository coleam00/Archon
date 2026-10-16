/**
 * The attention pause a public stage adds around its block: every public entry is the
 * same wrapper over its block's signature, and the `answer` and `settle` scripts carry
 * a pass from the agent's decision to the person's answer and on to the next pass.
 * The engine's loop between them was proved on a real run when the pause was built;
 * dry-run fixtures cannot reach a second pass, so these tests chain the scripts the
 * way the loop does: one pass's settle output is the next pass's `previous`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STAGE_EFFECTS,
  type Settled,
  type StageDecision,
  type StageEffect,
} from '../../workflows/sdlc/.shared/attention';
import { PACK, PR, PR_URL, packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const STAGES = ['deliver', 'plan', 'triage', 'review', 'ship'] as const;

interface RawNode {
  id: string;
  include?: string;
  with?: Record<string, unknown>;
  output_format?: { properties?: Record<string, unknown> };
  loop_group?: { nodes: RawNode[] };
}
interface RawWorkflow {
  inputs?: Record<string, unknown>;
  outcome_field?: string;
  nodes: RawNode[];
}

const read = (path: string): RawWorkflow =>
  Bun.YAML.parse(readFileSync(join(PACK, path), 'utf8')) as RawWorkflow;

describe('every public stage is the shared wrapper over its block', () => {
  const entries = STAGES.map(stage => ({
    stage,
    entry: read(`${stage}-entry/archon-${stage}.yaml`),
    block: read(`${stage}/archon-${stage}-block.yaml`),
  }));
  const node = (nodes: readonly RawNode[], id: string): RawNode => {
    const found = nodes.find(entry => entry.id === id);
    if (found === undefined) throw new Error(`no node ${id}`);
    return found;
  };

  it.each(entries)('archon-$stage takes and returns what its block does', ({ stage, entry, block }) => {
    expect(entry.inputs).toEqual(block.inputs);
    expect(entry.outcome_field).toBe(block.outcome_field);
    const body = node(entry.nodes, 'cycle').loop_group?.nodes ?? [];
    const run = node(body, 'stage');
    expect(run.include).toBe(`archon-${stage}-block`);
    expect(Object.keys(run.with ?? {}).sort()).toEqual(Object.keys(block.inputs ?? {}).sort());
    expect(node(body, 'attend').with?.stage).toBe(`archon-${stage}`);
    const result = node(entry.nodes, 'result');
    expect(Object.keys(result.output_format?.properties ?? {})).toEqual([String(block.outcome_field)]);
  });

  it('the loop around the block is the same in every entry', () => {
    const shape = ({ entry }: (typeof entries)[number]) => {
      const cycle = structuredClone(node(entry.nodes, 'cycle'));
      for (const body of cycle.loop_group?.nodes ?? []) {
        if (body.id === 'stage') delete body.include;
        if (body.id === 'stage') delete body.with;
        if (body.id === 'attend') delete body.with?.stage;
      }
      const result = structuredClone(node(entry.nodes, 'result'));
      delete result.output_format;
      return { cycle, result };
    };
    for (const entry of entries.slice(1)) expect(shape(entry)).toEqual(shape(entries[0]));
  });

  it('a pass hands its answer text to the stage after the work it was given', () => {
    for (const { entry } of entries) {
      const work = Object.values(node(node(entry.nodes, 'cycle').loop_group?.nodes ?? [], 'stage').with ?? {});
      expect(work).toContainEqual(expect.stringMatching(
        /^\$INPUTS\.\w+\n\$LOOP_PREV\.attend__settle\.output\.brief\n\$LOOP_PREV\.attend__ask\.output\.text$/
      ));
    }
  });
});

it("the decide agent's choices are the effects the scripts act on", () => {
  const decide = read('attention/archon-attention.yaml').nodes.find(node => node.id === 'decide');
  const attention = (decide?.output_format?.properties?.attention ?? {}) as {
    properties: { recommendation: { properties: { choice: { enum: string[] } } }; choices: { items: { properties: { id: { enum: string[] } } } } };
  };
  expect(attention.properties.recommendation.properties.choice.enum).toEqual([...STAGE_EFFECTS]);
  expect(attention.properties.choices.items.properties.id.enum).toEqual([...STAGE_EFFECTS]);
});

const OUTCOME = { ready: false, reason: 'round_cap', pr_url: PR_URL, ci_rerun: 'none', summary: 'Not ready' };
const LATER = { ...OUTCOME, ready: true, reason: 'delivered', summary: 'Ready' };

type Choices = NonNullable<StageDecision['attention']>['choices'];

function ask(choices: Choices, recommended: StageEffect, pullRequest: StageDecision['pull_request'] = null): StageDecision {
  return {
    decision: 'ask',
    reason: 'the rounds ran out',
    pull_request: pullRequest,
    attention: {
      what: 'Delivery ran out of rounds',
      why: 'The pull request stays a draft',
      recommendation: { choice: recommended, why: 'mechanical', evidence: 'ci.md', confidence: 'medium', would_change: 'a design question' },
      choices,
      if_unanswered: 'The run stays paused',
      links: [PR_URL],
    },
  };
}

const RERUN = { id: 'rerun', label: 'Deliver again', does: 'Runs another batch' } as const;
const READY = { id: 'ready', label: 'Mark it ready', does: 'Takes it out of draft' } as const;
const FINISH = { id: 'finish', label: 'Leave it', does: 'Ends the run' } as const;

function settle(decision: StageDecision | null, answered: unknown): ScriptRun {
  return runPackScript('attention/scripts/settle', {
    inputs: {
      INPUTS_STAGE: 'archon-deliver',
      INPUTS_ANSWERED: JSON.stringify(answered),
      INPUTS_DECISION: JSON.stringify(decision),
    },
  });
}

function settled(decision: StageDecision): Settled {
  const run = settle(decision, { judge: true, outcome: OUTCOME, applied: '' });
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Settled;
}

function answer(previous: Settled | null, choice: string | null, outcome: unknown, gh = {}): ScriptRun {
  return runPackScript('attention/scripts/answer', {
    source: 'gh',
    gh,
    inputs: {
      INPUTS_OUTCOME: outcome === null ? '' : JSON.stringify(outcome),
      INPUTS_PREVIOUS: previous === null ? '' : JSON.stringify(previous),
      INPUTS_ANSWER: choice === null ? '' : JSON.stringify({ decision: choice, text: 'my note' }),
    },
  });
}

describe('settle', () => {
  it('ends the loop on a done decision, with nothing asked', () => {
    expect(settled({ decision: 'done', reason: 'ready', pull_request: null, attention: null })).toEqual({
      done: true, outcome: OUTCOME, message: '', options: [], asked: null, brief: '',
    });
  });

  it('renders every field of an asked item and offers its choices', () => {
    const out = settled(ask([RERUN, FINISH], 'rerun'));
    expect(out.done).toBe(false);
    expect(out.outcome).toEqual(OUTCOME);
    expect(out.options).toEqual([{ id: 'rerun', label: 'Deliver again' }, { id: 'finish', label: 'Leave it' }]);
    for (const field of [
      '**What it is.** Delivery ran out of rounds',
      '**Why it matters.** The pull request stays a draft',
      '**Recommendation: `rerun`** (medium confidence). mechanical',
      'Evidence: ci.md',
      'What would change it: a design question',
      '- `rerun` (Deliver again): Runs another batch',
      '**If nobody answers.** The run stays paused',
      `- ${PR_URL}`,
    ]) expect(out.message).toContain(field);
    expect(out.brief).toContain(out.message);
    expect(out.brief.endsWith('(empty when they wrote none):\n')).toBe(true);
  });

  it('settles a pass whose stage did not run on the outcome the answer kept', () => {
    const run = settle(null, { judge: false, outcome: OUTCOME, applied: 'kept' });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ done: true, outcome: OUTCOME, message: '' });
  });

  it.each([
    ['a done decision with an item', { ...ask([RERUN, FINISH], 'rerun'), decision: 'done' as const }, 'a done decision carries an attention item'],
    ['an ask with no item', { decision: 'ask' as const, reason: 'r', pull_request: null, attention: null }, 'an ask decision carries no attention item'],
    ['an item a person cannot end', ask([RERUN], 'rerun'), 'offers no `finish` choice'],
    ['`ready` with no pull request', ask([READY, FINISH], 'ready'), 'offers `ready` but names no pull request'],
    ['a recommendation never offered', ask([RERUN, FINISH], 'ready'), 'the recommended choice "ready" is not offered'],
    ['a judged pass with no decision', null, 'no decision was made on its ending'],
  ])('refuses %s', (_name, decision, message) => {
    const run = settle(decision, { judge: true, outcome: OUTCOME, applied: '' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(message);
  });
});

describe('answer', () => {
  it('judges the first pass on its own outcome', () => {
    const run = answer(null, null, OUTCOME);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ judge: true, outcome: OUTCOME, applied: '' });
  });

  it('rerun: the stage ran again, and its new outcome is judged', () => {
    const run = answer(settled(ask([RERUN, FINISH], 'rerun')), 'rerun', LATER);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ judge: true, outcome: LATER });
    expect(run.gh).toEqual([]);
  });

  it('finish: the outcome the item was about stands, with no write', () => {
    const run = answer(settled(ask([RERUN, FINISH], 'rerun')), 'finish', null);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ judge: false, outcome: OUTCOME });
    expect(run.gh).toEqual([]);
  });

  it('ready: takes the pull request out of draft, reads it back, and keeps the outcome', () => {
    const run = answer(settled(ask([READY, FINISH], 'ready', PR)), 'ready', null, { pr: { isDraft: true } });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ judge: false, outcome: OUTCOME, applied: `${PR_URL} is ready for review.` });
    expect(run.gh).toContain(`pr ready 42 --repo ${PR.repo.host}/${PR.repo.path}`);
  });

  it('ready fails when the pull request does not read back out of draft', () => {
    const run = answer(settled(ask([READY, FINISH], 'ready', PR)), 'ready', null, { pr: { isDraft: true }, writeLost: true });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('does not report an open pull request ready for review');
  });

  it('refuses an answer the item never offered', () => {
    const run = answer(settled(ask([RERUN, FINISH], 'rerun')), 'ready', null);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the answer "ready" is not one of the choices');
  });
});
