/**
 * Each colour group's look and words, one record for every place that draws a group: the
 * board's column headers and columns, the item page's panels and journey strip, the map's
 * cards and its legend. Keyed by `ColumnTone`, the stage groups the schema declares plus the merged column's
 * own, so a group the schema gains fails type-check here until it has a colour. The colours are
 * green, teal and warm, none purple or pink (owner change 1 of 2026-11-19), and keep clear of
 * the status colours the chips use (running, needs you); the merged column takes the done
 * colour (Visual standard, rule 5). `tones.test.ts` resolves each and holds both.
 */
import type { CSSProperties } from 'react';
import { GitMerge, GitPullRequest, Inbox, type LucideIcon, SearchCode, Wrench } from 'lucide-react';
import type { ToneColor } from './document';
import type { ColumnTone } from './lib/board-columns';

export interface Tone {
  color: ToneColor;
  /** The card's kind label, in the Label role. */
  kind: string;
  /** What the legend says the colour means. */
  words: string;
  Icon: LucideIcon;
}

export const TONES: Record<ColumnTone, Tone> = {
  intake: { color: 'var(--tone-intake)', kind: 'Intake', words: 'Taking work in', Icon: Inbox },
  build: { color: 'var(--node-wait)', kind: 'Build', words: 'Building the change', Icon: Wrench },
  check: {
    color: 'var(--node-approval)',
    kind: 'Check',
    words: 'Checking it',
    Icon: SearchCode,
  },
  land: { color: 'var(--node-script)', kind: 'Merge', words: 'Merging it', Icon: GitPullRequest },
  merged: { color: 'var(--success)', kind: 'Merged', words: 'Merged', Icon: GitMerge },
};

/** A column's or card's colour (rule 5). */
export const toneColor = (tone: ColumnTone): ToneColor => TONES[tone].color;

/**
 * A `.factory-card`'s colour (theme.css): its tint under the accent bar and, when lit, its
 * light. Any card on the canvases takes one, a group's or a kind's.
 */
export const cardTone = (color: string): CSSProperties =>
  ({ '--card-tone': color }) as CSSProperties;
