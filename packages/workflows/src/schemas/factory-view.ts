/**
 * A pack's factory view: how a console presents the pack as a software factory. The pack's
 * author ships it as `<pack>/.shared/factory-view.json`, hand-curated, and it is presentation
 * only: words for the pack's stages, steps and outcomes, its groups, which stage items leave
 * the map by (`merged`), the How it works picture (`factory-view-how-it-works.ts`), drill-down
 * cards and story wording, and where a console finds an item's rounds, returns and change in its
 * runs' records (`factory-view-progress.ts`). The Overview map lays itself out from the pack
 * graph; nothing here places its cards or draws its arrows.
 *
 * Structure is never stated here. Which stages exist, their order, steps, outcomes and the
 * arrows between them come from the pack graph (`GET /api/packs/{pack}/graph`); this file only
 * names them, by a stage's `workflow` name. The file is read entry by entry
 * (`factory-view-read.ts`), so one bad entry costs only itself, and reconciled with the graph
 * (`factory-view-check.ts`), so one stale name costs only its entry; both run when the file is
 * read and in `bun run check:factory-view`.
 */
import { z } from 'zod';
import { howItWorksSchema } from './factory-view-how-it-works';
import { progressDeclarations } from './factory-view-progress';

export const FACTORY_VIEW_FILE = 'factory-view.json';

const labelSchema = z.string().min(1).max(80);
/** One plain sentence a person reads: no placeholders, no markup. */
const sentenceSchema = z.string().trim().min(1).max(160);
/** A pack graph stage's `workflow` name: its authored `name:`. */
export const stageNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a stage workflow name');
/**
 * A step id as the engine records it: an included workflow's node is `<include>__<node>`,
 * and a loop group's body node is `<group>.<node>`.
 */
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a step id');
/** `stage:outcome`, or `stage:*` for every completed run of the stage no exact key takes. */
export const outcomeKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+:([A-Za-z0-9_.-]+|\*)$/, 'stage:outcome or stage:*');
/** `stage:option`, an option id of an ask a run of the stage left. */
export const answerKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/, 'stage:option');

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

export const stageSchema = z.strictObject({
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
export const outcomeSchema = z
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
export const wordsSchema = z.strictObject({
  round: labelSchema.optional(),
  rounds: labelSchema.optional(),
  sentBack: labelSchema.optional(),
  parked: labelSchema.optional(),
  workOrder: labelSchema.optional(),
  workOrders: labelSchema.optional(),
});

/**
 * One group of the factory: its name, one plain line, its stages in flow order, and its kind:
 * which of the console's group colours and kind labels its card and board column take. A group
 * without a kind, or `neutral`, takes the neutral one; a console never infers it from position.
 */
export const groupSchema = z.strictObject({
  name: labelSchema,
  blurb: z.string().min(1).max(160),
  stages: z.array(stageNameSchema).min(1),
  kind: z.enum(['intake', 'build', 'check', 'merge', 'neutral']).optional(),
});

/** What choosing one option of an ask starts, in one plain sentence. */
export const answerSchema = z.strictObject({ starts: sentenceSchema });

export const factoryViewSchema = z.strictObject({
  version: z.literal(1),
  title: labelSchema,
  /** One paragraph, plain words: what goes in, what comes out, where people step in. */
  summary: z.string().min(1).max(1200),
  /**
   * The factory's groups in drawing order, each holding its stages in flow order. The file
   * declares them because a pack need not (its document's groups are gone on the pack's main);
   * where both do, the file's win (DESIGN.md, COMBINED direction).
   */
  groups: z.array(groupSchema).optional(),
  /** Words for the graph's stages, by `workflow` name. */
  stages: z.record(stageNameSchema, stageSchema),
  /** How each outcome reads, by `stage:outcome` or `stage:*`. */
  outcomes: z.record(outcomeKeySchema, outcomeSchema).optional(),
  /**
   * What choosing an option of an ask a run of the stage left starts, by `stage:option`, in one
   * plain sentence. It decides nothing: the pack's bindings do.
   */
  answers: z.record(answerKeySchema, answerSchema).optional(),
  words: wordsSchema.optional(),
  ...progressDeclarations,
  /**
   * The stage items leave the map by: the Overview draws it last, on its own, and counts the
   * board's Merged column on it. The graph does not say which stage that is. Without it, the
   * last in-flow stage is.
   */
  merged: stageNameSchema.optional(),
  howItWorks: howItWorksSchema,
});
export type FactoryView = z.infer<typeof factoryViewSchema>;

/**
 * What is wrong with a factory view, as one entry of the file: every kind is an error
 * `check:factory-view` fails on, and a console shows them all while it draws what is left.
 *
 * - `unreadable`: the file is not JSON or its envelope (version, title, summary, How it
 *   works, a `stages` object) does not read. The view is null; nothing else is reported.
 * - `invalid`: an entry fails its schema, or contradicts another entry; a failing entry is
 *   dropped alone.
 * - `unknown`: a key the schema does not know (an older file's `map`, a misspelt key); the key
 *   is dropped and its entry kept.
 * - `dropped`: an entry names a stage, step, outcome, option or group the pack graph lacks, or
 *   joins stages no arrow connects; it is dropped alone.
 * - `retired`: a `rounds`, `returns`, `approves` or `change` entry names a workflow the graph
 *   lacks and the file does not retire. It is kept and its workflow treated as retired, so
 *   old runs still count.
 * - `unworded`: an in-flow stage, one of its steps, or one of its outcome values has no words.
 * - `ungrouped`: the file declares groups and an in-flow stage is in none of them.
 *
 * `path` is where in the file, as a zod issue path, naming the entry as the author wrote it.
 */
export const factoryViewProblemSchema = z.object({
  kind: z.enum(['unreadable', 'invalid', 'unknown', 'dropped', 'retired', 'unworded', 'ungrouped']),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type FactoryViewProblem = z.infer<typeof factoryViewProblemSchema>;
