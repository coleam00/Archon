/**
 * What a person reads about a workflow, its nodes and its outcomes, authored where each is
 * named (`display:`), and the plain facts a reader needs to tell a workflow's runs apart. The
 * engine validates and serves them (the pack graph) and runs nothing differently for them: a
 * workflow without `display:` behaves exactly as one with it.
 *
 * Nothing here has a meaning to the engine. An icon, a card's kind, a result name and a loop
 * name are opaque slugs a reader maps to its own vocabulary, as a pack group's `kind` is
 * (`pack-document.ts`); a mark's `means` is checked against the readers' vocabulary by
 * `archon validate` only (`DISPLAY_MARK_MEANINGS`), so this engine still loads a newer pack's.
 *
 * Words never stop a run. The loader reads `display:` field by field (`parseDisplay`, and
 * `parseDagNodes` for a node's): an unknown key, a malformed field or a field naming what the
 * workflow lacks (`loader/display-contract.ts`) is dropped with a warning, as a bad pack group
 * is. The schemas below are strict so that each such field is caught and named, not loaded.
 */
import { z } from 'zod';

const labelSchema = z.string().trim().min(1).max(80);
const sentenceSchema = z.string().trim().min(1).max(160);
/** An opaque lowercase slug a reader gives its own meaning (an icon, a kind, a `means`). */
const slugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase slug');
/** A name a reader looks a value up by (a result, a loop): letters, digits, `_` and `-`. */
const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'a name');
/**
 * A step id as the engine records it: an included workflow's node is `<include>__<node>`, a
 * loop group's body node `<group>.<node>`.
 */
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a step id');
/** A JSON pointer (RFC 6901) into a run's returned result. */
const pointerSchema = z.string().regex(/^\//, 'a JSON pointer starting with /');

/**
 * What a run that ended with this outcome did, in one sentence. The two-sentence form tells
 * a run whose item has a proposed change from one whose item has none yet.
 */
export const outcomeStorySchema = z.union([
  sentenceSchema,
  z.strictObject({ withChange: sentenceSchema, withoutChange: sentenceSchema }),
]);

export const outcomeDisplaySchema = z.strictObject({
  label: labelSchema.optional(),
  story: outcomeStorySchema.optional(),
});
export type OutcomeDisplay = z.infer<typeof outcomeDisplaySchema>;

/** A node's name for a person, and an optional longer line saying what it does. */
export const nodeDisplaySchema = z.strictObject({
  label: labelSchema,
  text: sentenceSchema.optional(),
});
export type NodeDisplay = z.infer<typeof nodeDisplaySchema>;

/** One card of the workflow told in plain words: a box standing for some of its steps. */
export const displayCardSchema = z.strictObject({
  title: labelSchema,
  text: sentenceSchema,
  icon: slugSchema,
  /** Who does it, as a slug a reader colours by. */
  kind: slugSchema,
  /** The steps the card stands for, by the ids the engine records them under. */
  covers: z.array(stepIdSchema).min(1),
});

/** A few numbered phases, each holding a few cards. */
export const displayPhaseSchema = z.strictObject({
  label: labelSchema,
  cards: z.array(displayCardSchema).min(1).max(6),
});

/**
 * The `means` a reader gives a mark: `returns`, the run sent its item back to an earlier stage;
 * `approves`, the run passed it on. `archon validate` errors on any other, so a misspelt one
 * is caught rather than silently dropping a count; the loader keeps any slug.
 */
export const DISPLAY_MARK_MEANINGS = ['returns', 'approves'] as const;

/**
 * A step's outcome value that means something to a reader: `means` is the reader's slug for
 * it (`DISPLAY_MARK_MEANINGS`). The engine runs nothing differently for it.
 */
export const displayMarkSchema = z.strictObject({
  node: stepIdSchema,
  outcome: z.string().min(1),
  means: slugSchema,
});

/** Named places in the workflow's returned result, each a JSON pointer, by a reader's name. */
const resultsSchema = z.record(nameSchema, pointerSchema);

/**
 * A workflow the pack no longer has whose stored runs a reader still counts as this
 * workflow's: its own marks and result pointers, and `loops`, the loop groups of its runs a
 * reader counts by name. Its node ids cannot be checked: the pack has no YAML for it.
 */
export const displayReplacedSchema = z.strictObject({
  workflow: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a workflow name'),
  loops: z.record(nameSchema, stepIdSchema).optional(),
  marks: z.array(displayMarkSchema).min(1).optional(),
  results: resultsSchema.optional(),
});

/** A workflow's words without its outcomes' and the rest: its name and line. */
export const workflowWordsSchema = z.strictObject({
  label: labelSchema,
  short: z.string().trim().min(1).max(24).optional(),
  blurb: z.string().trim().min(1).max(300).optional(),
  /** The story of a run whose outcome gives none of its own (or that has no outcome). */
  story: outcomeStorySchema.optional(),
});

/**
 * A workflow's `display:`. `outcomes` is keyed by the values the workflow's declared outcome
 * (`returns.outcome`) can take; `phases[].cards[].covers` and `marks[].node` name its steps.
 * The loader drops a field naming anything else, with a warning (`loader/display-contract.ts`).
 * An ask option's words are not here: they are the option's `label` in `returns.options`.
 */
export const workflowDisplaySchema = z.strictObject({
  ...workflowWordsSchema.shape,
  outcomes: z.record(z.string().min(1), outcomeDisplaySchema).optional(),
  phases: z.array(displayPhaseSchema).min(1).optional(),
  marks: z.array(displayMarkSchema).min(1).optional(),
  results: resultsSchema.optional(),
  replaces: z.array(displayReplacedSchema).min(1).optional(),
});
export type WorkflowDisplay = z.infer<typeof workflowDisplaySchema>;

/** What the pack graph serves of a workflow's `display:` on its stage: all but `outcomes`. */
export const stageDisplaySchema = workflowDisplaySchema.omit({ outcomes: true });

/** A workflow's `display:` without its outcomes', as the pack graph serves it on its stage. */
export function stageDisplay(display: WorkflowDisplay | undefined): {
  display?: z.infer<typeof stageDisplaySchema>;
} {
  if (display === undefined) return {};
  const { outcomes: _outcomes, ...rest } = display;
  return { display: rest };
}

/** The words `display.outcomes` gives one outcome value, as the pack graph serves them. */
export function outcomeWords(
  display: WorkflowDisplay | undefined,
  value: string
): { display?: OutcomeDisplay } {
  const words = display?.outcomes?.[value];
  return words === undefined ? {} : { display: words };
}
