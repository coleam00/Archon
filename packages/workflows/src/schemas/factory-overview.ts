/**
 * Factory overviews: a hand-curated explainer of how a pack's factory runs, for presenting it.
 * Not live, not exhaustive, and never generated from workflow YAML: the pack's author writes it
 * as `<pack>/.shared/factory-overview.json`, and a project may present a pack it cannot edit
 * with `.archon/packs/<pack key>.factory-overview.json`.
 *
 * An overview is a root view and drill-downs a card `opens`. Each view lays its cards out on a
 * 1-based grid and joins them with edges, which a console draws straight: an edge runs along a
 * row or a column its two ends share. A `loops-back` edge that answers a `calls` edge (a reply)
 * runs beside that edge; every other `loops-back` edge drops from its source into one lane
 * under everything, runs along its own track there, and rises into its target, so a view may
 * send work back several ways. The schema rejects a file whose lines would run through a card,
 * cross a group it does not belong to, or cross another line, so nothing crosses in any file
 * that validates (`factory-overview-geometry.ts`, `factory-overview-lanes.ts`).
 */
import { z } from 'zod';
import { factoryViewSourceSchema } from './factory-view';
import { geometryIssues, type Issue } from './factory-overview-geometry';
import { INPUT_NAME_PATTERN } from './node-bindings';

export const FACTORY_OVERVIEW_FILE = 'factory-overview.json';
/** Appended to a pack key to name the project file: `<pack key>.factory-overview.json`. */
export const FACTORY_OVERVIEW_PROJECT_SUFFIX = '.factory-overview.json';

const slugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase slug such as "build"');

/** What a card stands for: its legend entry and its colour. */
export const factoryOverviewKindSchema = z.enum([
  'input',
  'stage',
  'check',
  'person',
  'gate',
  'outcome',
]);

/** The icons a card may show; a console maps each one, so the set is closed. */
export const factoryOverviewIconSchema = z.enum([
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

const factoryOverviewEdgeKindSchema = z.enum(['feeds', 'calls', 'loops-back']);

const cardSchema = z.strictObject({
  /** Unique across the whole file, so a card names one place. */
  id: slugSchema,
  title: z.string().min(1).max(40),
  /** One line, plain words. */
  text: z.string().min(1).max(120),
  icon: factoryOverviewIconSchema,
  kind: factoryOverviewKindSchema,
  col: z.number().int().min(1),
  row: z.number().int().min(1),
  /** The group of the same view this card sits in. */
  group: slugSchema.optional(),
  /** The view this card opens: a closer look at what it stands for. */
  opens: slugSchema.optional(),
});

const groupSchema = z.strictObject({
  /** Unique across the whole file, cards included. */
  id: slugSchema,
  label: z.string().min(1).max(40),
});

const edgeSchema = z.strictObject({
  /** A card or a group of the same view. */
  from: slugSchema,
  to: slugSchema,
  /** `feeds` hands work on; `calls` asks someone; `loops-back` sends work back. */
  kind: factoryOverviewEdgeKindSchema,
  label: z.string().min(1).max(40).optional(),
  /**
   * A shadow line says what the pack would do and does nothing yet (it decides what it would
   * file, and files nothing). A console draws it in the shadow style and says so on its label.
   */
  shadow: z.boolean().optional(),
});

const viewSchema = z.strictObject({
  /** A drill-down's own line, under its map. The root view takes none: its line is the overview's `caption`. */
  caption: z.string().min(1).max(400).optional(),
  groups: z.array(groupSchema).optional(),
  cards: z.array(cardSchema).min(1),
  edges: z.array(edgeSchema),
});

/** How one pack setting is presented: as a shadow, and what its value points to. */
const factoryOverviewSettingSchema = z.strictObject({
  /** The pack runs what this setting configures as a shadow: recorded, nothing acts on it. */
  shadow: z.boolean().optional(),
  /**
   * The value is a path in the project: a `policy` document, or the `checks` file, a YAML
   * list of checks (`schemas/factory-checks.ts`). A pack declares at most one checks file.
   */
  points_to: z.enum(['policy', 'checks']).optional(),
  /** The section of the Settings page it is shown in: an id from `setting_sections`. */
  section: slugSchema.optional(),
  /** A shadow setting only: what changes once it stops being a shadow, in one plain line. */
  when_live: z.string().min(1).max(160).optional(),
});

/** One section of the Settings page: settings grouped by what they govern. */
const factoryOverviewSettingSectionSchema = z.strictObject({
  id: slugSchema,
  /** The short label above the title, in the section's colour. */
  eyebrow: z.string().min(1).max(24),
  title: z.string().min(1).max(60),
  /** The section's colour, as a card of that kind has it. */
  kind: factoryOverviewKindSchema,
  icon: factoryOverviewIconSchema,
});

const factoryOverviewShape = z.strictObject({
  version: z.literal(1),
  /** The pack this overview explains: `owner/name` when installed, else its folder name. */
  pack: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/, 'a pack folder name or owner/name'),
  /** The page heading and the breadcrumb's first entry. */
  title: z.string().min(1).max(80),
  /** One paragraph under the root view's map, plain words for someone who has never seen Archon. */
  caption: z.string().min(1).max(800),
  /** The view the page opens on. */
  root: slugSchema,
  /** Every view by id: the root and the drill-downs cards open. */
  views: z.record(slugSchema, viewSchema),
  /**
   * How a console presents the pack's settings, by setting name. The pack's `.pack/pack.yaml`
   * declares each setting's name, default and description, but says in prose only whether a
   * setting runs as a shadow or names a file, so this map says it in fields until the pack's
   * declaration does. Every key must be a setting the pack declares; the console checks that
   * against the declaration it reads (`factory-pack-settings.ts`) and shows any other key as
   * an error. A setting without an entry is shown as its plain value.
   */
  settings: z
    .record(z.string().regex(INPUT_NAME_PATTERN, 'a setting name'), factoryOverviewSettingSchema)
    .optional(),
  /**
   * The Settings page's sections, in page order. A setting names its section in `settings`;
   * a declared setting that names none is shown in a trailing "Other" section, so a pack
   * update never hides one.
   */
  setting_sections: z.array(factoryOverviewSettingSectionSchema).optional(),
});

type FactoryOverviewShape = z.infer<typeof factoryOverviewShape>;

/** Card and group ids are unique across the file, so a breadcrumb or a link names one place. */
function idIssues(overview: FactoryOverviewShape): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  const claim = (id: string, path: Issue['path']): void => {
    if (seen.has(id)) issues.push({ path, message: `id "${id}" is used twice in this file` });
    seen.add(id);
  };
  for (const [viewId, view] of Object.entries(overview.views)) {
    view.groups?.forEach((group, index) => {
      claim(group.id, ['views', viewId, 'groups', index, 'id']);
    });
    view.cards.forEach((card, index) => {
      claim(card.id, ['views', viewId, 'cards', index, 'id']);
    });
  }
  return issues;
}

