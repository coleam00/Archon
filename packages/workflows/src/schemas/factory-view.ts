/**
 * Factory views: how a workflow pack presents itself as a software factory in a console, as
 * stages an item moves through, a map of them, and where a finished run leaves an item.
 *
 * A view names a pack's workflows, outcomes and steps and computes nothing; a console reads
 * it beside the engine's own records, so it can draw a factory without naming a pack's
 * stages in code. The pack's author writes it as `<pack>/.shared/factory-view.json`, and a
 * project may present a pack it cannot edit with `.archon/packs/<pack key>.factory-view.json`.
 */
import { z } from 'zod';
import { drilldownIssues } from './factory-view-drilldown';
import { heldOpenIssues, retiredIssues } from './factory-view-held';
import { isRecord, oneOrList, sourceProblem } from './factory-view-problems';
import { storyReferenceIssues } from './factory-view-story';
import { workflowSourceSchema } from './workflow';

export const FACTORY_VIEW_FILE = 'factory-view.json';
/** Appended to a pack key to name the project file: `<pack key>.factory-view.json`. */
export const FACTORY_VIEW_PROJECT_SUFFIX = '.factory-view.json';
/** A map note may sit by the Needs-you list instead of a stage. */
const FACTORY_VIEW_NEEDS_YOU = 'needs-you';

const labelSchema = z.string().min(1).max(80);
const stageIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase slug such as "plan"');
/** A pack entrypoint's name, as the pack's manifest or folder names it. */
const workflowNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a workflow name');
/**
 * A step id as the engine records it: an included workflow's node is `<include>__<node>`,
 * and a loop group's body node is `<group>.<node>`, as in `rounds.review__review`.
 */
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a step id');
/** Where a value is in a run's result. */
const jsonPointerSchema = z.string().regex(/^\//, 'a JSON pointer starting with /');
/**
 * `workflow:outcome`, the completed outcome of a run of a workflow the view names, or
 * `workflow:*` for every completed run of it no exact key takes.
 */
const outcomeKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+:([A-Za-z0-9_.-]+|\*)$/, 'workflow:outcome or workflow:*');
/** `workflow:option`, an option id of an ask a run of a workflow the view names left; exact only. */
const answerKeySchema = z.string().regex(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/, 'workflow:option');

/** The real steps one card stands for: a workflow its stage lists, and step ids of it. */
const coverSchema = z.strictObject({
  workflow: workflowNameSchema,
  steps: z.array(stepIdSchema).min(1),
});

