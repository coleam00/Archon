/**
 * Where an item stands, as "Items here now" says it (DESIGN.md, The map: "the run line of the
 * run working it, or the board's ... label"). It takes the Board's own words: a running item's
 * line is the board card's (`cardProgress`'s running stage and step, in the pack's words), and
 * an item with open asks reads Needs you even while a run works it (`shownChip` in
 * `item-asks.ts`, as the stage's "N need you" counts it), and every other state is the board
 * card's label (`CHIP` of its state). A merged item reads "Merged",
 * as the Board's Merged column says it. The pack's words only add where: the label of the stage the
 * item stands at, or, for an item at rest, its outcome's label.
 */
import { CHIP, standingRun } from '../../routes/board/standing';
import type { ItemRead } from '../../skills/items';
import type { CuratedView } from './curated-view';
import { outcomeLabel } from './graph-structure';
import { shownChip } from './item-asks';
import type { CardProgress } from './item-card';

/** The colour a state line takes: the state colours of the Visual standard. */
export type StateTone = 'needs-you' | 'running' | 'failed' | 'merged' | 'quiet';

export interface StateLine {
  tone: StateTone;
  text: string;
}

type Words = Pick<CuratedView, 'stageLabels' | 'outcomeLabels'>;

/**
 * The line for `read`. `running` is the board card's running stage and step, null until the
 * card's run records answer (or when no run is running), when a running item reads by the
 * chip's label and its stage. `asked` is whether the item has open asks, as its card's Needs you
 * button says; it wins over the run line.
 */
export function itemStateLine(
  view: Words,
  read: ItemRead,
  running: CardProgress['running'],
  asked: boolean
): StateLine {
  if (read.merged !== null) return { tone: 'merged', text: 'Merged' };
  const chip = shownChip(read, asked);
  const run = standingRun(read);
  const workflow = run?.pack?.workflow;
  const stage = workflow === undefined ? undefined : view.stageLabels[workflow];
  const at = (label: string): string => (stage === undefined ? label : `${label} · ${stage}`);
  const ended =
    workflow === undefined ? undefined : outcomeLabel(view, workflow, run?.outcome ?? null);
  switch (chip) {
    case 'running':
      return {
        tone: 'running',
        text:
          running === null
            ? at(CHIP.running.label)
            : `${running.stage} · ${running.step ?? 'between steps'}`,
      };
    case 'needs_you':
      return { tone: 'needs-you', text: at(CHIP.needs_you.label) };
    case 'failed':
    case 'stopped':
      return { tone: 'failed', text: at(CHIP[chip].label) };
    case 'done':
    case 'resting':
      return { tone: 'quiet', text: ended ?? at(CHIP[chip].label) };
    case 'waiting':
    case 'queued':
      return { tone: 'quiet', text: at(CHIP[chip].label) };
  }
}
