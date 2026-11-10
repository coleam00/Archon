/**
 * Pack bindings: the trigger bindings a pack recommends, declared once under `bindings:`
 * in its `.pack/pack.yaml`.
 *
 * A declaration starts nothing. `archon pack bindings` turns it into binding files for one
 * repository, and the operator registers each file. The declaration holds what the pack
 * knows (the workflow, its timer or event, how starts may overlap, its inputs); the
 * operator supplies what only the install knows (the repository, the host, the run-as
 * user, the checkout).
 */
import { z } from 'zod';
import { jsonValueSchema } from '../output-ref';
import {
  resourceSlotCapacitySchema,
  resourceStartBindingIntentSchema,
  resourceStartOverlapSchema,
} from './resource-start';

/** A binding id and a resource name both end up in a file name and a resource key. */
const BINDING_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const packBindingNameSchema = z
  .string()
  .regex(BINDING_NAME_PATTERN, 'must be lowercase letters, digits and hyphens');

/**
 * One launch input: literal text, a part of the operator's repository, the file written
 * for a sibling binding, or (event bindings only) a field of the event.
 */
const packBindingInputSchema = z.union([
  z.string(),
  z.object({ repo: z.enum(['host', 'path']) }).strict(),
  z.object({ binding: packBindingNameSchema }).strict(),
  z.object({ event: z.string().min(1) }).strict(),
]);
export type PackBindingInput = z.infer<typeof packBindingInputSchema>;

const bindingShape = {
  workflow: z.string().min(1),
  /** The resource's last segment; `resource_scope` supplies the rest. */
  resource: packBindingNameSchema,
  /** `host` for work that spans every repository on the host, so one resource guards it. */
  resource_scope: z.enum(['repo', 'host']).default('repo'),
  capacity: resourceSlotCapacitySchema,
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
  })
  .strict();

export type PackTimerBinding = z.infer<typeof packTimerBindingSchema>;
export type PackEventBinding = z.infer<typeof packEventBindingSchema>;
export type PackBinding = PackTimerBinding | PackEventBinding;

export function isPackTimerBinding(binding: PackBinding): binding is PackTimerBinding {
  return 'schedule' in binding;
}