/**
 * The views form one tree from the root through `opens`: every other view is opened by
 * exactly one card, the root by none, and a walk from the root reaches every view.
 */
function openIssues(overview: FactoryOverviewShape): Issue[] {
  const issues: Issue[] = [];
  if (overview.views[overview.root] === undefined)
    return [{ path: ['root'], message: `names view "${overview.root}", which is not in views` }];
  const openedBy = new Map<string, string>();
  for (const [viewId, view] of Object.entries(overview.views))
    view.cards.forEach((card, index) => {
      if (card.opens === undefined) return;
      const path = ['views', viewId, 'cards', index, 'opens'];
      if (overview.views[card.opens] === undefined)
        issues.push({ path, message: `names view "${card.opens}", which is not in views` });
      else if (card.opens === viewId || card.opens === overview.root)
        issues.push({ path, message: `opens "${card.opens}", which would loop back up the tree` });
      else if (openedBy.has(card.opens))
        issues.push({
          path,
          message: `opens "${card.opens}", which card "${openedBy.get(card.opens) ?? ''}" opens too`,
        });
      else openedBy.set(card.opens, card.id);
    });
  const reached = reachable(overview);
  for (const viewId of Object.keys(overview.views))
    if (!reached.has(viewId))
      issues.push({ path: ['views', viewId], message: 'no card reachable from the root opens it' });
  return issues;
}

/** The views a walk along `opens` from the root reaches. */
function reachable(overview: FactoryOverviewShape): Set<string> {
  const reached = new Set<string>();
  const walk = (viewId: string): void => {
    const view = overview.views[viewId];
    if (view === undefined || reached.has(viewId)) return;
    reached.add(viewId);
    for (const card of view.cards) if (card.opens !== undefined) walk(card.opens);
  };
  walk(overview.root);
  return reached;
}

/** The root view's line is the overview's `caption`; a caption on the root view would never show. */
function rootCaptionIssues(overview: FactoryOverviewShape): Issue[] {
  if (overview.views[overview.root]?.caption === undefined) return [];
  return [
    {
      path: ['views', overview.root, 'caption'],
      message: "the root view's line is the overview's top-level caption; move it there",
    },
  ];
}

