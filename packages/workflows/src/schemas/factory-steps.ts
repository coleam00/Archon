/**
 * A workflow's steps as a console draws them: every step the engine runs, keyed as run
 * events name it, with the loop groups and included workflows that frame it, the prompt it
 * runs and the YAML its author wrote. `factory-steps.ts` builds it from the engine's own
 * composed definition. Objects are not strict, so a reader keeps working when a field is added.
 */
import { z } from 'zod';
import { WHEN_OPERATORS } from '../when-atom';

/** What a step does, in the words the console shows: an agent, a shell command, a script... */
const factoryStepKindSchema = z.enum([
  'agent',
  'bash',
  'script',
  'loop',
  'approval',
  'wait',
  'other',
]);
export type FactoryStepKind = z.infer<typeof factoryStepKindSchema>;

/**
 * One comparison of a `when:`, through the engine's own parser: the step or workflow input
 * it reads, the operator and the value. A step is named by its key as run events name it
 * (`rounds.verdict__verdict`, the loop id `rounds`), so a console can print it by the name
 * it prints the step by; a reference the workflow has no step for keeps the id written.
 */
const factoryWhenAtomSchema = z.object({
  reads: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('step'), key: z.string() }),
    z.object({ kind: z.literal('input'), name: z.string() }),
  ]),
  operator: z.enum(WHEN_OPERATORS),
  /** The right-hand value, unquoted. */
  value: z.string(),
});

/**
 * A `when:` as its comparisons: any one clause holds when all of its comparisons do. Null
 * without a `when:`, or when the engine's parser does not take it (`when` still says it).
 */
const whenClausesSchema = z.array(z.array(factoryWhenAtomSchema)).nullable();
export type FactoryWhenAtom = z.infer<typeof factoryWhenAtomSchema>;
export type FactoryWhenClauses = z.infer<typeof whenClausesSchema>;

const factoryStepGroupSchema = z.object({
  /** A step-key prefix: `rounds` for a loop group, `rounds.review` for an include in it. */
  id: z.string(),
  kind: z.enum(['loop', 'include']),
  /** The group this one is drawn inside, or null at the top. */
  parent: z.string().nullable(),
  /** A loop: its id. An include: the included workflow's name. */
  label: z.string(),
  /** A loop: the most rounds it runs. Null for an include. */
  maxRounds: z.number().int().nullable(),
  /** A loop's own `when:`, verbatim. */
  when: z.string().nullable(),
  /** `when` as its comparisons, for a label read at a glance. */
  whenClauses: whenClausesSchema,
  /** A loop: the step keys or group ids it waits on. Empty for an include. */
  dependsOn: z.array(z.string()),
});
export type FactoryStepGroup = z.infer<typeof factoryStepGroupSchema>;

/**
 * One reference the engine would substitute into a step's prompt, found with its own grammar
 * (`output-ref.ts`): `token` is the text as written, so a console can find it again without a
 * grammar of its own. An output reference names the step it reads by key, as `whenClauses` do.
 */
const factoryStepReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), token: z.string(), name: z.string() }),
  z.object({
    /** `$node.output[.path]` this round, or `$LOOP_PREV.node.output[.path]` the round before. */
    kind: z.enum(['output', 'prior-output']),
    token: z.string(),
    key: z.string(),
    path: z.string().nullable(),
  }),
]);
export type FactoryStepReference = z.infer<typeof factoryStepReferenceSchema>;

/** The code a bash or script step runs: inline in its YAML, or the named script's file. */
const factoryStepScriptSchema = z.object({
  runtime: z.enum(['sh', 'bun', 'uv']),
  /** The script's name when the step runs a named script file; null for an inline body. */
  name: z.string().nullable(),
  body: z.string(),
});

const factoryStepSchema = z.object({
  /** The step's id as run events name it: `rounds.fix`, `rounds.review__review`, `exhausted`. */
  key: z.string(),
  /** The id its author wrote: `fix`, `review`. */
  label: z.string(),
  /** The innermost group it is drawn in, or null at the top. */
  group: z.string().nullable(),
  /** The step keys or loop group ids it waits on. */
  dependsOn: z.array(z.string()),
  kind: factoryStepKindSchema,
  /** The workflow that declared the step, when it came in through `include:`. */
  includedFrom: z.string().nullable(),
  /** The model or tier list as declared, such as `["@builder", "large"]`. */
  model: z.array(z.string()).nullable(),
  /** Its `when:` condition as the engine runs it. */
  when: z.string().nullable(),
  /** `when` as its comparisons, for a label read at a glance. */
  whenClauses: whenClausesSchema,
  /** The command file it runs, by name. */
  command: z.string().nullable(),
  /** The prompt it runs, as markdown. Null for a step that runs none. */
  prompt: z.string().nullable(),
  /** Why the prompt could not be read, when a prompt was expected. */
  promptError: z.string().nullable(),
  /**
   * The workflow inputs and step outputs its prompt reads, unique by token, in order of first
   * appearance; empty without a prompt. Engine variables (`$ARTIFACTS_DIR`) are not listed:
   * they are places the engine fills in, not what the step reads.
   */
  references: z.array(factoryStepReferenceSchema),
  /** What a bash or script step runs; null for any other step, or when it could not be read. */
  script: factoryStepScriptSchema.nullable(),
  /** Why the named script a step runs could not be read. */
  scriptError: z.string().nullable(),
  /** The step's block as its author wrote it. */
  yaml: z.string().nullable(),
  /** Why `yaml` is null. */
  yamlError: z.string().nullable(),
});
export type FactoryStep = z.infer<typeof factoryStepSchema>;

export const factoryWorkflowSchema = z.object({
  /** The workflow as the factory view names it: `deliver`. */
  name: z.string(),
  /** The workflow as runs record it: `owner/name:deliver` for an installed pack. */
  runName: z.string(),
  /** In definition order; a loop's body follows the steps before it. */
  steps: z.array(factoryStepSchema),
  /** Every loop and include group, outer before inner. */
  groups: z.array(factoryStepGroupSchema),
});
export type FactoryWorkflow = z.infer<typeof factoryWorkflowSchema>;
