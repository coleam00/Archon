/**
 * The attention pause a public stage entry adds around its block (`archon-attention`).
 *
 * An entry runs its stage, then the `decide` agent judges whether the ending has a
 * next step. When it does not, the run pauses on one attention item whose answer is
 * one of the effects below, and the entry's next pass acts on it: `answer` applies
 * the previous pass's answer, and `settle` checks the agent's decision and renders
 * the item. A composing caller includes the stage's block instead and owns whatever
 * follows the stage's ending, so it never sees this pause.
 */

import type { QualifiedPr } from './forge.ts';
import {
  type Attention,
  attentionOptions,
  checkAttention,
  chosen,
  type Recommendation,
  renderAttention,
} from './queue.ts';

/**
 * What a person's answer does. Each is also the id of the choice that carries it, so
 * the entry gates its next pass on the answer's id alone.
 */
export const STAGE_EFFECTS = ['rerun', 'ready', 'finish'] as const;
export type StageEffect = (typeof STAGE_EFFECTS)[number];

export interface StageChoice {
  readonly id: StageEffect;
  readonly label: string;
  readonly does: string;
}

/** The `decide` agent's answer, as its output_format certified it. */
export interface StageDecision {
  readonly decision: 'done' | 'ask';
  readonly reason: string;
  /** The pull request the stage worked on, which a `ready` answer takes out of draft. */
  readonly pull_request: QualifiedPr | null;
  readonly attention: {
    readonly what: string;
    readonly why: string;
    readonly recommendation: Recommendation;
    readonly choices: readonly StageChoice[];
    readonly if_unanswered: string;
    readonly links: readonly string[];
  } | null;
}

/** The item a pass raised, and what the next pass needs to act on its answer. */
export interface Asked {
  readonly attention: Attention<StageEffect>;
  readonly pull_request: QualifiedPr | null;
}

/** `settle`'s output; the entry's loop ends on `done`, and its result is `outcome`. */
export interface Settled {
  readonly done: boolean;
  /** The stage's typed outcome, as its last pass left it. */
  readonly outcome: unknown;
  /** The attention message; empty when nothing is asked. */
  readonly message: string;
  readonly options: readonly { id: string; label: string }[];
  readonly asked: Asked | null;
  /**
   * What the stage's next pass starts from if the person answers `rerun`; the entry
   * appends the answer's own text after it.
   */
  readonly brief: string;
}

/** `answer`'s output. */
export interface Answered {
  /** Whether the stage ran this pass and did not fail, so its ending needs judging. */
  readonly judge: boolean;
  readonly outcome: unknown;
  /** What the previous pass's answer did; empty when there was none. */
  readonly applied: string;
}

/**
 * The answer to the previous pass's item, with the item and the outcome that pass
 * settled on; null on the first pass.
 */
export function previousAnswer(
  previous: string,
  answer: string
): { asked: Asked; choice: StageEffect; outcome: unknown } | null {
  if (answer.trim() === '') return null;
  const settled = JSON.parse(previous) as Settled;
  if (settled.asked === null) {
    throw new Error('the previous pass recorded an answer but raised no attention item');
  }
  const { decision } = JSON.parse(answer) as { decision: string };
  return {
    asked: settled.asked,
    choice: chosen(settled.asked.attention, decision).effect,
    outcome: settled.outcome,
  };
}

/**
 * Check the agent's decision and turn an `ask` into the item a person answers.
 *
 * Refuses an item a person could not act on: one without `finish`, so the run can
 * always end with its outcome as it stands, or one offering `ready` with no pull
 * request to take out of draft.
 */
export function settle(stage: string, outcome: unknown, decision: StageDecision): Settled {
  if (decision.decision === 'done') {
    if (decision.attention !== null) throw new Error('a done decision carries an attention item');
    return { done: true, outcome, message: '', options: [], asked: null, brief: '' };
  }
  if (decision.attention === null) throw new Error('an ask decision carries no attention item');
  const attention: Attention<StageEffect> = {
    ...decision.attention,
    choices: decision.attention.choices.map(choice => ({ ...choice, effect: choice.id, ruling: '' })),
  };
  checkAttention(attention);
  const offered = attention.choices.map(choice => choice.effect);
  if (!offered.includes('finish')) throw new Error('the attention item offers no `finish` choice');
  if (offered.includes('ready') && decision.pull_request === null) {
    throw new Error('the attention item offers `ready` but names no pull request');
  }
  const message = renderAttention(`${stage}: a person decides how this run continues`, attention);
  return {
    done: false,
    outcome,
    message,
    options: attentionOptions(attention),
    asked: { attention, pull_request: decision.pull_request },
    brief: [
      '',
      'This run already stopped once at this stage and asked a person:',
      '',
      message,
      '',
      'They chose `rerun`: run this stage again. Their note follows, and where it conflicts with the work above, the note decides (empty when they wrote none):',
      '',
    ].join('\n'),
  };
}
