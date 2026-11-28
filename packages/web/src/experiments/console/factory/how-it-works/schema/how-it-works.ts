/**
 * The shape of a How it works picture: a hand-drawn explainer of how a factory runs. Not live,
 * not exhaustive, and never generated from workflow YAML. The console keeps its pictures itself
 * (`archon-software-factory.ts`); the engine knows nothing of them.
 *
 * It is a root view and drill-downs a card `opens`. Each view lays its cards out on a 1-based
 * grid and joins them with edges, which the console draws straight: an edge runs along a row or
 * a column its two ends share. A `loops-back` edge that answers a `calls` edge (a reply) runs
 * beside that edge; every other `loops-back` edge drops from its source into one lane under
 * everything, runs along its own track there, and rises into its target. The layout tests
 * (`overview-layout.test.ts`) hold the shipped picture to those rules: no line through a card,
 * across a group it does not belong to, or across another line.
 */

/** What a card stands for: its legend entry and its colour. */
export type HowItWorksKind = 'input' | 'stage' | 'check' | 'person' | 'gate' | 'outcome';

/** The icons a card may show; the console maps each one, so the set is closed. */
export type HowItWorksIcon =
  | 'inbox'
  | 'issue'
  | 'order'
  | 'search'
  | 'scale'
  | 'map'
  | 'list'
  | 'hammer'
  | 'git-pull-request'
  | 'check'
  | 'flask'
  | 'eye'
  | 'sparkles'
  | 'gavel'
  | 'users'
  | 'flag'
  | 'rotate';

export interface HowItWorksCard {
  /** Unique across the whole picture, so a card names one place. */
  id: string;
  /** At most 40 characters. */
  title: string;
  /** One line, plain words, at most 120 characters. */
  text: string;
  icon: HowItWorksIcon;
  kind: HowItWorksKind;
  col: number;
  row: number;
  /** The group of the same view this card sits in. */
  group?: string;
  /** The view this card opens: a closer look at what it stands for. */
  opens?: string;
  /** The pack graph stages the card stands for, by their `workflow` name. */
  stages?: string[];
}

export interface HowItWorksGroup {
  /** Unique across the whole picture, cards included. */
  id: string;
  label: string;
}

export interface HowItWorksEdge {
  /** A card or a group of the same view. */
  from: string;
  to: string;
  /** `feeds` hands work on; `calls` asks someone; `loops-back` sends work back. */
  kind: 'feeds' | 'calls' | 'loops-back';
  label?: string;
}

export interface HowItWorksView {
  /** A drill-down's own line, under its map. The root view takes none: its line is `caption`. */
  caption?: string;
  groups?: HowItWorksGroup[];
  cards: HowItWorksCard[];
  edges: HowItWorksEdge[];
}

export interface HowItWorks {
  /** The page heading and the breadcrumb's first entry. */
  title: string;
  /** One paragraph under the root view's map, plain words for someone who has never seen Archon. */
  caption: string;
  /** The view the page opens on. */
  root: string;
  /** Every view by id: the root and the drill-downs cards open. */
  views: Record<string, HowItWorksView>;
}

/** A factory's curated explainer: a one-paragraph summary and its How it works picture. */
export interface CuratedFactory {
  summary: string;
  howItWorks: HowItWorks;
}
