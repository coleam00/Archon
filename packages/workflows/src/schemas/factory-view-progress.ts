/**
 * Where a factory view (`factory-view.ts`) says a console finds an item's progress in its runs'
 * records: which step outcomes return or approve an item, where a check round's number and
 * allowance are, and where a run names the change it delivered. Presentation still: the engine
 * reads none of it; a console counts rounds and returns from generic run records with it.
 * Each name is checked against the pack graph by `factory-view-check.ts`.
 */
import { z } from 'zod';

/** A stage's `workflow` name, as `factory-view.ts` names stages. */
const workflowNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a stage workflow name');
/** A step id as the engine records it: `<include>__<node>`, `<group>.<node>` in a loop body. */
const stepIdSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, 'a step id');
/** A JSON pointer (RFC 6901) into a run's structured result. */
const jsonPointerSchema = z.string().regex(/^\//, 'a JSON pointer starting with /');

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Why `input` is not a `schema` (a source called `kind`), naming the key to fix. A failed
 * union reports only "Invalid input", which leaves a view file's author nothing to act on.
 */
function sourceProblem(kind: string, schema: z.ZodType, input: unknown): string {
  if (!isRecord(input)) return `expected ${kind}`;
  const issues = schema.safeParse(input).error?.issues ?? [];
  // A misspelt key is the cause of the missing one it was meant to be: name it first.
  const issue = issues.find(entry => entry.code === 'unrecognized_keys') ?? issues[0];
  if (issue === undefined) return `${kind} is invalid`;
  if (issue.code === 'unrecognized_keys')
    return `${kind} does not take ${issue.keys.map(key => `\`${key}\``).join(', ')}`;
  const key = String(issue.path[0]);
  return input[key] === undefined
    ? `${kind} needs \`${key}\``
    : `${kind}'s \`${key}\`: ${issue.message}`;
}

/** One source, or a non-empty list of them; a failure names the entry and the key. */
function oneOrList<T extends z.ZodType>(source: T, problem: (input: unknown) => string) {
  return z.union([source, z.array(source).min(1)], {
    error: issue => {
      const { input } = issue;
      if (!Array.isArray(input)) return problem(input);
      if (input.length === 0) return 'a list names at least one source';
      const bad = input.findIndex(entry => !source.safeParse(entry).success);
      return bad === -1 ? 'is invalid' : `entry ${String(bad)}: ${problem(input[bad])}`;
    },
  });
}

/** A step of a workflow the view names, and the outcome it records that decides something. */
export const decisionPointSchema = z.strictObject({
  workflow: workflowNameSchema,
  node: stepIdSchema,
  outcome: z.string().min(1),
});

/** Where a workflow's runs name the change's URL in their result. */
export const changeSourceSchema = z.strictObject({
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

export const roundsSourceSchema = z.union([loopRoundsSchema, stageRoundsSchema], {
  error: issue => roundsSourceProblem(issue.input),
});

/**
 * A retired workflow, and the graph stage (by its `workflow` name) an item standing on one of
 * its runs is placed at. A bare name places nowhere: such an item is set aside.
 */
export const retiredSchema = z.union([
  workflowNameSchema,
  z.strictObject({ workflow: workflowNameSchema, stage: workflowNameSchema }),
]);

/** The progress fields of a factory view; `factory-view.ts` spreads them into its schema. */
export const progressDeclarations = {
  /**
   * Workflows the pack graph no longer has whose stored runs still count (a pack's older
   * delivery shape), each a name or `{ workflow, stage }`. The check fails a retired workflow
   * the graph has again, and a `stage` the graph has not in its flow, and cannot compare a
   * retired workflow's steps or loops with a graph that lacks them. Read it through
   * `retiredEntries`.
   */
  retired: z.array(retiredSchema).optional(),
  /**
   * Where a console counts check rounds: one source, or a list naming each workflow once when
   * items were delivered by more than one shape. An item's rounds are read from the source
   * whose workflow ran a round on it most recently.
   */
  rounds: oneOrList(roundsSourceSchema, roundsSourceProblem).optional(),
  /**
   * The steps whose outcome sends an item back. `returns` owns the count; an outcome's
   * `reads: "returned"` owns how the item reads after its run, and the check keeps the two in
   * agreement stage by stage.
   */
  returns: z.array(decisionPointSchema).optional(),
  /**
   * The steps whose outcome approves an item's round. A round with neither a declared return
   * nor a declared approval is undecided: nothing reads as approved unless declared here.
   */
  approves: z.array(decisionPointSchema).optional(),
  /**
   * Where the change's URL is in a run's result: one source, or a list naming each workflow
   * once. The newest run of a listed workflow with a value at its pointer gives the change.
   */
  change: oneOrList(changeSourceSchema, input =>
    sourceProblem('a change source { workflow, pointer }', changeSourceSchema, input)
  ).optional(),
};

export type FactoryDecisionPoint = z.infer<typeof decisionPointSchema>;
export type FactoryRoundsSource = z.infer<typeof roundsSourceSchema>;
export type FactoryChangeSource = z.infer<typeof changeSourceSchema>;

/** A `retired` entry as one shape: its workflow, and the stage it places at (null: none). */
export interface FactoryRetired {
  workflow: string;
  stage: string | null;
}

/** The view's `retired` entries, each as `{ workflow, stage }`; empty when absent. */
export function retiredEntries(view: {
  retired?: z.infer<typeof retiredSchema>[] | undefined;
}): FactoryRetired[] {
  return (view.retired ?? []).map(entry =>
    typeof entry === 'string' ? { workflow: entry, stage: null } : entry
  );
}

/** A declaration given as one source or a list, as a list; empty when absent. */
export function sourcesOf<T extends object>(declared: T | T[] | undefined): T[] {
  if (declared === undefined) return [];
  return Array.isArray(declared) ? declared : [declared];
}