/** The icons a drill-down card may show; a console maps each one, so the set is closed. */
export const factoryDrilldownIconSchema = z.enum([
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

/** One card of a drill-down: a plain-words box standing for some of a workflow's real steps. */
const drilldownCardSchema = z.strictObject({
  title: labelSchema,
  /** One line, plain words: what the card does. */
  text: z.string().min(1).max(160),
  icon: factoryDrilldownIconSchema,
  /** Who does it: an agent, a check that approves or returns, a script, or you. */
  kind: z.enum(['agent', 'check', 'script', 'you']),
  /**
   * The real steps the card stands for; the first step named is the one a click on the card
   * opens. `bun run check:factory-view` reads the pack's workflows and fails when a real step
   * is covered by no card or by two, or a card names a workflow its stage does not list or
   * one the view retired.
   */
  covers: z.array(coverSchema).min(1),
});

/**
 * A stage told as a few numbered phases (columns, numbered by position from 1), each holding
 * a few cards, and at most one loop around the phases a loop group repeats.
 */
const drilldownSchema = z.strictObject({
  phases: z
    .array(
      z.strictObject({ label: labelSchema, cards: z.array(drilldownCardSchema).min(1).max(6) })
    )
    .min(1),
  /**
   * The loop group `step` of `workflow` repeats phases `from` to `to` (1-based): one line
   * drawn around them, labelled ("Up to 3 rounds"). The loop covers its group step, so its
   * workflow is one the stage lists and the pack runs now, never a retired one.
   */
  loop: z
    .strictObject({
      label: labelSchema,
      from: z.number().int().min(1),
      to: z.number().int().min(1),
      workflow: workflowNameSchema,
      step: stepIdSchema,
    })
    .optional(),
});

const stageSchema = z.strictObject({
  id: stageIdSchema,
  label: labelSchema,
  /** One plain-words line: what this stage does to an item. */
  blurb: z.string().min(1).max(300),
  /**
   * The map card's one line, at most 24 characters: what one row of a card holding several
   * stages shows whole. Absent, the map shows the blurb, cut to fit.
   */
  short: z.string().min(1).max(24).optional(),
  /** The colour group the map draws the stage in. */
  group: z.enum(['intake', 'build', 'check', 'land']),
  /** The pack entrypoints whose runs count here. Empty for a stage no run works, like Landed. */
  workflows: z.array(workflowNameSchema),
  /**
   * When given, a running run counts here only while one of these steps runs. A step
   * matches an entry equal to its id, or one its id begins with followed by `.`, so
   * `rounds` matches `rounds.fix`.
   */
  nodes: z.array(stepIdSchema).min(1).optional(),
  /** What the stage does, step by step, in plain words, for a stage page to draw. */
  drilldown: drilldownSchema.optional(),
});

/**
 * One board column: a group of stages drawn as one column, its cards each still naming its
 * own stage. The column's colour is a console's choice, not declared here.
 */
const columnSchema = z.strictObject({
  id: stageIdSchema,
  label: labelSchema,
  /** One line, plain words, under the column's label: the stages it holds, say. */
  blurb: z.string().min(1).max(160),
  /** The stages it holds, by id; every declared stage is in exactly one column. */
  stages: z.array(stageIdSchema).min(1),
});

/** A step of a workflow the view names, and the outcome it records that decides something. */
const decisionPointSchema = z.strictObject({
  workflow: workflowNameSchema,
  node: stepIdSchema,
  outcome: z.string().min(1),
});

/** Where a workflow's runs name the change's URL in their result, as a JSON pointer. */
const changeSourceSchema = z.strictObject({
  workflow: workflowNameSchema,
  pointer: jsonPointerSchema,
});

/**
 * How a console counts an item's check rounds on one workflow. The loop form: each iteration
 * of the loop group `loop` on a run of `workflow` is a round, bounded by the loop's own
 * maximum. The stage form: each run of `workflow` is one round, numbered and bounded by its
 * own result at the `round` and `allowance` pointers; a run whose result has no positive whole
 * number at `round` (a run still going, one that failed) is not a round.
 */
const loopRoundsSchema = z.strictObject({ workflow: workflowNameSchema, loop: stepIdSchema });
const stageRoundsSchema = z.strictObject({
  workflow: workflowNameSchema,
  round: jsonPointerSchema,
  allowance: jsonPointerSchema,
});

/** A rounds source's form, told by its keys: a `loop` makes it the loop form. */
function roundsSourceProblem(input: unknown): string {
  if (!isRecord(input))
    return 'expected a rounds source: { workflow, loop } or { workflow, round, allowance }';
  return 'loop' in input
    ? sourceProblem('a loop-form rounds source { workflow, loop }', loopRoundsSchema, input)
    : sourceProblem(
        'a stage-form rounds source { workflow, round, allowance }',
        stageRoundsSchema,
        input
      );
}

const roundsSourceSchema = z.union([loopRoundsSchema, stageRoundsSchema], {
  error: issue => roundsSourceProblem(issue.input),
});

/**
 * What a step's outcome means to a person, so a console can word it in its own words. The set
 * is closed: a console words each meaning, and never a pack's token.
 */
const factoryVerdictMeaningSchema = z.enum(['approved', 'returned', 'asked']);

const mapSchema = z.strictObject({
  cards: z.array(
    z.strictObject({
      stage: stageIdSchema,
      /*
       * The map once placed cards on a grid. It now draws them in `stages` order, so a second
       * order here could only disagree with that one; these are accepted, and ignored, so a
       * view file written for the grid still loads.
       */
      col: z.number().int().min(1).optional(),
      row: z.number().int().min(1).optional(),
    })
  ),
  /**
   * Every arrow the map draws, and no others: the hand-offs between stages and the send-backs,
   * curated by the view's author. The map reads no other source; `bun run check:factory-view`
   * keeps the hand-offs equal to the pack graph's (`GET /api/packs/{pack}/graph`): each one the
   * pack starts between two stages is declared, and each declared one the pack does not start
   * is marked as a person's step.
   */
  arrows: z.array(
    z.strictObject({
      from: stageIdSchema,
      to: stageIdSchema,
      /** The outcome that moves an item along, in plain words. */
      label: labelSchema.optional(),
      /*
       * Accepted, and ignored, so a view file that marks its send-backs still loads: the map
       * reads a send-back from `stages` order (an arrow into its own stage or an earlier one),
       * since a second statement of direction could only disagree with that order.
       */
      back: z.boolean().optional(),
      /** A step a person takes (a replan, a landing), which no pack hand-off starts. */
      person: z.boolean().optional(),
    })
  ),
  notes: z
    .array(z.strictObject({ text: z.string().min(1).max(160), near: z.string().min(1) }))
    .optional(),
});

/** What a shadow step is and how a person reads it: the step, and a plain question for it. */
const shadowStepShape = {
  workflow: workflowNameSchema,
  /** The step id as the engine records it: `rounds.checks` for a loop's body node. */
  node: stepIdSchema,
  /** A plain question or name for what it decides: "Would it start on its own". */
  label: labelSchema,
};

/**
 * One step the pack runs as a shadow: it decides what it would do, records it, and does
 * nothing. A console reads each completed run of the step from its value (its structured
 * output, else its text output parsed as JSON) and never shows it as having acted. `reads`
 * says how the value is read:
 * - `verdict`: one string at `pointer`, worded through `words` (value to plain words, "would
 *   ask you first"); a value `words` lacks stays the pack's token. `why`, when given, is the
 *   step's reason.
 * - `checks`: a list of checks at `results`, each entry read through `entry`'s pointers.
 * - `lists`: the lists at each `lists[].pointer`, counted, each count after its `words`
 *   ("would file"); `why`, when given, is the step's own summary.
 * A value that does not read so is shown as unreadable, never as a decision.
 */
const shadowSchema = z.discriminatedUnion('reads', [
  z.strictObject({
    ...shadowStepShape,
    reads: z.literal('verdict'),
    pointer: jsonPointerSchema,
    words: z
      .record(z.string().min(1), labelSchema)
      .refine(words => Object.keys(words).length > 0, 'names at least one value'),
    why: jsonPointerSchema.optional(),
  }),
  z.strictObject({
    ...shadowStepShape,
    reads: z.literal('checks'),
    results: jsonPointerSchema,
    entry: z.strictObject({
      name: jsonPointerSchema,
      passed: jsonPointerSchema,
      seconds: jsonPointerSchema.optional(),
      tail: jsonPointerSchema.optional(),
    }),
  }),
  z.strictObject({
    ...shadowStepShape,
    reads: z.literal('lists'),
    lists: z
      .array(z.strictObject({ pointer: jsonPointerSchema, words: labelSchema }))
      .min(1)
      .max(6),
    why: jsonPointerSchema.optional(),
  }),
]);

/** One plain sentence a person reads about what a run did: no placeholders, no markup. */
const sentenceSchema = z.string().trim().min(1).max(160);

/**
 * The item page's story, one plain sentence per run. `outcomes`: by `workflow:outcome`, or
 * `workflow:*` for every completed run no exact key takes, one with no outcome included (as in
 * `placement`); a sentence there may instead be `{ withChange, withoutChange }`, chosen by
 * whether the item has a change, for an outcome a run records alike with and without one (a
 * drop answered before any pull request). `steps`: the earlier stages of a run that works
 * several, by the step each starts on. `said`: pointers, in order, to what a run's result says in its own words. A
 * sentence is static text; a console adds only its own clauses (the pull request, why it was
 * sent back, what you answered). Checked by `storyReferenceIssues` and the coverage check.
 */
const storySchema = z.strictObject({
  outcomes: z.record(
    outcomeKeySchema,
    z.union([
      sentenceSchema,
      z.strictObject({ withChange: sentenceSchema, withoutChange: sentenceSchema }),
    ])
  ),
  steps: z.record(workflowNameSchema, z.record(stepIdSchema, sentenceSchema)).optional(),
  said: z.array(jsonPointerSchema).min(1).optional(),
});

const factoryViewShape = z.strictObject({
  version: z.literal(1),
  /** The pack this view draws: `owner/name` when installed, else its folder name. */
  pack: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/, 'a pack folder name or owner/name'),
  title: labelSchema,
  /** One paragraph, plain words: what goes in, what comes out, where people step in. */
  summary: z.string().min(1).max(1200),
  /** The stages an item moves through, left to right: map cards, stage pages, placement. */
  stages: z.array(stageSchema).min(1),
  /**
   * The board's columns, left to right, each a group of stages. Absent, the board draws one
   * column per stage, so an older file still loads.
   */
  columns: z.array(columnSchema).min(1).optional(),
  /**
   * Where an idle item sits after a run completed with this outcome; checked before
   * `endings`. `workflow:*` places every completed run of the workflow no exact key takes,
   * a run that returns no outcome included.
   */
  placement: z.record(outcomeKeySchema, stageIdSchema),
  /**
   * Outcomes that end an item without a change, with the label the folded row shows.
   * `workflow:*` takes every outcome no exact key does, not a run without one.
   */
  endings: z.record(outcomeKeySchema, labelSchema),
  /** The stage an item whose change merged sits in. */
  landed: z.strictObject({ stage: stageIdSchema }),
  /**
   * Where the board counts check rounds (`roundsSourceSchema`): one source, or a list naming
   * each workflow once when items are delivered by more than one shape. An item's rounds are
   * read from the source whose workflow ran a round on it most recently.
   */
  rounds: oneOrList(roundsSourceSchema, roundsSourceProblem).optional(),
  /** The steps whose outcome sends an item back. */
  returns: z.array(decisionPointSchema).optional(),
  /**
   * The steps whose outcome approves an item: a round (a loop iteration, or a stage-form run)
   * in which one of these recorded its outcome is approved. A round with neither a declared return nor a
   * declared approval needs a decision; nothing is read as approved unless declared here.
   */
  approves: z.array(decisionPointSchema).optional(),
  /**
   * What other steps' outcomes mean, so a console words them: by workflow, step id and
   * outcome. It decides nothing: only `returns` and `approves` decide a round, and an entry
   * restating one of theirs is refused, so the two cannot disagree. An outcome no entry
   * means stays the pack's token.
   */
  verdicts: z
    .record(
      workflowNameSchema,
      z.record(stepIdSchema, z.record(z.string().min(1), factoryVerdictMeaningSchema))
    )
    .optional(),
  /**
   * Completed outcomes that stop to ask you (`workflow:outcome`, or `workflow:*` for every
   * outcome, not a run without one). A run that ended so reads "asked you"; `placement` still
   * decides where the item waits.
   */
  asked: z.array(outcomeKeySchema).optional(),
  /**
   * Completed outcomes that leave the item open and idle by choice (`workflow:outcome`, or
   * `workflow:*`): kept for later, not ended. `label` words it ("Parked by triage"); `why`, when
   * given, points at the run's reason in its result. `placement` must take each key, since it
   * still decides where the item sits, and no exact `endings` key may name one.
   */
  parked: z
    .record(
      outcomeKeySchema,
      z.strictObject({ label: labelSchema, why: jsonPointerSchema.optional() })
    )
    .optional(),
  /**
   * Completed outcomes after which the item is open and waits on a person, though no ask is
   * open (`workflow:outcome`, or `workflow:*`): shaped again, say. A console shows
   * it in the needs-you colour and counts it among what needs you. `label` words it ("Needs
   * shaping"); `why` and `questions`, when given, point at the run's reason and at the list of
   * what the person has to settle in its result; `next`, when given, is one plain sentence
   * saying what the person does to move the item on, since nothing here is answered in place.
   * Placed and never ended, as `parked`; an outcome is parked or awaits, not both.
   */
  awaits: z
    .record(
      outcomeKeySchema,
      z.strictObject({
        label: labelSchema,
        why: jsonPointerSchema.optional(),
        questions: jsonPointerSchema.optional(),
        next: sentenceSchema.optional(),
      })
    )
    .optional(),
  /**
   * Workflows a stage lists that the installed pack no longer has, whose stored runs still
   * place, render and count. `bun run check:factory-view` neither requires the pack to have
   * them nor compares their steps, arrows or outcomes with its graph, and fails when the pack
   * has one again. No drill-down card or loop may name one: a stage draws only the workflows
   * the pack runs now, and a retired workflow has no step page to open.
   */
  retired: z.array(workflowNameSchema).optional(),
  /**
   * Where the change's URL is in a run's result: one source, or a list naming each workflow
   * once. The newest run of any listed workflow with a non-empty value at its pointer gives
   * the item's change.
   */
  change: oneOrList(changeSourceSchema, input =>
    sourceProblem('a change source { workflow, pointer }', changeSourceSchema, input)
  ).optional(),
  /**
   * Where a run's result names the item's work order (an item key), as a JSON pointer: read
   * when the item has no active `part_of` link, which wins when both exist. Only a run of
   * `workflow` that completed with `outcome` (the one that accepts the item) counts; the
   * newest such run decides, and an empty value there means none. A run that completed with
   * any other outcome (a refusal) never makes the item a member.
   */
  partOf: z
    .strictObject({
      workflow: workflowNameSchema,
      pointer: jsonPointerSchema,
      outcome: z.string().min(1),
    })
    .optional(),
  /**
   * Where the result of each completed run of `workflow` (a drain of what agents noticed
   * outside their scope) lists what it decided, as JSON pointers: `filed`, `held` and
   * `dropped` into the result, `entry` into each entry of `filed`. Its runs place no item, so
   * no stage need list it; `bun run check:factory-view` checks the pack has it. `shadow`: the
   * drain only decides what it would file and files nothing, so a console words it "would file".
   */
  discoveries: z
    .strictObject({
      workflow: workflowNameSchema,
      shadow: z.boolean(),
      filed: jsonPointerSchema,
      held: jsonPointerSchema,
      dropped: jsonPointerSchema,
      entry: z.strictObject({
        title: jsonPointerSchema,
        kind: jsonPointerSchema.optional(),
        verified: jsonPointerSchema.optional(),
      }),
    })
    .optional(),
  /**
   * The steps the pack runs as shadows (see `shadowSchema`), one entry per step. Each names
   * a workflow a stage lists, or the `discoveries` workflow; `bun run check:factory-view`
   * checks the step is real. When `discoveries` is given, its `shadow` flag and an entry
   * here naming its workflow must agree.
   */
  shadows: z.array(shadowSchema).min(1).optional(),
  /** The run input whose title line (after any front matter) is the item's title. */
  itemTitle: z.strictObject({ input: z.string().min(1) }).optional(),
  /**
   * Display names for a workflow's steps, keyed by the step id as the engine records it
   * (`build__build`, `rounds.fix`, the bare loop id `rounds`). A step with no name here
   * reads as its cleaned id. `bun run check:factory-view` reports a key naming no real step.
   */
  steps: z.record(workflowNameSchema, z.record(stepIdSchema, labelSchema)).optional(),
  /** What the item page says each run did (`storySchema`); absent, it words runs itself. */
  story: storySchema.optional(),
  /**
   * What choosing an option of an ask a run of `workflow` left starts, by `workflow:option`, in
   * one plain sentence ("Closes the PR without merging"). It decides nothing: the pack's
   * bindings do. A console shows it beside the option and in place of naming the run the answer
   * started; an option no key names reads as before. `bun run check:factory-view` reports a key
   * whose workflow has no asks-settled hand-off on that option.
   */
  answers: z.record(answerKeySchema, z.strictObject({ starts: sentenceSchema })).optional(),
  map: mapSchema,
});

type FactoryViewShape = z.infer<typeof factoryViewShape>;
type Issue = { path: (string | number)[]; message: string };

type FactoryChangeSource = z.infer<typeof changeSourceSchema>;
type FactoryRoundsSource = z.infer<typeof roundsSourceSchema>;
type FactoryLoopRounds = Extract<FactoryRoundsSource, { loop: string }>;
export type FactoryStageRounds = Extract<FactoryRoundsSource, { round: string }>;

/** The declared change sources as a list, a single one included; empty when none. */
export function changeSources(view: Pick<FactoryViewShape, 'change'>): FactoryChangeSource[] {
  return view.change === undefined ? [] : [view.change].flat();
}

/** The declared rounds sources as a list, a single one included; empty when none. */
export function roundsSources(view: Pick<FactoryViewShape, 'rounds'>): FactoryRoundsSource[] {
  return view.rounds === undefined ? [] : [view.rounds].flat();
}

export function isLoopRounds(source: FactoryRoundsSource): source is FactoryLoopRounds {
  return 'loop' in source;
}

/**
 * Each `change` and `rounds` source names a workflow a stage lists, each workflow once: two
 * sources for one workflow would leave which one reads its runs to list order.
 */
function sourceListIssues(view: FactoryViewShape): Issue[] {
  const workflows = new Set(view.stages.flatMap(stage => stage.workflows));
  const issues: Issue[] = [];
  const check = (field: 'change' | 'rounds', sources: readonly { workflow: string }[]): void => {
    const single = !Array.isArray(view[field]);
    const seen = new Set<string>();
    sources.forEach((source, index) => {
      const path = single ? [field, 'workflow'] : [field, index, 'workflow'];
      if (!workflows.has(source.workflow))
        issues.push({ path, message: `names workflow "${source.workflow}", which no stage lists` });
      if (seen.has(source.workflow))
        issues.push({ path, message: `workflow "${source.workflow}" is listed twice` });
      seen.add(source.workflow);
    });
  };
  check('change', changeSources(view));
  check('rounds', roundsSources(view));
  return issues;
}

/** Every place a declaration names a stage must name one it declares. */
function stageReferenceIssues(view: FactoryViewShape): Issue[] {
  const stages = new Set<string>();
  const issues: Issue[] = [];
  view.stages.forEach((stage, index) => {
    if (stages.has(stage.id))
      issues.push({
        path: ['stages', index, 'id'],
        message: `stage "${stage.id}" is declared twice`,
      });
    stages.add(stage.id);
  });
  const refer = (path: Issue['path'], stage: string, allowed?: string): void => {
    if (stages.has(stage) || stage === allowed) return;
    issues.push({ path, message: `names stage "${stage}", which is not declared in stages` });
  };
  for (const [key, stage] of Object.entries(view.placement)) refer(['placement', key], stage);
  refer(['landed', 'stage'], view.landed.stage);
  view.map.cards.forEach((card, index) => {
    refer(['map', 'cards', index, 'stage'], card.stage);
  });
  view.map.arrows.forEach((arrow, index) => {
    refer(['map', 'arrows', index, 'from'], arrow.from);
    refer(['map', 'arrows', index, 'to'], arrow.to);
  });
  view.map.notes?.forEach((note, index) => {
    refer(['map', 'notes', index, 'near'], note.near, FACTORY_VIEW_NEEDS_YOU);
  });
  return issues;
}

/**
 * When `columns` is given, every declared stage is in exactly one column, and the `landed`
 * stage in a column of its own: the board's merged column (its recent window, its header and
 * its compact cards) is a whole column, so one that also held other stages would be ambiguous.
 */
function columnIssues(view: FactoryViewShape): Issue[] {
  if (view.columns === undefined) return [];
  const declared = new Set(view.stages.map(stage => stage.id));
  const ids = new Set<string>();
  const holder = new Map<string, string>();
  const issues: Issue[] = [];
  view.columns.forEach((column, c) => {
    if (ids.has(column.id))
      issues.push({
        path: ['columns', c, 'id'],
        message: `column "${column.id}" is declared twice`,
      });
    ids.add(column.id);
    column.stages.forEach((stage, s) => {
      const path = ['columns', c, 'stages', s];
      const already = holder.get(stage);
      if (!declared.has(stage))
        issues.push({ path, message: `names stage "${stage}", which is not declared in stages` });
      else if (already !== undefined)
        issues.push({ path, message: `stage "${stage}" is in column "${already}" already` });
      else holder.set(stage, column.id);
    });
    if (column.stages.includes(view.landed.stage) && column.stages.length > 1)
      issues.push({
        path: ['columns', c, 'stages'],
        message: `the landed stage "${view.landed.stage}" takes a column of its own`,
      });
  });
  for (const stage of view.stages)
    if (!holder.has(stage.id))
      issues.push({ path: ['columns'], message: `stage "${stage.id}" is in no column` });
  return issues;
}

/** Every workflow the declaration reads outcomes or steps of is one a stage counts. */
function workflowReferenceIssues(view: FactoryViewShape): Issue[] {
  const workflows = new Set(view.stages.flatMap(stage => stage.workflows));
  const issues: Issue[] = [];
  const refer = (path: Issue['path'], workflow: string): void => {
    if (!workflows.has(workflow))
      issues.push({ path, message: `names workflow "${workflow}", which no stage lists` });
  };
  const workflowOf = (key: string): string => key.slice(0, key.lastIndexOf(':'));
  for (const key of Object.keys(view.placement)) refer(['placement', key], workflowOf(key));
  for (const key of Object.keys(view.endings)) refer(['endings', key], workflowOf(key));
  view.returns?.forEach((entry, index) => {
    refer(['returns', index, 'workflow'], entry.workflow);
  });
  view.approves?.forEach((entry, index) => {
    refer(['approves', index, 'workflow'], entry.workflow);
  });
  if (view.partOf !== undefined) refer(['partOf', 'workflow'], view.partOf.workflow);
  // Not `discoveries`: its runs place no item, so it is the one workflow no stage need list.
  for (const workflow of Object.keys(view.steps ?? {})) refer(['steps', workflow], workflow);
  for (const workflow of Object.keys(view.verdicts ?? {})) refer(['verdicts', workflow], workflow);
  view.asked?.forEach((key, index) => {
    refer(['asked', index], workflowOf(key));
  });
  for (const field of ['parked', 'awaits'] as const)
    for (const key of Object.keys(view[field] ?? {})) refer([field, key], workflowOf(key));
  for (const key of Object.keys(view.answers ?? {})) refer(['answers', key], workflowOf(key));
  return issues;
}

/** A `verdicts` entry may not restate a declared return or approval. */
function verdictOverlapIssues(view: FactoryViewShape): Issue[] {
  const decided = new Set(
    [...(view.returns ?? []), ...(view.approves ?? [])].map(point =>
      JSON.stringify([point.workflow, point.node, point.outcome])
    )
  );
  const issues: Issue[] = [];
  for (const [workflow, steps] of Object.entries(view.verdicts ?? {}))
    for (const [node, outcomes] of Object.entries(steps))
      for (const outcome of Object.keys(outcomes))
        if (decided.has(JSON.stringify([workflow, node, outcome])))
          issues.push({
            path: ['verdicts', workflow, node, outcome],
            message: 'is declared in returns or approves already',
          });
  return issues;
}

/**
 * Each shadow names a workflow a stage lists, or the `discoveries` workflow (its runs place no
 * item, so no stage lists it, as in `workflowReferenceIssues`); no step is declared twice.
 */
function shadowReferenceIssues(view: FactoryViewShape): Issue[] {
  const workflows = new Set(view.stages.flatMap(stage => stage.workflows));
  if (view.discoveries !== undefined) workflows.add(view.discoveries.workflow);
  const seen = new Set<string>();
  const issues: Issue[] = [];
  view.shadows?.forEach((shadow, index) => {
    if (!workflows.has(shadow.workflow))
      issues.push({
        path: ['shadows', index, 'workflow'],
        message: `names workflow "${shadow.workflow}", which no stage lists`,
      });
    const key = JSON.stringify([shadow.workflow, shadow.node]);
    if (seen.has(key))
      issues.push({
        path: ['shadows', index, 'node'],
        message: `step "${shadow.workflow}/${shadow.node}" is declared a shadow twice`,
      });
    seen.add(key);
  });
  return issues;
}

/**
 * `discoveries.shadow` and `shadows` say the same thing about the drain, so they must agree:
 * a shadow drain has an entry naming its workflow, and one that files for real has none.
 */
function discoveriesShadowIssues(view: FactoryViewShape): Issue[] {
  const { discoveries } = view;
  if (discoveries === undefined) return [];
  const declared = (view.shadows ?? []).some(shadow => shadow.workflow === discoveries.workflow);
  if (declared === discoveries.shadow) return [];
  return [
    {
      path: ['discoveries', 'shadow'],
      message: discoveries.shadow
        ? `is true, but no entry of shadows names workflow "${discoveries.workflow}"`
        : `is false, but shadows names workflow "${discoveries.workflow}"`,
    },
  ];
}

export const factoryViewSchema = factoryViewShape.superRefine((view, ctx) => {
  for (const issue of [
    ...stageReferenceIssues(view),
    ...columnIssues(view),
    ...workflowReferenceIssues(view),
    ...sourceListIssues(view),
    ...verdictOverlapIssues(view),
    ...heldOpenIssues(view),
    ...retiredIssues(view),
    ...drilldownIssues(view),
    ...shadowReferenceIssues(view),
    ...discoveriesShadowIssues(view),
    ...storyReferenceIssues(view),
  ])
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export type FactoryView = z.infer<typeof factoryViewSchema>;
export type FactoryStage = FactoryView['stages'][number];
export type FactoryDrilldown = NonNullable<FactoryStage['drilldown']>;
export type FactoryShadow = NonNullable<FactoryView['shadows']>[number];

/** Where a view was found: a pack's own file, or the project's file for a pack. */
export const factoryViewSourceSchema = z.enum([...workflowSourceSchema.options, 'project-file']);
export type FactoryViewSource = z.infer<typeof factoryViewSourceSchema>;

export const factoryViewsListingSchema = z.object({
  views: z.array(
    z.object({
      /** The declaration's pack: `owner/name` when installed, else its folder name. */
      pack: z.string(),
      /** The pack's folder key (`owner.name` when installed): the `{pack}` of `GET /api/packs/{pack}/graph`. */
      packKey: z.string(),
      /**
       * Each workflow a stage lists, as the view names it, to the name its runs record and
       * the pack graph's stages carry (`owner/name:workflow` when installed).
       */
      runNames: z.record(z.string(), z.string()),
      source: factoryViewSourceSchema,
      /** The file the view was read from. */
      path: z.string(),
      declaration: factoryViewSchema,
    })
  ),
  /** Declarations that could not be read or did not validate, each with its file. */
  errors: z.array(
    z.object({
      pack: z.string(),
      source: factoryViewSourceSchema,
      path: z.string(),
      error: z.string(),
    })
  ),
});
export type FactoryViewsListing = z.infer<typeof factoryViewsListingSchema>;
