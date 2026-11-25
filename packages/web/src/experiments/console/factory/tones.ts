/**
 * Each colour group's look and words, one record for every place that draws a group: the map's
 * cards and its legend. Keyed by `ColumnTone`: the stage groups the console has a colour for,
 * the merged column's own, and `other` for a group the view names that the console does not. The colours are
 * green, teal and warm, none purple or pink (owner change 1 of 2026-11-19), and keep clear of
 * the status colours the chips use (running, needs you); the merged column takes the done
 * colour (Visual standard, rule 5), checked in the browser.
 */
import type { CSSProperties } from 'react';
import {
  Circle,
  GitMerge,
  GitPullRequest,
  Inbox,
  type LucideIcon,
  SearchCode,
  Wrench,
} from 'lucide-react';
import type { ColumnTone } from './lib/map-columns';

/** A colour token, as `var(--name)`: a group, kind or state colour from the theme. */
export type ToneColor = `var(--${string})`;

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
  other: { color: 'var(--node-opaque)', kind: 'Stage', words: 'Other stages', Icon: Circle },
};

/**
 * A `.factory-card`'s colour (factory.css): its tint under the accent bar and, when lit, its
 * light. Any card on the canvases takes one, a group's or a kind's.
 */
export const cardTone = (color: string): CSSProperties =>
  ({ '--card-tone': color }) as CSSProperties;
