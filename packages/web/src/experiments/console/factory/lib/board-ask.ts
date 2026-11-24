/**
 * The board card as the approval card (DESIGN.md, owner change 3), decided apart from drawing
 * it: what a card with open asks says on its face, when an answer given from the board still
 * shows on the card, and where the popover holding the ask card sits beside it.
 */
import { askQuestion, askTile, type AskTile } from '../../lib/ask-card';
import type { NeedsYouItem } from '../../lib/needs-you';
import type { SettledAsks } from './answered';

/** What a board card shows for an item's open asks: the first one, and how many there are. */
export interface BoardAskFace {
  question: string;
  tile: AskTile;
  /** The line Needs you shows for it: "Recommended: <label>" when it recommends one. */
  line: string;
  count: number;
}

/**
 * The face for `asks`, in Needs you's order (`itemAsks`: newest first), so the ask the card
 * names is the one Needs you lists first for the item. Null when nothing is open.
 */
export function boardAskFace(asks: readonly NeedsYouItem[]): BoardAskFace | null {
  const [first] = asks;
  if (first === undefined) return null;
  const tile = askTile(first);
  return {
    question: askQuestion(first),
    tile,
    line: tile.recommended ? `Recommended: ${tile.label}` : tile.label,
    count: asks.length,
  };
}

/**
 * An answer to an item's last open ask, given from the board, which the card shows in place
 * of its face until the next read moves the card or the item asks something new.
 */
export interface HeldAnswer {
  label: string;
  /**
   * The run whose set of asks the answer may settle: an attention ask's asking run. Null for a
   * paused gate, whose answer resumes its run and settles no set.
   */
  askingRun: string | null;
  /** Where the card sat when it was answered (`positionOf`). */
  position: string | undefined;
  /** The item's asks that were open when it was answered. */
  open: ReadonlySet<string>;
}

export function heldAnswer(
  ask: NeedsYouItem,
  label: string,
  position: string | undefined,
  open: readonly NeedsYouItem[]
): HeldAnswer {
  return {
    label,
    askingRun: ask.kind === 'attention' ? (ask.askedIn?.runId ?? null) : null,
    position,
    open: new Set(open.map(entry => entry.ref)),
  };
}

/**
 * Whether the card still shows the answer: until a read places it somewhere else, or the item
 * holds an ask that was not open when it was answered (a new question). No timer ends it: the
 * stage it started again stays started, and the card's run line shows it running.
 */
export function answerStands(
  held: HeldAnswer,
  position: string | undefined,
  live: readonly NeedsYouItem[]
): boolean {
  if (position !== held.position) return false;
  return live.every(entry => held.open.has(entry.ref));
}

/**
 * What the card says for a held answer: "Answered · <stage> started again" once the item read
 * records the set it settled and the run that settling started, matched by the asking run;
 * until then "Answered: <label>". When the set's answers chose options the view words
 * (`answers`), the view's sentence stands in for the stage, but only when the set started one
 * run and its answers word one sentence; otherwise "Answered: <label>". The card never guesses
 * a restart.
 */
export function answeredLine(held: HeldAnswer, settled: readonly SettledAsks[]): string {
  const entry =
    held.askingRun === null
      ? undefined
      : settled.find(candidate => candidate.runId === held.askingRun && candidate.restart !== null);
  if (entry?.restart == null) return `Answered: ${held.label}`;
  const declared = [
    ...new Set(entry.asks.flatMap(ask => (ask.starts === null ? [] : [ask.starts]))),
  ];
  if (declared.length === 0) return `Answered · ${entry.restart.label} started again`;
  return declared.length === 1 && entry.restarts === 1
    ? `Answered · ${declared[0] ?? ''}`
    : `Answered: ${held.label}`;
}

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Room between the card and the popover, and between the popover and the window's edge. */
const GAP = 8;
const MARGIN = 16;

/**
 * Where the popover sits for a card at `anchor`: right of it when it fits, else left of it,
 * its top level with the card's and kept inside the window with `MARGIN` to spare.
 */
export function popoverPlace(
  anchor: Rect,
  box: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number } {
  const right = anchor.right + GAP;
  const left =
    right + box.width + MARGIN <= viewport.width
      ? right
      : Math.max(MARGIN, anchor.left - GAP - box.width);
  const lowest = Math.max(MARGIN, viewport.height - MARGIN - box.height);
  return { top: Math.min(Math.max(MARGIN, anchor.top), lowest), left };
}
