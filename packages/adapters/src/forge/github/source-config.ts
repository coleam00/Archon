/**
 * The GitHub source plugin's configuration schema, apart from the plugin so that a reader
 * that must not bundle the plugin (the CLI's `pack bindings`) checks a binding against the
 * plugin's own schema rather than a copy of it.
 */
import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';
import {
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventFieldSchema,
  forgeEventSelectorSchema,
  isForgeEventFieldAvailable,
} from '@archon/forge';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import {
  bindingWakeSchema,
  itemMappingSchema,
  resourceStartBindingIntentSchema,
} from '@archon/workflows/schemas/resource-start';

export const githubSourceBindingSchema = resourceStartBindingIntentSchema
  .omit({
    bindingRevision: true,
    eventInputs: true,
    checkoutFrom: true,
    itemKey: true,
    wake: true,
    // Only an asks-settled binding grants a limit one more start.
    grants: true,
  })
  .extend({
    selector: forgeEventSelectorSchema,
    inputMapping: z.record(z.string(), createForgeInputBindingSchema(jsonValueSchema)),
    item: itemMappingSchema.extend({ field: forgeEventFieldSchema }).optional(),
    /**
     * Wake the open wait `wait` a run of `workflow` left on an item of this binding's
     * project, when the event's `about` field holds exactly the value the wait names; the
     * engine matches it when it accepts the receipt. The met wait is passed as input `input`
     * when set. An event that names its subject (an issue or pull request) must map `item`
     * as well, and only a wait on that item matches: a commit does not name a pull request.
     * A check event names no single subject, so it matches on `about` alone. `inputs`
     * maps inputs from the run that left the met wait (`{ input }`) and the item's answers
     * (`{ item: answers }`), and `checkout: waiting-run` starts the stage in the checkout
     * that run recorded; the engine reads both when it matches the wait.
     */
    wake: z
      .object({
        workflow: z.string().min(1),
        wait: z.string().min(1),
        about: z.object({ field: forgeEventFieldSchema }).strict(),
        input: bindingWakeSchema.shape.input,
        inputs: bindingWakeSchema.shape.inputs,
        checkout: bindingWakeSchema.shape.checkout,
      })
      .strict()
      .optional(),
  });

/** Why a binding's `wake` cannot be read against its selector, by path within the binding. */
function wakeProblems(
  binding: z.infer<typeof githubSourceBindingSchema>
): { path: string[]; message: string }[] {
  const { wake, selector } = binding;
  if (wake === undefined) return [];
  const problems: { path: string[]; message: string }[] = [];
  if (!binding.item && isForgeEventFieldAvailable(selector.kind, 'subject.number'))
    problems.push({
      path: ['item'],
      message: `A ${selector.kind} event names its subject, so a binding with wake maps it as item: only a wait on that item may be woken`,
    });
  if (!isForgeEventFieldAvailable(selector.kind, wake.about.field))
    problems.push({
      path: ['wake', 'about', 'field'],
      message: `${wake.about.field} is unavailable for ${selector.kind}`,
    });
  if (wake.input !== undefined && Object.hasOwn(binding.inputMapping, wake.input))
    problems.push({
      path: ['wake', 'input'],
      message: `input '${wake.input}' is also mapped from the event; name the met wait's input once`,
    });
  for (const name of Object.keys(wake.inputs ?? {}))
    if (Object.hasOwn(binding.inputMapping, name) || name === wake.input)
      problems.push({
        path: ['wake', 'inputs', name],
        message: `input '${name}' is also mapped from the event or the met wait; map it once`,
      });
  if (wake.checkout !== undefined && binding.launch.isolation.kind !== 'default')
    problems.push({
      path: ['launch', 'isolation'],
      message: "with checkout, isolation must be left out: the engine picks the start's lane",
    });
  return problems;
}

export const githubWebhookSourceConfigSchema = z
  .object({
    version: z.literal(1),
    /** Unset for a source that only observes waits: it then receives no webhook. */
    webhookSecretEnv: z.string().min(1).optional(),
    host: z.literal('github.com'),
    bindings: z.array(githubSourceBindingSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    const mappingSchema = createForgeBindingSchema(jsonValueSchema);
    for (const [index, binding] of config.bindings.entries()) {
      if (seen.has(binding.bindingId))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      seen.add(binding.bindingId);
      const mapping = mappingSchema.safeParse({
        selector: binding.selector,
        inputs: binding.inputMapping,
      });
      if (!mapping.success)
        for (const issue of mapping.error.issues)
          context.addIssue({
            code: 'custom',
            path: ['bindings', index, ...issue.path],
            message: issue.message,
          });
      if (binding.item && !isForgeEventFieldAvailable(binding.selector.kind, binding.item.field))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'item', 'field'],
          message: `${binding.item.field} is unavailable for ${binding.selector.kind}`,
        });
      for (const problem of wakeProblems(binding))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, ...problem.path],
          message: problem.message,
        });
      if (!isAbsolute(binding.launch.cwd))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'launch', 'cwd'],
          message: 'Expected an absolute execution path',
        });
    }
  });
