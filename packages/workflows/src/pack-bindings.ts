/**
 * The `bindings:` block of a pack declaration, validated when the pack loads.
 *
 * Each binding is a timer (`schedule:`), an event (`event:`), a run-ended binding
 * (`run_ended:`) or, with none of them, a fire-only binding. The checks that span bindings
 * run here, where all are visible: a sibling reference names a declared binding that is
 * written as a file `trigger fire` reads (a timer or fire-only binding), an event field is
 * read only by an event binding, and a part of an ended run only by a run-ended binding.
 */
import type { Fail } from './pack-settings';
import {
  packBindingKind,
  packBindingNameSchema,
  packEventBindingSchema,
  packFireBindingSchema,
  packRunEndedBindingSchema,
  packTimerBindingSchema,
  type PackBinding,
  type PackBindingInput,
} from './schemas/pack-bindings';

const START_SCHEMAS = [
  ['schedule', packTimerBindingSchema],
  ['event', packEventBindingSchema],
  ['run_ended', packRunEndedBindingSchema],
] as const;

function parseBinding(id: string, raw: unknown, fail: Fail): PackBinding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`binding '${id}' must be a mapping`);
  }
  const starts = START_SCHEMAS.filter(([key]) => key in raw);
  if (starts.length > 1) {
    return fail(`binding '${id}' must set at most one of 'schedule', 'event' and 'run_ended'`);
  }
  // The key's presence picks the schema, so `schedule:` with no value fails as a timer.
  const schema = starts[0]?.[1] ?? packFireBindingSchema;
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
    const problem = inputProblem(binding, input, bindings);
    if (problem !== undefined) fail(`binding '${id}' input '${name}' ${problem}`);
  }
}

function inputProblem(
  binding: PackBinding,
  input: PackBindingInput,
  bindings: Readonly<Record<string, PackBinding>>
): string | undefined {
  if (typeof input === 'string' || 'repo' in input) return undefined;
  const kind = packBindingKind(binding);
  if ('event' in input)
    return kind === 'event'
      ? undefined
      : 'reads an event field, but only an event binding has an event';
  if (!('binding' in input))
    return kind === 'run_ended'
      ? undefined
      : 'reads the ended run, but only a run-ended binding has an ended run';
  const sibling = Object.hasOwn(bindings, input.binding) ? bindings[input.binding] : undefined;
  if (sibling === undefined) return `names unknown binding '${input.binding}'`;
  const siblingKind = packBindingKind(sibling);
  if (siblingKind === 'timer' || siblingKind === 'fire') return undefined;
  return `names ${siblingKind === 'event' ? 'event' : 'run-ended'} binding '${input.binding}'; only a timer or fire-only binding is a file a run can fire`;
}
