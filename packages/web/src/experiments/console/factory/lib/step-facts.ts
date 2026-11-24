/**
 * What the step page's aside says about one step (owner change 7 of 2026-11-21), as rows of a
 * definition grid. Each row comes from something the console already reads: the engine's step
 * read, and the view file. A row whose source says nothing is left out, never guessed.
 */
import type { FactoryWorkflow } from '../../skills/factory';
import { conditionText } from './step-graph';
import { KIND_WORDS } from './step-kinds';
import { referenceLabel } from './prompt-references';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type FactoryStep = FactoryWorkflow['steps'][number];
type FactoryGroup = FactoryWorkflow['groups'][number];
type DrilldownCard = NonNullable<
  Declaration['stages'][number]['drilldown']
>['phases'][number]['cards'][number];
type Meaning = NonNullable<Declaration['verdicts']>[string][string][string];

/**
 * One row. `chips` are short names (an input, an outcome) drawn as chips; `lines` are drawn one
 * to a line; `text` is one value. `title` holds what a reader can hover for: the raw expression.
 */
export interface StepFact {
  key: 'kind' | 'model' | 'when' | 'reads' | 'reads-steps' | 'outcomes' | 'then';
  label: string;
  text?: string;
  chips?: string[];
  /** Outcomes: what each does in words, then the outcome id as the pack writes it. */
  outcomes?: { words: string; id: string }[];
  lines?: string[];
  title?: string;
  /** The value is engine text as written (an expression no parser took). */
  mono?: boolean;
}

/** The model or tier list in words: `@lander` reads "Lander tier"; ", else " joins them. */
export function modelWords(model: readonly string[]): string {
  return model
    .map(entry =>
      entry.startsWith('@') ? `${entry.charAt(1).toUpperCase()}${entry.slice(2)} tier` : entry
    )
    .join(', else ');
}

/** What an outcome's declared meaning does, in words. */
const MEANING_WORDS: Record<Meaning, string> = {
  approved: 'Approves it',
  returned: 'Sends it back',
  asked: 'Asks you',
};

/** A loop by name, with the most rounds it runs: "Rounds, up to 3 rounds". */
export function loopWords(name: string, maxRounds: number | null): string {
  return maxRounds === null ? name : `${name}, up to ${maxRounds.toString()} rounds`;
}

/**
 * The outcomes the view file declares for this step, with what each means: its `verdicts`, and
 * the `returns` and `approves` that name it. Only declared ones: a `when:` that compares this
 * step's output drops the field it reads, so its values are not provably outcomes.
 */
function declaredOutcomes(
  view: Declaration,
  workflow: string,
  key: string
): { words: string; id: string }[] {
  const meanings = new Map<string, Meaning>(Object.entries(view.verdicts?.[workflow]?.[key] ?? {}));
  const point = (list: Declaration['returns'], meaning: Meaning): void => {
    for (const entry of list ?? [])
      if (entry.workflow === workflow && entry.node === key) meanings.set(entry.outcome, meaning);
  };
  point(view.returns, 'returned');
  point(view.approves, 'approved');
  return [...meanings].map(([id, meaning]) => ({ words: MEANING_WORDS[meaning], id }));
}

/**
 * The aside's facts for `step` of `workflow`. `stepName` is `stepLabel` for that workflow; the
 * workflow's steps and loop groups say what starts after this one.
 */
