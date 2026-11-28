/**
 * Moving around a factory overview: the trail from the root to an open view, and every view
 * in the order the sidebar lists them.
 */
import type { HowItWorks } from '../how-it-works/schema/how-it-works';

/** A How it works picture (`how-it-works/schema/how-it-works.ts`). */
export type OverviewDeclaration = HowItWorks;
export type OverviewView = OverviewDeclaration['views'][string];
export type OverviewCard = OverviewView['cards'][number];

export interface TrailStep {
  id: string;
  label: string;
}

/** Which view opens `viewId` and through which card, for every view but the root. */
function openers(overview: OverviewDeclaration): Map<string, { view: string; card: OverviewCard }> {
  const opened = new Map<string, { view: string; card: OverviewCard }>();
  for (const [viewId, view] of Object.entries(overview.views))
    for (const card of view.cards)
      if (card.opens !== undefined) opened.set(card.opens, { view: viewId, card });
  return opened;
}

/** A view's name: the overview's title for the root, else the title of the card that opens it. */
function viewLabel(overview: OverviewDeclaration, viewId: string): string {
  if (viewId === overview.root) return overview.title;
  return openers(overview).get(viewId)?.card.title ?? viewId;
}

/** The views from the root down to `viewId`, each with its name. */
export function viewTrail(overview: OverviewDeclaration, viewId: string): TrailStep[] {
  const opened = openers(overview);
  const trail: TrailStep[] = [];
  // The schema makes the views a tree, so this walk ends at the root; the bound guards a
  // file that was not validated.
  let at: string | undefined = viewId;
  for (let step = 0; at !== undefined && step <= Object.keys(overview.views).length; step++) {
    trail.unshift({ id: at, label: viewLabel(overview, at) });
    if (at === overview.root) break;
    at = opened.get(at)?.view;
  }
  return trail;
}

export interface ListedView {
  id: string;
  label: string;
  /** 0 for the root, 1 for a view the root opens, and so on. */
  depth: number;
  cards: number;
  /** What the view shows, in one line: the text of the card that opens it; undefined for the root. */
  line: string | undefined;
}

/** Every view, depth first from the root in the order its cards open them. */
export function viewList(overview: OverviewDeclaration): ListedView[] {
  const listed: ListedView[] = [];
  const seen = new Set<string>();
  const opened = openers(overview);
  const walk = (viewId: string, depth: number): void => {
    const view = overview.views[viewId];
    if (view === undefined || seen.has(viewId)) return;
    seen.add(viewId);
    listed.push({
      id: viewId,
      label: viewLabel(overview, viewId),
      depth,
      cards: view.cards.length,
      line: opened.get(viewId)?.card.text,
    });
    for (const card of view.cards) if (card.opens !== undefined) walk(card.opens, depth + 1);
  };
  walk(overview.root, 0);
  return listed;
}

/**
 * The view a `?view=` names, or the root when it names none. `unknown` is set when it named a
 * view the file does not have (an old link): the page says so instead of silently showing the root.
 */
export function openView(
  overview: OverviewDeclaration,
  asked: string | null
): { id: string; unknown: string | undefined } {
  if (asked === null || asked === '') return { id: overview.root, unknown: undefined };
  if (overview.views[asked] !== undefined) return { id: asked, unknown: undefined };
  return { id: overview.root, unknown: asked };
}
