/**
 * The `bindings:` block of a pack declaration, validated when the pack loads.
 *
 * Each binding is a timer (`schedule:`), an event (`event:`) or, with neither, a fire-only
 * binding. The checks that span bindings run here, where all are visible: a sibling
 * reference names a declared binding that is written as a file `trigger fire` reads (a
 * timer or fire-only binding), and an event field is read only by an event binding.
 */
import type { Fail } from './pack-settings';
import {
  packBindingKind,
  packBindingNameSchema,
  packEventBindingSchema,
  packFireBindingSchema,
  packTimerBindingSchema,
  type PackBinding,
} from './schemas/pack-bindings';

function parseBinding(id: string, raw: unknown, fail: Fail): PackBinding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`binding '${id}' must be a mapping`);
  }
  const timer = 'schedule' in raw;
  const event = 'event' in raw;
  if (timer && event) {
    return fail(`binding '${id}' must not set both 'schedule' (a timer) and 'event'`);
  }
  // The key's presence picks the schema, so `schedule:` with no value fails as a timer.
  const schema = timer
    ? packTimerBindingSchema
    : event
      ? packEventBindingSchema
      : packFireBindingSchema;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at '${issue.path.join('.')}'` : '';
  return fail(`binding '${id}' is invalid${where}: ${issue?.message ?? 'unknown error'}`);
}

/**
 * @param raw the mapping under `bindings:`, by binding id.
 * @throws through `fail`, naming the binding and the key.
 */
export function parsePackBindings(
  raw: Readonly<Record<string, unknown>>,
  fail: Fail
): Record<string, PackBinding> {
  const bindings: Record<string, PackBinding> = {};
  for (const [id, rawBinding] of Object.entries(raw)) {
    // The id becomes part of a file name and a binding id.
    if (!packBindingNameSchema.safeParse(id).success) {
      fail(`binding '${id}' is not a valid id: use lowercase letters, digits and hyphens`);
    }
    bindings[id] = parseBinding(id, rawBinding, fail);
  }
  for (const [id, binding] of Object.entries(bindings)) checkInputs(id, binding, bindings, fail);
  return bindings;
}

function checkInputs(
  id: string,
  binding: PackBinding,
  bindings: Readonly<Record<string, PackBinding>>,
  fail: Fail
): void {
  for (const [name, input] of Object.entries(binding.inputs)) {
    if (typeof input === 'string' || 'repo' in input) continue;
    if ('event' in input) {
      if (packBindingKind(binding) !== 'event') {
        fail(
          `binding '${id}' input '${name}' reads an event field, but only an event binding has an event`
        );
      }
      continue;
    }
    const sibling = Object.hasOwn(bindings, input.binding) ? bindings[input.binding] : undefined;
    if (sibling === undefined) {
      fail(`binding '${id}' input '${name}' names unknown binding '${input.binding}'`);
    } else if (packBindingKind(sibling) === 'event') {
      fail(
        `binding '${id}' input '${name}' names event binding '${input.binding}'; only a timer or fire-only binding is a file a run can fire`
      );
    }
  }
}
