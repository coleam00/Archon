/**
 * A pack's factory view: how a console presents the pack as a software factory. The pack's
 * author ships it as `<pack>/.shared/factory-view.json`, hand-curated, and it is presentation
 * only: words for the pack's groups, stages, steps and outcomes, the Overview map's cards, the
 * How it works picture (`factory-view-how-it-works.ts`), drill-down cards and story wording.
 *
 * Structure is never stated here. Which stages exist, their order, their groups, steps,
 * outcomes and the arrows between them come from the pack graph
 * (`GET /api/packs/{pack}/graph`); this file only names them, by a stage's `workflow` name.
 * Whether every name is one the graph has is `checkFactoryView` (`factory-view-check.ts`),
 * run when the file is read and by `bun run check:factory-view`.
 */
import { z } from 'zod';
import { howItWorksSchema } from './factory-view-how-it-works';

export const FACTORY_VIEW_FILE = 'factory-view.json';
/** A map note may sit by the Needs-you list instead of a card. */
const NEAR_NEEDS_YOU = 'needs-you';

const labelSchema = z.string().min(1).max(80);
/** One plain sentence a person reads: no placeholders, no markup. */
const sentenceSchema = z.string().trim().min(1).max(160);
const cardIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase slug such as "plan"');
/** A pack graph stage's `workflow` name: its authored `name:`. */
const stageNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a stage workflow name');
/**
 * A step id as the engine records it: an included workflow's node is `<include>__<node>`,
 * and a loop group's body node is `<group>.<node>`.
 */
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a step id');
/** `stage:outcome`, or `stage:*` for every completed run of the stage no exact key takes. */
const outcomeKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+:([A-Za-z0-9_.-]+|\*)$/, 'stage:outcome or stage:*');
/** `stage:option`, an option id of an ask a run of the stage left. */
const answerKeySchema = z.string().regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/, 'stage:option');

/** The icons a drill-down card may show; a console maps each one, so the set is closed. */
const drilldownIconSchema = z.enum([
  'inbox',
  'scale',
  'link',
  'ruler',
  'scissors',
  'database',
  'clipboard-list',
  'pencil',
  'wrench',
  'git-branch',
  'search-code',
  'flask-conical',
  'monitor-check',
  'gavel',
  'message-square',
  'circle-alert',
  'git-pull-request',
  'flag',
  'send',
  'shield-check',
  'git-merge',
]);

/** One card of a drill-down: a plain-words box standing for some of its stage's real steps. */
const drilldownCardSchema = z.strictObject({
  title: labelSchema,
  /** One line, plain words: what the card does. */
  text: z.string().min(1).max(160),
  icon: drilldownIconSchema,
  /** Who does it: an agent, a check that approves or returns, a script, or you. */
  kind: z.enum(['agent', 'check', 'script', 'you']),
  /** The stage's real steps the card stands for, by step id. */
  covers: z.array(stepIdSchema).min(1),
});

/** A stage told as a few numbered phases, each holding a few cards. */
const drilldownSchema = z.strictObject({
  phases: z
    .array(
      z.strictObject({ label: labelSchema, cards: z.array(drilldownCardSchema).min(1).max(6) })
    )
    .min(1),
});

const stageSchema = z.strictObject({
  label: labelSchema,
  /** At most 24 characters: what one row of a map card holding several stages shows whole. */
  short: z.string().min(1).max(24).optional(),
  /** One plain-words line: what this stage does to an item. */
  blurb: z.string().min(1).max(300),
  /** Display names for the stage's steps, by step id. A step with none reads as its id. */
  steps: z.record(stepIdSchema, labelSchema).optional(),
  /** What the stage does, step by step, in plain words, for the stage modal. */
  drilldown: drilldownSchema.optional(),
});

/**
 * How one outcome reads. `story` is the item history's sentence for a run that ended so; the
 * `{ withChange, withoutChange }` form is chosen by whether the item has a change. `label` is
 * the short form a card or a folded row shows. `reads` is how a console reads the item after
 * it: `ended` (closed without a change), `parked` (kept for later), `awaits` (waits on a
 * person though no ask is open; `next` says what that person does) or `returned` (sent back).
 */
const outcomeSchema = z
  .strictObject({
    label: labelSchema.optional(),
    story: z
      .union([
        sentenceSchema,
        z.strictObject({ withChange: sentenceSchema, withoutChange: sentenceSchema }),
      ])
      .optional(),
    reads: z.enum(['ended', 'parked', 'awaits', 'returned']).optional(),
    next: sentenceSchema.optional(),
  })
  .refine(outcome => outcome.next === undefined || outcome.reads === 'awaits', {
    message: '`next` says what a person does for an outcome that awaits one; set reads: "awaits"',
    path: ['next'],
  });

