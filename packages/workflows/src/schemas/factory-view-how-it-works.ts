/**
 * How it works: the part of a pack's factory view (`factory-view.ts`) that explains, as a
 * hand-drawn picture, how the factory runs. Not live, not exhaustive, and never generated from
 * workflow YAML.
 *
 * It is a root view and drill-downs a card `opens`. Each view lays its cards out on a 1-based
 * grid and joins them with edges, which a console draws straight: an edge runs along a row or
 * a column its two ends share. A `loops-back` edge that answers a `calls` edge (a reply) runs
 * beside that edge; every other `loops-back` edge drops from its source into one lane under
 * everything, runs along its own track there, and rises into its target, so a view may send
 * work back several ways. The schema rejects a picture whose lines would run through a card,
 * cross a group it does not belong to, or cross another line (`factory-overview-geometry.ts`,
 * `factory-overview-lanes.ts`). Whether a card's `stages` and the edges between such cards
 * agree with the pack only the pack graph can say (`factory-view-check.ts`).
 */
import { z } from 'zod';
import { geometryIssues, type Issue } from './factory-overview-geometry';

const slugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase slug such as "build"');

/** What a card stands for: its legend entry and its colour. */
const kindSchema = z.enum(['input', 'stage', 'check', 'person', 'gate', 'outcome']);

/** The icons a card may show; a console maps each one, so the set is closed. */
const iconSchema = z.enum([
  'inbox',
  'issue',
  'order',
  'search',
  'scale',
  'map',
  'list',
  'hammer',
  'git-pull-request',
  'check',
  'flask',
  'eye',
  'sparkles',
  'gavel',
  'users',
  'flag',
  'rotate',
]);

const cardSchema = z.strictObject({
  /** Unique across the whole picture, so a card names one place. */
  id: slugSchema,
  title: z.string().min(1).max(40),
  /** One line, plain words. */
  text: z.string().min(1).max(120),
  icon: iconSchema,
  kind: kindSchema,
  col: z.number().int().min(1),
  row: z.number().int().min(1),
  /** The group of the same view this card sits in. */
  group: slugSchema.optional(),
  /** The view this card opens: a closer look at what it stands for. */
  opens: slugSchema.optional(),
  /**
   * The pack graph stages the card stands for, by their `workflow` name. A `feeds` or
   * `loops-back` edge between two such cards must join stages the graph connects.
   */
  stages: z.array(z.string().min(1)).min(1).optional(),
});

const groupSchema = z.strictObject({
  /** Unique across the whole picture, cards included. */
  id: slugSchema,
  label: z.string().min(1).max(40),
});

const edgeSchema = z.strictObject({
  /** A card or a group of the same view. */
  from: slugSchema,
  to: slugSchema,
  /** `feeds` hands work on; `calls` asks someone; `loops-back` sends work back. */
  kind: z.enum(['feeds', 'calls', 'loops-back']),
  label: z.string().min(1).max(40).optional(),
});

const viewSchema = z.strictObject({
  /** A drill-down's own line, under its map. The root view takes none: its line is the top-level `caption`. */
  caption: z.string().min(1).max(400).optional(),
  groups: z.array(groupSchema).optional(),
  cards: z.array(cardSchema).min(1),
  edges: z.array(edgeSchema),
});

const howItWorksShape = z.strictObject({
  /** The page heading and the breadcrumb's first entry. */
  title: z.string().min(1).max(80),
  /** One paragraph under the root view's map, plain words for someone who has never seen Archon. */
  caption: z.string().min(1).max(800),
  /** The view the page opens on. */
  root: slugSchema,
  /** Every view by id: the root and the drill-downs cards open. */
  views: z.record(slugSchema, viewSchema),
});

type HowItWorksShape = z.infer<typeof howItWorksShape>;

/** Card and group ids are unique across the picture, so a breadcrumb or a link names one place. */
function idIssues(picture: HowItWorksShape): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  const claim = (id: string, path: Issue['path']): void => {
    if (seen.has(id)) issues.push({ path, message: `id "${id}" is used twice in this picture` });
    seen.add(id);
  };
  for (const [viewId, view] of Object.entries(picture.views)) {
    view.groups?.forEach((group, index) => {
      claim(group.id, ['views', viewId, 'groups', index, 'id']);
    });
    view.cards.forEach((card, index) => {
      claim(card.id, ['views', viewId, 'cards', index, 'id']);
    });
  }
  return issues;
}

/** The views a walk along `opens` from the root reaches. */
function reachable(picture: HowItWorksShape): Set<string> {
  const reached = new Set<string>();
  const walk = (viewId: string): void => {
    const view = picture.views[viewId];
    if (view === undefined || reached.has(viewId)) return;
    reached.add(viewId);
    for (const card of view.cards) if (card.opens !== undefined) walk(card.opens);
  };
  walk(picture.root);
  return reached;
}

/**
 * The views form one tree from the root through `opens`: every other view is opened by
 * exactly one card, the root by none, and a walk from the root reaches every view.
 */
function openIssues(picture: HowItWorksShape): Issue[] {
  if (picture.views[picture.root] === undefined)
    return [{ path: ['root'], message: `names view "${picture.root}", which is not in views` }];
  const issues: Issue[] = [];
  const openedBy = new Map<string, string>();
  for (const [viewId, view] of Object.entries(picture.views))
    view.cards.forEach((card, index) => {
      if (card.opens === undefined) return;
      const path = ['views', viewId, 'cards', index, 'opens'];
      if (picture.views[card.opens] === undefined)
        issues.push({ path, message: `names view "${card.opens}", which is not in views` });
      else if (card.opens === viewId || card.opens === picture.root)
        issues.push({ path, message: `opens "${card.opens}", which would loop back up the tree` });
      else if (openedBy.has(card.opens))
        issues.push({
          path,
          message: `opens "${card.opens}", which card "${openedBy.get(card.opens) ?? ''}" opens too`,
        });
      else openedBy.set(card.opens, card.id);
    });
  const reached = reachable(picture);
  for (const viewId of Object.keys(picture.views))
    if (!reached.has(viewId))
      issues.push({ path: ['views', viewId], message: 'no card reachable from the root opens it' });
  return issues;
}

/** The root view's line is the top-level `caption`; a caption on the root view would never show. */
function rootCaptionIssues(picture: HowItWorksShape): Issue[] {
  if (picture.views[picture.root]?.caption === undefined) return [];
  return [
    {
      path: ['views', picture.root, 'caption'],
      message: "the root view's line is the top-level caption; move it there",
    },
  ];
}

/** The root shows how work goes back: it needs at least one loops-back edge. */
function loopIssues(picture: HowItWorksShape): Issue[] {
  const root = picture.views[picture.root];
  if (root === undefined || root.edges.some(edge => edge.kind === 'loops-back')) return [];
  return [
    {
      path: ['views', picture.root, 'edges'],
      message: 'the root view needs a loops-back edge: the way work is sent back',
    },
  ];
}

export const howItWorksSchema = howItWorksShape.superRefine((picture, ctx) => {
  const issues = [
    ...idIssues(picture),
    ...openIssues(picture),
    ...loopIssues(picture),
    ...rootCaptionIssues(picture),
    ...Object.entries(picture.views).flatMap(([viewId, view]) =>
      geometryIssues(view).map(issue => ({ ...issue, path: ['views', viewId, ...issue.path] }))
    ),
  ];
  for (const issue of issues)
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export type HowItWorks = z.infer<typeof howItWorksSchema>;
