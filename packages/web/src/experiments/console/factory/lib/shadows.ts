import type { FactoryItem, FactoryItemProgress } from '../../skills/factory';
import { durationWords } from './duration';
import type { FactoryStage } from './stage-steps';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
/** A step the view declares a shadow: it decides what it would do and does nothing. */
export type FactoryShadow = NonNullable<Declaration['shadows']>[number];
/** One decision a shadow step recorded, as the server read it through the declaration. */
export type ShadowDecision = FactoryItemProgress['shadows'][number];
type DrilldownCard = NonNullable<FactoryStage['drilldown']>['phases'][number]['cards'][number];

/**
 * A shadow decision as a person reads it. `line` is what it would have done, from the
 * declaration's words; `mono` when it is the pack's own token, which the declaration does not
 * word (console code never words a pack's token itself). `detail` is the why, or the failed
 * checks' output, for a disclosure. `tally` is the line without what varies per item (a
 * check run's duration), for counting decisions.
 */
export interface ShadowWords {
  line: string;
  mono: boolean;
  detail: string | null;
  tally: string;
}

/** The shadow the view declares for a workflow's step, as the view names both. */
export function shadowOf(
  view: Declaration,
  workflow: string,
  node: string
): FactoryShadow | undefined {
  return view.shadows?.find(shadow => shadow.workflow === workflow && shadow.node === node);
}

const UNREADABLE = 'recorded nothing readable';
const plain = (line: string, detail: string | null = null): ShadowWords => ({
  line,
  mono: false,
  detail,
  tally: line,
});

type ChecksRead = Extract<ShadowDecision['read'], { reads: 'checks' }>;

/** "4 checks · all passed · 3 min", or "4 checks · 3 failed: lint, tests · 3 min". */
function checksWords(read: ChecksRead): ShadowWords {
  const count = read.results.length;
  const failed = read.results.filter(result => !result.passed);
  const seconds = read.results.flatMap(result => (result.seconds === null ? [] : [result.seconds]));
  const outcome =
    failed.length === 0
      ? 'all passed'
      : `${failed.length.toString()} failed: ${failed.map(result => result.name).join(', ')}`;
  const total = seconds.reduce((sum, value) => sum + value, 0);
  const parts = [
    `${count.toString()} ${count === 1 ? 'check' : 'checks'}`,
    outcome,
    ...(seconds.length === 0 ? [] : [durationWords(total * 1000)]),
  ];
  const tails = failed.flatMap(result =>
    result.tail === null ? [] : [`${result.name}\n${result.tail}`]
  );
  return {
    line: parts.join(' · '),
    mono: false,
    detail: tails.length === 0 ? null : tails.join('\n\n'),
    tally: failed.length === 0 ? 'all passed' : `${failed.length.toString()} failed`,
  };
}

/**
 * What a decision says, worded through its shadow's declaration. A decision read one way that
 * the declaration (edited since) now reads another way says it recorded nothing readable.
 */
export function shadowWords(
  shadow: FactoryShadow | undefined,
  decision: ShadowDecision
): ShadowWords {
  const { read } = decision;
  switch (read.reads) {
    case 'verdict': {
      const words = shadow?.reads === 'verdict' ? shadow.words[read.value] : undefined;
      return words === undefined
        ? { line: read.value, mono: true, detail: read.why, tally: read.value }
        : plain(words, read.why);
    }
    case 'checks':
      return checksWords(read);
    case 'lists': {
      if (shadow?.reads !== 'lists') return plain(UNREADABLE);
      const said = shadow.lists.flatMap((list, index) => {
        const count = read.counts[index] ?? 0;
        return count > 0 ? [`${list.words} ${count.toString()}`] : [];
      });
      return plain(said.length === 0 ? 'would do nothing' : said.join(' · '), read.why);
    }
    case 'unreadable':
      return plain(UNREADABLE);
  }
}

/** The shadows a drill-down card stands for: a shadow step one of its covers names. */
export function cardShadows(card: DrilldownCard, view: Declaration): FactoryShadow[] {
  return (view.shadows ?? []).filter(shadow =>
    card.covers.some(
      cover => cover.workflow === shadow.workflow && cover.steps.includes(shadow.node)
    )
  );
}

