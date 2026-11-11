/**
 * The `bindings:` block of a pack declaration, validated when the pack loads.
 *
 * Each binding is a timer (`schedule:`) or an event (`event:`) binding. The checks that
 * span bindings run here, where all are visible: a sibling reference names a declared
 * timer binding, an event field is read only by an event binding, and bindings sharing a
 * resource agree on its capacity, which admission would otherwise refuse at the first
 * start.
 */
import type { Fail } from './pack-settings';
import {
  isPackTimerBinding,
  packBindingNameSchema,
  packEventBindingSchema,
  packTimerBindingSchema,
  type PackBinding,
} from './schemas/pack-bindings';

function parseBinding(id: string, raw: unknown, fail: Fail): PackBinding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`binding '${id}' must be a mapping`);
  }
  const timer = 'schedule' in raw;
  if (timer === 'event' in raw) {
    return fail(`binding '${id}' must set exactly one of 'schedule' (a timer) or 'event'`);
  }
  const parsed = (timer ? packTimerBindingSchema : packEventBindingSchema).safeParse(raw);
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
  checkSharedCapacities(bindings, fail);
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
      if (isPackTimerBinding(binding)) {
        fail(`binding '${id}' input '${name}' reads an event field, but a timer has no event`);
      }
      continue;
    }
    const sibling = Object.hasOwn(bindings, input.binding) ? bindings[input.binding] : undefined;
    if (sibling === undefined) {
      fail(`binding '${id}' input '${name}' names unknown binding '${input.binding}'`);
    } else if (!isPackTimerBinding(sibling)) {
      fail(
        `binding '${id}' input '${name}' names event binding '${input.binding}'; only a timer binding is a file a run can fire`
      );
    }
  }
}

function checkSharedCapacities(bindings: Readonly<Record<string, PackBinding>>, fail: Fail): void {
  const first = new Map<string, { id: string; capacity: number }>();
  for (const [id, binding] of Object.entries(bindings)) {
    const resource = `${binding.resource_scope}:${binding.resource}`;
    const seen = first.get(resource);
    if (seen === undefined) first.set(resource, { id, capacity: binding.capacity });
    else if (seen.capacity !== binding.capacity) {
      fail(
        `bindings '${seen.id}' and '${id}' share resource '${binding.resource}' but declare capacity ${seen.capacity} and ${binding.capacity}`
      );
    }
  }
}