export function stepFacts({
  step,
  view,
  workflow,
  steps,
  groups,
  stepName,
}: {
  step: FactoryStep;
  view: Declaration;
  workflow: string;
  steps: readonly FactoryStep[];
  groups: readonly FactoryGroup[];
  stepName: (key: string) => string;
}): StepFact[] {
  const facts: StepFact[] = [
    {
      key: 'kind',
      label: 'Kind',
      text:
        step.includedFrom === null
          ? KIND_WORDS[step.kind]
          : `${KIND_WORDS[step.kind]}, included from ${step.includedFrom}`,
    },
  ];
  const runsCode = step.kind === 'bash' || step.kind === 'script';
  if (!runsCode && step.model !== null)
    facts.push({ key: 'model', label: 'Runs on', text: modelWords(step.model) });
  if (step.when !== null) {
    const condition = conditionText(step.whenClauses, stepName);
    // An expression the engine's parser did not take shows as written rather than not at all.
    facts.push(
      condition === null
        ? { key: 'when', label: 'Runs when', text: step.when, mono: true }
        : { key: 'when', label: 'Runs when', text: condition, title: step.when }
    );
  }
  const inputs = step.references.filter(ref => ref.kind === 'input');
  if (inputs.length > 0)
    facts.push({
      key: 'reads',
      label: 'Inputs it reads',
      chips: inputs.map(ref => referenceLabel(ref, stepName)),
    });
  const outputs = step.references.filter(ref => ref.kind !== 'input');
  if (outputs.length > 0)
    facts.push({
      key: 'reads-steps',
      label: 'Reads from steps',
      lines: outputs.map(ref => referenceLabel(ref, stepName)),
    });
  const outcomes = declaredOutcomes(view, workflow, step.key);
  if (outcomes.length > 0) facts.push({ key: 'outcomes', label: 'Can end with', outcomes });
  const then = thenStarts(step, steps, groups, stepName);
  if (then.length > 0) facts.push({ key: 'then', label: 'Then starts', lines: then });
  return facts;
}

/** Whether a `when:` compares this step's result. */
const readsStep = (whenClauses: FactoryStep['whenClauses'], key: string): boolean =>
  whenClauses?.some(clause =>
    clause.some(atom => atom.reads.kind === 'step' && atom.reads.key === key)
  ) === true;

/** The innermost loop group a step runs in, or null outside any loop. */
function loopOf(step: FactoryStep, groups: readonly FactoryGroup[]): string | null {
  const byId = new Map(groups.map(group => [group.id, group]));
  for (let at = step.group; at !== null; at = byId.get(at)?.parent ?? null)
    if (byId.get(at)?.kind === 'loop') return at;
  return null;
}

/**
 * What starts after `step`, one line each, from what the workflow read already holds:
 * - a step or loop whose `dependsOn` names it ("End, after this step"), with its condition when
 *   that condition reads this step;
 * - a step whose condition reads this step's result without waiting on it: in deliver, the fix
 *   step that a Verdict of "return" starts. When that step comes earlier in the same loop, it
 *   starts in the next round ("Fixes what came back, next round, if Verdict = return").
 */
function thenStarts(
  step: FactoryStep,
  steps: readonly FactoryStep[],
  groups: readonly FactoryGroup[],
  stepName: (key: string) => string
): string[] {
  const after = (name: string, whenClauses: FactoryStep['whenClauses']): string => {
    const condition = readsStep(whenClauses, step.key)
      ? conditionText(whenClauses, stepName)
      : null;
    return condition === null ? `${name}, after this step` : `${name}, ${condition}`;
  };
  const waiting = steps.filter(other => other.dependsOn.includes(step.key));
  const loops = groups.filter(group => group.kind === 'loop' && group.dependsOn.includes(step.key));
  const at = steps.indexOf(step);
  const loop = loopOf(step, groups);
  const onResult = steps.filter(
    other => other !== step && !waiting.includes(other) && readsStep(other.whenClauses, step.key)
  );
  return [
    ...waiting.map(other => after(stepName(other.key), other.whenClauses)),
    ...loops.map(group => after(loopWords(stepName(group.id), group.maxRounds), group.whenClauses)),
    ...onResult.map(other => {
      const nextRound =
        loop !== null && loopOf(other, groups) === loop && steps.indexOf(other) < at;
      const condition = conditionText(other.whenClauses, stepName) ?? '';
      return `${stepName(other.key)}, ${nextRound ? 'next round, ' : ''}${condition}`;
    }),
  ];
}

/**
 * The drill-down card that covers `key` of `workflow`: its plain-words line is what the step
 * does. `check:factory-view` holds each real step to at most one card.
 */
export function coveringCard(
  view: Declaration,
  workflow: string,
  key: string
): DrilldownCard | undefined {
  for (const stage of view.stages)
    for (const phase of stage.drilldown?.phases ?? [])
      for (const card of phase.cards)
        if (card.covers.some(cover => cover.workflow === workflow && cover.steps.includes(key)))
          return card;
  return undefined;
}