/** The root shows how work goes back: it needs at least one loops-back edge. */
function loopIssues(overview: FactoryOverviewShape): Issue[] {
  const root = overview.views[overview.root];
  if (root === undefined || root.edges.some(edge => edge.kind === 'loops-back')) return [];
  return [
    {
      path: ['views', overview.root, 'edges'],
      message: 'the root view needs a loops-back edge: the way work is sent back',
    },
  ];
}

/**
 * A pack declares one checks file, so at most one setting points to it. A setting's section is
 * a listed one, and only a shadow says what changes when it stops being one.
 */
function settingsIssues(overview: FactoryOverviewShape): Issue[] {
  const settings = Object.entries(overview.settings ?? {});
  const checks = settings.filter(([, setting]) => setting.points_to === 'checks');
  const issues: Issue[] = checks.slice(1).map(([name]) => ({
    path: ['settings', name, 'points_to'],
    message: `"${name}" points to the checks file, which "${checks[0]?.[0] ?? ''}" already does`,
  }));
  const sections = new Set<string>();
  overview.setting_sections?.forEach((section, index) => {
    if (sections.has(section.id))
      issues.push({
        path: ['setting_sections', index, 'id'],
        message: `section "${section.id}" is listed twice`,
      });
    sections.add(section.id);
  });
  for (const [name, setting] of settings) {
    if (setting.section !== undefined && !sections.has(setting.section))
      issues.push({
        path: ['settings', name, 'section'],
        message: `names section "${setting.section}", which is not in setting_sections`,
      });
    if (setting.when_live !== undefined && setting.shadow !== true)
      issues.push({
        path: ['settings', name, 'when_live'],
        message: 'says what changes when it stops being a shadow, and it is not one',
      });
  }
  return issues;
}

export const factoryOverviewSchema = factoryOverviewShape.superRefine((overview, ctx) => {
  const issues = [
    ...settingsIssues(overview),
    ...idIssues(overview),
    ...openIssues(overview),
    ...loopIssues(overview),
    ...rootCaptionIssues(overview),
    ...Object.entries(overview.views).flatMap(([viewId, view]) =>
      geometryIssues(view).map(issue => ({ ...issue, path: ['views', viewId, ...issue.path] }))
    ),
  ];
  for (const issue of issues)
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export type FactoryOverview = z.infer<typeof factoryOverviewSchema>;

const factoryOverviewsListingSchema = z.object({
  overviews: z.array(
    z.object({
      /** The overview's pack: `owner/name` when installed, else its folder name. */
      pack: z.string(),
      source: factoryViewSourceSchema,
      /** The file the overview was read from. */
      path: z.string(),
      declaration: factoryOverviewSchema,
    })
  ),
  /** Overview files that could not be read or did not validate, each with its file. */
  errors: z.array(
    z.object({
      pack: z.string(),
      source: factoryViewSourceSchema,
      path: z.string(),
      error: z.string(),
    })
  ),
});
export type FactoryOverviewsListing = z.infer<typeof factoryOverviewsListingSchema>;

const listedOverviewSchema = factoryOverviewsListingSchema.shape.overviews.element;
const projectRefSchema = z.object({ codebaseId: z.string(), name: z.string() });

/**
 * Every pack with a factory overview file, valid or broken, for the console's Factory pages:
 * the pack's own file first, else the first project (by name) that ships one.
 */
export const factoryPacksSchema = z.object({
  packs: z.array(
    z.object({
      /** The pack: `owner/name` when installed, else its folder name; its key when only a broken project file names it. */
      pack: z.string(),
      /** The pack's key (`owner.name` when installed): its page's URL segment. */
      key: z.string(),
      /** The overview shown, or null when every file for the pack is broken. */
      overview: listedOverviewSchema.nullable(),
      /** The project whose file `overview` was read from; null for the pack's own file. */
      readFrom: projectRefSchema.nullable(),
      /** The projects a factory view of this pack applies to, by name. */
      projects: z.array(projectRefSchema),
      /** Overview files for this pack that could not be read or did not validate. */
      errors: factoryOverviewsListingSchema.shape.errors,
    })
  ),
  /** Scope roots that could not be read: they name no pack. */
  errors: factoryOverviewsListingSchema.shape.errors,
  /** Projects whose files or views could not be read; the other packs still list. */
  unreadProjects: z.array(projectRefSchema.extend({ error: z.string() })),
});
export type FactoryPacks = z.infer<typeof factoryPacksSchema>;
