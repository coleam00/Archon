/**
 * Pack bindings: the trigger bindings a pack recommends, declared once under `bindings:`
 * in its `.pack/pack.yaml`.
 *
 * A declaration starts nothing. `archon pack bindings` turns it into binding files for one
 * repository, written to `--out`. The operator registers every file; a run-ended or
 * asks-settled file is registered by copying it into the triggers directory, where it is
 * active at once. The declaration holds what the pack knows (the workflow, what starts
 * it, how starts may overlap, its inputs, the item a start is on); the operator supplies
 * what only the install knows (the repository, the host, the run-as user, the checkout).
 */
import { z } from 'zod';
import { jsonValueSchema } from '../output-ref';
import {
  asksSettledInputSourceSchema,
  asksSettledTriggerSchema,
  itemMappingSchema,
  resourceStartBindingIntentSchema,
  resourceStartOverlapSchema,
  runEndedTriggerSchema,
  trustedTextDeclarationSchema,
} from './resource-start';

/** A binding id and a resource name both end up in a file name and a resource key. */
const BINDING_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const packBindingNameSchema = z
  .string()
  .regex(BINDING_NAME_PATTERN, 'must be lowercase letters, digits and hyphens');

/**
 * One launch input: literal text, a part of the operator's repository, the file written
 * for a sibling binding, (event bindings only) a field of the event, (run-ended and
 * asks-settled bindings only) a part of the run that ended or left the asks, as
 * `on.runEnded.inputs` reads it, or (asks-settled bindings only) the settled answers.
 */
const packBindingInputSchema = z.union([
  z.string(),
  z.object({ repo: z.enum(['host', 'path']) }).strict(),
  z.object({ binding: packBindingNameSchema }).strict(),
  z.object({ event: z.string().min(1) }).strict(),
  ...asksSettledInputSourceSchema.options,
]);
export type PackBindingInput = z.infer<typeof packBindingInputSchema>;

const bindingShape = {
  workflow: z.string().min(1),
  /** The resource's last segment; `resource_scope` supplies the rest. */
  resource: packBindingNameSchema,
  /** `host` for work that spans every repository on the host, so one resource guards it. */
  resource_scope: z.enum(['repo', 'host']).default('repo'),
  capacity: resourceStartBindingIntentSchema.shape.capacity,
  overlap: resourceStartOverlapSchema,
  isolation: resourceStartBindingIntentSchema.shape.launch.shape.isolation.default({
    kind: 'default',
  }),
  inputs: z.record(z.string().min(1), packBindingInputSchema).default({}),
};

export const packTimerBindingSchema = z
  .object({
    ...bindingShape,
    schedule: z.object({ interval_seconds: z.number().int().positive() }).strict(),
  })
  .strict();

/**
 * `event` is the source plugin's selector without its `repository`, which the operator
 * supplies. Its vocabulary belongs to the plugin that reads the generated binding, so it
 * is checked there, when a binding is generated, and not restated here.
 */
export const packEventBindingSchema = z
  .object({
    ...bindingShape,
    event: z
      .record(z.string(), jsonValueSchema)
      .refine(event => !Object.hasOwn(event, 'repository'), {
        message: "must not name 'repository'; the operator supplies it",
      }),
    /** `field` is one of the source plugin's event fields, checked there like `event`. */
    item: itemMappingSchema.optional(),
    trustedText: trustedTextDeclarationSchema.optional(),
  })
  .strict();

const runEndedOutcomeSchema = runEndedTriggerSchema.shape.outcome;

/** The engine picks the lane of a start on another run's checkout, so none is fixed here. */
const checkoutTakesDefaultIsolation = {
  check: (binding: {
    isolation: { kind: string };
    run_ended?: { checkout?: string };
    asks_settled?: { checkout?: string };
  }): boolean =>
    (binding.run_ended?.checkout === undefined && binding.asks_settled?.checkout === undefined) ||
    binding.isolation.kind === 'default',
  message: {
    message: "with checkout, isolation must be left out: the engine picks the start's lane",
    path: ['isolation'],
  },
};

