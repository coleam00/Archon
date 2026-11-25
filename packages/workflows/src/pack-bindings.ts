/**
 * The `bindings:` block of a pack declaration, validated when the pack loads.
 *
 * Each binding is a timer (`schedule:`), an event (`event:`), a run-ended binding
 * (`run_ended:`), an asks-settled binding (`asks_settled:`) or, with none of them, a
 * fire-only binding. The checks that span bindings run here, where all are visible: a
 * sibling reference names a declared binding that is written as a file `trigger fire`
 * reads (a timer or fire-only binding), an event field is read only by an event binding, the
 * met wait only by an event binding with `wake`, a
 * part of the run only by a run-ended or asks-settled binding, the ended run's item key
 * only by a run-ended binding, a linked entry only by a linked run-ended binding with
 * `items`, the settled answers only by an asks-settled binding, and the item's answers by
 * either, except a linked run-ended binding. A `grants` names a declared binding with a
 * `limit`.
 */
import type { Fail } from './pack-settings';
import { readsItemAnswers, readsLinkedEntry } from './schemas/binding-input-source';
import {
  packBindingKind,
  packBindingNameSchema,
  packAsksSettledBindingSchema,
  packEventBindingSchema,
  packFireBindingSchema,
  packRunEndedBindingSchema,
  packTimerBindingSchema,
  type PackBinding,
  type PackBindingInput,
  type PackBindingKind,
} from './schemas/pack-bindings';

const START_SCHEMAS = [
  ['schedule', packTimerBindingSchema],
  ['event', packEventBindingSchema],
  ['run_ended', packRunEndedBindingSchema],
  ['asks_settled', packAsksSettledBindingSchema],
] as const;

function parseBinding(id: string, raw: unknown, fail: Fail): PackBinding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`binding '${id}' must be a mapping`);
  }
  const starts = START_SCHEMAS.filter(([key]) => key in raw);
  if (starts.length > 1) {
    return fail(
      `binding '${id}' must set at most one of 'schedule', 'event', 'run_ended' and 'asks_settled'`
    );
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
  for (const [id, binding] of Object.entries(bindings)) {
    checkInputs(id, binding, bindings, fail);
    checkGrants(id, binding, bindings, fail);
  }
  return bindings;
}

/** A grant raises a declared limit, so it must name a binding that has one. */
function checkGrants(
  id: string,
  binding: PackBinding,
  bindings: Readonly<Record<string, PackBinding>>,
  fail: Fail
): void {
  if (!('grants' in binding) || binding.grants === undefined) return;
  const granted = Object.hasOwn(bindings, binding.grants) ? bindings[binding.grants] : undefined;
  if (granted === undefined) fail(`binding '${id}' grants unknown binding '${binding.grants}'`);
  else if (granted.limit === undefined)
    fail(`binding '${id}' grants binding '${binding.grants}', which declares no limit`);
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
  const waitInputs = Object.entries(binding.inputs).filter(
    ([, input]) => typeof input === 'object' && 'wait' in input
  );
  if (waitInputs.length > 1)
    fail(
      `binding '${id}' inputs ${waitInputs.map(([name]) => `'${name}'`).join(' and ')} both read the met wait; read it once`
    );
}

function inputProblem(
  binding: PackBinding,
  input: PackBindingInput,
  bindings: Readonly<Record<string, PackBinding>>
): string | undefined {
  if (typeof input === 'string' || 'repo' in input) return undefined;
  if ('binding' in input) return siblingProblem(input.binding, bindings);
  const kind = packBindingKind(binding);
  if ('event' in input)
    return kind === 'event'
      ? undefined
      : 'reads an event field, but only an event binding has an event';
  if ('wait' in input)
    return kind === 'event' && 'wake' in binding && binding.wake !== undefined
      ? undefined
      : 'reads the met wait, but only an event binding with wake has one';
  return runSourceProblem(binding, kind, input);
}

/** An input read from the run that ended or left the asks, or from the item it is on. */
function runSourceProblem(
  binding: PackBinding,
  kind: PackBindingKind,
  input: Exclude<PackBindingInput, string>
): string | undefined {
  if ('answers' in input)
    return kind === 'asks_settled'
      ? undefined
      : 'reads the settled answers, but only an asks-settled binding has them';
  if (readsItemAnswers(input)) return itemAnswersProblem(binding, kind);
  if (readsLinkedEntry(input))
    return 'run_ended' in binding && binding.run_ended.linked?.items !== undefined
      ? undefined
      : 'reads a linked entry, but only a run-ended binding with linked.items has one per started item';
  if ('item' in input)
    return kind === 'run_ended'
      ? undefined
      : "reads the ended run's item key, but only a run-ended binding has one";
  return kind === 'run_ended' || kind === 'asks_settled'
    ? undefined
    : 'reads the ended run, but only a run-ended or asks-settled binding has a run to read';
}

/** The item's answers belong to the item a run-ended or asks-settled start is on. */
function itemAnswersProblem(binding: PackBinding, kind: PackBindingKind): string | undefined {
  if (kind !== 'run_ended' && kind !== 'asks_settled')
    return "reads the item's answers, but only a run-ended or asks-settled binding starts on an item that has them";
  return 'run_ended' in binding && binding.run_ended.linked !== undefined
    ? "reads the item's answers, but a linked start is on a holder item; read them in the started stage"
    : undefined;
}

/** A sibling reference is written as a file path, so it must name a file a run can fire. */
function siblingProblem(
  id: string,
  bindings: Readonly<Record<string, PackBinding>>
): string | undefined {
  const sibling = Object.hasOwn(bindings, id) ? bindings[id] : undefined;
  if (sibling === undefined) return `names unknown binding '${id}'`;
  const kind = packBindingKind(sibling);
  if (kind === 'timer' || kind === 'fire') return undefined;
  const named = { event: 'event', run_ended: 'run-ended', asks_settled: 'asks-settled' }[kind];
  return `names ${named} binding '${id}'; only a timer or fire-only binding is a file a run can fire`;
}