/** The words a console uses for what it counts across a pack's runs. */
const wordsSchema = z.strictObject({
  round: labelSchema.optional(),
  rounds: labelSchema.optional(),
  sentBack: labelSchema.optional(),
  parked: labelSchema.optional(),
  workOrder: labelSchema.optional(),
  workOrders: labelSchema.optional(),
});

/**
 * The Overview map: its cards in drawing order, each standing for one or more graph stages,
 * which it names in order. A card holding one stage takes that stage's words; `label`,
 * `short` and `blurb` word a card holding several.
 */
const mapCardSchema = z.strictObject({
  id: cardIdSchema,
  label: labelSchema.optional(),
  short: z.string().min(1).max(24).optional(),
  blurb: z.string().min(1).max(300).optional(),
  stages: z.array(stageNameSchema).min(1),
});

const mapShape = z.strictObject({
  cards: z.array(mapCardSchema).min(1),
  /**
   * Words for the map's arrows, not the arrows: the map draws what the pack graph connects
   * between two cards' stages, and an entry here labels the arrow from card `from` to card `to`.
   */
  edges: z
    .array(z.strictObject({ from: cardIdSchema, to: cardIdSchema, label: labelSchema }))
    .optional(),
  /** A short line drawn by a card, or by the Needs-you list (`near: "needs-you"`). */
  notes: z
    .array(z.strictObject({ text: z.string().min(1).max(160), near: z.string().min(1) }))
    .optional(),
});

type Issue = { path: (string | number)[]; message: string };

/** Card ids are unique, a stage sits on one card, and edges and notes name cards the map has. */
function mapIssues(map: z.infer<typeof mapShape>): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const holder = new Map<string, string>();
  map.cards.forEach((card, c) => {
    if (ids.has(card.id))
      issues.push({ path: ['cards', c, 'id'], message: `card "${card.id}" is declared twice` });
    ids.add(card.id);
    card.stages.forEach((stage, s) => {
      const already = holder.get(stage);
      if (already !== undefined)
        issues.push({
          path: ['cards', c, 'stages', s],
          message: `stage "${stage}" is on card "${already}" already`,
        });
      else holder.set(stage, card.id);
    });
  });
  const refer = (path: Issue['path'], id: string, allowed?: string): void => {
    if (!ids.has(id) && id !== allowed)
      issues.push({ path, message: `names card "${id}", which the map does not have` });
  };
  map.edges?.forEach((edge, e) => {
    refer(['edges', e, 'from'], edge.from);
    refer(['edges', e, 'to'], edge.to);
  });
  map.notes?.forEach((note, n) => {
    refer(['notes', n, 'near'], note.near, NEAR_NEEDS_YOU);
  });
  return issues;
}

const mapSchema = mapShape.superRefine((map, ctx) => {
  for (const issue of mapIssues(map))
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});

export const factoryViewSchema = z.strictObject({
  version: z.literal(1),
  title: labelSchema,
  /** One paragraph, plain words: what goes in, what comes out, where people step in. */
  summary: z.string().min(1).max(1200),
  /** Words for the pack document's groups, by group name. Membership is the document's. */
  groups: z
    .record(z.string().min(1), z.strictObject({ blurb: z.string().min(1).max(160) }))
    .optional(),
  /** Words for the graph's stages, by `workflow` name. */
  stages: z.record(stageNameSchema, stageSchema),
  /** How each outcome reads, by `stage:outcome` or `stage:*`. */
  outcomes: z.record(outcomeKeySchema, outcomeSchema).optional(),
  /**
   * What choosing an option of an ask a run of the stage left starts, by `stage:option`, in one
   * plain sentence. It decides nothing: the pack's bindings do.
   */
  answers: z.record(answerKeySchema, z.strictObject({ starts: sentenceSchema })).optional(),
  words: wordsSchema.optional(),
  map: mapSchema,
  howItWorks: howItWorksSchema,
});
export type FactoryView = z.infer<typeof factoryViewSchema>;

/**
 * What is wrong with a factory view against its pack graph, or with the file itself: an
 * `error` for a name the graph lacks or a file that does not read, a `warning` for what the
 * graph has that the file leaves out. `path` is where in the file, as a zod issue path.
 */
export const factoryViewProblemSchema = z.object({
  severity: z.enum(['error', 'warning']),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type FactoryViewProblem = z.infer<typeof factoryViewProblemSchema>;
