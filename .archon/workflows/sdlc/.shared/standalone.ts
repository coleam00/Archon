import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QualifiedPr } from './forge.ts';
import { artifactsDir, emit, nullableJson, text } from './io.ts';
import { POLICY_DEFAULTS } from './policy-defaults.ts';
import {
  type Attention,
  attentionOptions,
  checkAttention,
  chosen,
  renderAttention,
} from './queue.ts';

export type Stage = 'plan' | 'triage' | 'review' | 'deliver' | 'ship';
export const STAGE_EFFECTS = {
  plan: ['retry', 'finish'],
  triage: ['retry', 'finish'],
  review: ['retry', 'ci', 'finish'],
  deliver: ['retry', 'replan', 'finish'],
  ship: ['retry', 'finish'],
} as const satisfies Record<Stage, readonly string[]>;
export type Effect = (typeof STAGE_EFFECTS)[Stage][number];
type Result = Readonly<Record<string, unknown>>;
export interface Decision {
  readonly done: boolean;
  readonly attention: Attention<Effect> | null;
  readonly pr: QualifiedPr | null;
}
export interface Envelope extends Decision {
  readonly result: Result;
  readonly message: string;
  readonly class: string;
  readonly options: { id: string; label: string }[];
  readonly replan: boolean;
}

export function prepare(
  previousRaw: string | undefined,
  answerRaw: string | undefined,
  workRaw: string | undefined
): void {
  const previous = nullableJson(previousRaw) as Envelope | null;
  const answer = nullableJson(answerRaw) as { decision: string; text: string } | null;
  let effect: Effect = 'retry';
  if (previous !== null) {
    if (previous.attention === null || answer === null)
      throw new Error('a continuation needs the declared attention answer');
    const choice = chosen(previous.attention, answer.decision);
    effect = choice.effect;
    appendFileSync(
      join(artifactsDir(), 'attention-decisions.md'),
      [
        `## ${new Date().toISOString()}: ${choice.id}`,
        previous.attention.what,
        choice.does,
        `Ruling: ${choice.ruling}`,
        `Answer: ${answer.text}`,
        '',
      ].join('\n\n')
    );
  }
  const original = text(workRaw);
  emit({
    effect,
    work:
      previous === null
        ? original
        : [
            original === '' ? 'The original work is the run’s trigger message.' : original,
            `Previous stage outcome: ${JSON.stringify(previous.result)}`,
            `Read the current evidence in ${artifactsDir()}, including review/report.md and ci.md when present, before overwriting a report.`,
            `Read ${join(artifactsDir(), 'attention-decisions.md')} in full before this attempt. It records the chosen rulings and complete answers; preserve the original contract and current evidence.`,
            previous.replan || effect === 'replan'
              ? 'Replan from the original contract, current PR, and review findings before delivering another batch. The latest plan.md is the work order when ready.'
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
    previous,
    replan: effect === 'replan' || (previous?.replan ?? false),
    pr: previous?.pr ?? null,
    policy_defaults: POLICY_DEFAULTS,
  });
}

interface SettleInputs {
  readonly previous: string | undefined;
  readonly effect: string | undefined;
  readonly result: string | undefined;
  readonly decision: string | undefined;
  readonly plan?: string | undefined;
  readonly replan?: string | undefined;
}

export function settle(stage: Stage, inputs: SettleInputs): void {
  const previous = nullableJson(inputs.previous) as Envelope | null;
  const attempt = nullableJson(inputs.result) as Result | null;
  const result = attempt ?? previous?.result;
  if (result === undefined) throw new Error('no stage result is available');
  if (inputs.effect === 'finish') {
    if (previous?.attention === null || previous === null)
      throw new Error('finish needs a prior decision');
    const field = stage === 'review' ? 'findings_summary' : 'summary';
    emit({
      ...previous,
      result: {
        ...result,
        [field]: `${String(result[field])}\nExplicit disposition: accepted the report and left the work as it stands. See attention-decisions.md.`,
      },
      done: true,
      attention: null,
      message: '',
      options: [],
    });
    return;
  }
  if ((stage === 'deliver' || stage === 'ship') && attempt?.reason === 'failed')
    throw new Error(`${stage} failed: ${String(attempt.summary)}`);
  const decision = nullableJson(inputs.decision) as Decision | null;
  if (decision === null) throw new Error('no decision is available');
  if (decision.done !== (decision.attention === null))
    throw new Error('a pending decision needs attention; a terminal decision must not ask');
  if (decision.attention !== null) {
    checkAttention(decision.attention);
    for (const choice of decision.attention.choices) {
      if (!(STAGE_EFFECTS[stage] as readonly Effect[]).includes(choice.effect))
        throw new Error(`${stage} does not implement ${choice.effect}`);
      if (
        choice.effect === 'ci' &&
        (stage !== 'review' || result.ready !== true || decision.pr === null)
      )
        throw new Error('CI needs a Ready PR review and a qualified target');
    }
  }
  const plan = nullableJson(inputs.plan) as {
    ready: boolean;
    summary: string;
    open_questions: string[];
  } | null;
  const pendingPlan = inputs.replan === 'true' && plan?.ready === false;
  const publicResult = pendingPlan
    ? {
        ...result,
        summary: `Delivery remains stopped while replanning: ${plan.summary}\n${plan.open_questions.join('\n')}`,
      }
    : result;
  emit({
    ...decision,
    result: publicResult,
    replan: pendingPlan,
    class: pendingPlan
      ? 'planning_question'
      : result.ready === true || result.delivered === true
        ? 'ready'
        : String(result.reason ?? result.contract ?? result.action ?? 'question'),
    message:
      decision.attention === null ? '' : renderAttention(`Standalone ${stage}`, decision.attention),
    options: decision.attention === null ? [] : attentionOptions(decision.attention),
  } satisfies Envelope);
}