/**
 * Starts when a run of `run_ended.workflow`, a workflow of this pack, completes with one
 * of the outcomes on an item. A trigger file holds one outcome, so each listed outcome
 * is written as its own file. `checkout: ended-run` starts it in the checkout the run
 * left, as `on.runEnded.checkout` does.
 */
export const packRunEndedBindingSchema = z
  .object({
    ...bindingShape,
    run_ended: z
      .object({
        workflow: z.string().min(1),
        outcome: z.union([
          runEndedOutcomeSchema,
          z
            .array(runEndedOutcomeSchema)
            .min(1)
            .refine(outcomes => new Set(outcomes).size === outcomes.length, {
              message: 'outcomes must be distinct',
            }),
        ]),
        checkout: runEndedTriggerSchema.shape.checkout,
      })
      .strict(),
  })
  .strict()
  .refine(checkoutTakesDefaultIsolation.check, checkoutTakesDefaultIsolation.message);

/**
 * Starts when the asks a run of `asks_settled.workflow`, a workflow of this pack, left on
 * an item are settled, as `on.asksSettled` does: `settled` and `checkout` read as there.
 */
export const packAsksSettledBindingSchema = z
  .object({
    ...bindingShape,
    asks_settled: z
      .object({
        workflow: z.string().min(1),
        settled: asksSettledTriggerSchema.shape.settled,
        checkout: asksSettledTriggerSchema.shape.checkout,
      })
      .strict(),
  })
  .strict()
  .refine(checkoutTakesDefaultIsolation.check, checkoutTakesDefaultIsolation.message);

/**
 * A binding no clock, no event, no ended run and no settled asks start: only
 * `archon trigger fire` does, from a run or an operator. It is its own strict shape, so a
 * `schedule:`, `event:`, `run_ended:` or `asks_settled:` key that is present but invalid
 * is refused by its own schema and never read as fire-only.
 */
export const packFireBindingSchema = z
  .object({
    ...bindingShape,
    /** `field` is a key of the fire's `--inputs`, the only event a fire has. */
    item: itemMappingSchema.optional(),
  })
  .strict();

export type PackTimerBinding = z.infer<typeof packTimerBindingSchema>;
export type PackEventBinding = z.infer<typeof packEventBindingSchema>;
export type PackFireBinding = z.infer<typeof packFireBindingSchema>;
export type PackRunEndedBinding = z.infer<typeof packRunEndedBindingSchema>;
export type PackAsksSettledBinding = z.infer<typeof packAsksSettledBindingSchema>;
export type PackBinding =
  | PackTimerBinding
  | PackEventBinding
  | PackRunEndedBinding
  | PackAsksSettledBinding
  | PackFireBinding;

/**
 * A binding with what starts it: a `timer`, an `event`, an ended run, settled asks, or
 * only a `fire`.
 */
export type KindedPackBinding =
  | { kind: 'timer'; binding: PackTimerBinding }
  | { kind: 'event'; binding: PackEventBinding }
  | { kind: 'run_ended'; binding: PackRunEndedBinding }
  | { kind: 'asks_settled'; binding: PackAsksSettledBinding }
  | { kind: 'fire'; binding: PackFireBinding };
export type PackBindingKind = KindedPackBinding['kind'];

/** The one place a binding's kind is read off its shape. */
export function kindedPackBinding(binding: PackBinding): KindedPackBinding {
  if ('schedule' in binding) return { kind: 'timer', binding };
  if ('event' in binding) return { kind: 'event', binding };
  if ('run_ended' in binding) return { kind: 'run_ended', binding };
  if ('asks_settled' in binding) return { kind: 'asks_settled', binding };
  return { kind: 'fire', binding };
}

export function packBindingKind(binding: PackBinding): PackBindingKind {
  return kindedPackBinding(binding).kind;
}