/**
 * The shadow steps a stage holds: those its drill-down's cards cover. Read from the drill-down
 * alone, so a step belongs to the stage whose card covers it, as the coverage check holds each
 * real step to one card.
 */
export function stageShadows(stage: FactoryStage, view: Declaration): FactoryShadow[] {
  return (stage.drilldown?.phases ?? []).flatMap(phase =>
    phase.cards.flatMap(card => cardShadows(card, view))
  );
}

/** What a shadow badge marks, said once wherever it needs saying. */
export const SHADOW_MEANS = 'decides what it would do and does nothing';

/** What the map knows of the items: their read, or why there is none yet. */
export type ShadowItems = readonly FactoryItem[] | 'loading' | 'failed';

/**
 * A stage's shadow steps as the map says them, one line each: the step's label and what it
 * decided lately ("Project checks · last 5: all passed ×5"), or that it has decided nothing
 * yet. Before the items are read it says "…", and "could not be read" once the read failed,
 * never "nothing decided yet" early (as the details' items list does). Empty when the stage
 * holds none.
 */
export function stageShadowLines(
  stage: FactoryStage,
  view: Declaration,
  items: ShadowItems
): string[] {
  // One line per label: a step two workflows run (the project checks, in deliver and in
  // stage-check) is one step to a person, and its decisions are tallied together.
  const byLabel = new Map<string, FactoryShadow[]>();
  for (const shadow of stageShadows(stage, view))
    byLabel.set(shadow.label, [...(byLabel.get(shadow.label) ?? []), shadow]);
  return [...byLabel].map(([label, shadows]) => {
    const said =
      items === 'loading'
        ? '…'
        : items === 'failed'
          ? 'could not be read'
          : (recentTally(items, shadows) ?? 'nothing decided yet');
    return `${label} · ${said}`;
  });
}

const newestFirst = (a: ShadowDecision, b: ShadowDecision): number =>
  Date.parse(b.decidedAt) - Date.parse(a.decidedAt);

/**
 * The newest `n` decisions of any of `shadows` across the items (each item's newest one per
 * shadow), counted by what they say: "last 5: would ask you first ×4 · would start on its own
 * ×1". Null when no item has one.
 */
export function recentTally(
  items: readonly FactoryItem[],
  shadows: readonly FactoryShadow[],
  n = 5
): string | null {
  const of = (decision: ShadowDecision): FactoryShadow | undefined =>
    shadows.find(shadow => decision.workflow === shadow.workflow && decision.node === shadow.node);
  const recent = items
    .flatMap(item => item.progress?.shadows ?? [])
    .flatMap(decision => {
      const shadow = of(decision);
      return shadow === undefined ? [] : [{ decision, shadow }];
    })
    .sort((a, b) => newestFirst(a.decision, b.decision))
    .slice(0, n);
  if (recent.length === 0) return null;
  const counts = new Map<string, number>();
  for (const { decision, shadow } of recent) {
    const { tally } = shadowWords(shadow, decision);
    counts.set(tally, (counts.get(tally) ?? 0) + 1);
  }
  const said = [...counts].map(([words, count]) => `${words} ×${count.toString()}`).join(' · ');
  return `last ${recent.length.toString()}: ${said}`;
}

/**
 * The shadow line a board card shows: on an item no run works now, its newest decision of a
 * verdict shadow whose workflow the card's stage lists. Null otherwise.
 */
export function boardShadowLine(
  item: FactoryItem,
  stage: FactoryStage | null,
  view: Declaration
): ShadowWords | null {
  const progress = item.progress;
  if (progress === null || progress.running !== null || stage === null) return null;
  const [newest] = progress.shadows
    .filter(
      decision =>
        stage.workflows.includes(decision.workflow) &&
        shadowOf(view, decision.workflow, decision.node)?.reads === 'verdict'
    )
    .sort(newestFirst);
  if (newest === undefined) return null;
  return shadowWords(shadowOf(view, newest.workflow, newest.node), newest);
}
