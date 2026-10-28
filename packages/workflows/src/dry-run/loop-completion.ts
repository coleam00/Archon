import { LOOP_COMPLETION_CHANNELS, type LoopCompletionChannel } from '../schemas/loop';
import type { LoopNode } from '../schemas';
import { detectCompletionSignal } from '../executor-shared';

/** The completion channels a simulated loop may declare. */
export type LoopChannels = Pick<LoopNode['loop'], LoopCompletionChannel>;

/** What the dry run can conclude about one simulated iteration. */
export type SimulatedCompletion =
  | { kind: 'field' }
  | { kind: 'signal' }
  | { kind: 'assumed' }
  | { kind: 'incomplete' };

/**
 * Would this iteration's output end the loop, as far as a dry run can tell?
 *
 * Two of the three channels are decidable from a stub and one is not:
 *  - `until_field` IS evaluable — a stub object is hydrated onto
 *    `NodeOutput.structuredOutput`, so the engine's own `=== true` rule can be
 *    applied exactly. Guessing here would be strictly worse than deciding.
 *  - `until` IS evaluable — run the same detector the executor runs.
 *  - `until_bash` is NOT: the simulator executes nothing.
 *
 * So: an evaluable channel that fires wins. If none fires but an unevaluable one is
 * declared, assume completion — reporting a max-iterations failure the real run
 * would not produce is the worse lie, and the trace reason names the channel that
 * went unevaluated. If none fires and there is nothing unevaluable to hide behind,
 * the iteration genuinely did not complete.
 *
 * Note the reach of that middle rule (#2563): it fires whenever `until_bash` is
 * declared, INCLUDING alongside an `until:` whose sentinel the stub did not carry.
 * That combination previously simulated as a max-iterations failure. Assuming completion
 * is the honest answer — the real run's `until_bash` may well have fired — but it
 * does mean a dry run cannot prove a prose stub trips `until:` on a loop that also
 * declares `until_bash`. Drop `until_bash` from the workflow, or stub the sentinel,
 * if that is what you are trying to check.
 */
export function loopIterationCompletes(
  control: LoopChannels,
  hydrated: { output: string; structuredOutput?: unknown }
): SimulatedCompletion {
  let fieldComplete = false;
  let signalComplete = false;
  let assumed = false;
  for (const { field } of LOOP_COMPLETION_CHANNELS) {
    switch (field) {
      case 'until_field': {
        const payload = hydrated.structuredOutput;
        fieldComplete =
          control.until_field !== undefined &&
          payload !== null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>)[control.until_field] === true;
        break;
      }
      case 'until':
        signalComplete =
          control.until !== undefined && detectCompletionSignal(hydrated.output, control.until);
        break;
      case 'until_bash':
        assumed = control.until_bash !== undefined;
        break;
      default: {
        const unhandled: never = field;
        return unhandled;
      }
    }
  }
  if (fieldComplete) return { kind: 'field' };
  if (signalComplete) return { kind: 'signal' };
  if (assumed) return { kind: 'assumed' };
  return { kind: 'incomplete' };
}

/** Trace reason for a simulated loop completion — see {@link loopIterationCompletes}. */
export function completionReason(
  completion: SimulatedCompletion,
  control: LoopChannels,
  iterations: number
): string {
  const n = String(iterations);
  switch (completion.kind) {
    case 'field':
      return `'${control.until_field ?? ''}' is true after ${n} iteration(s)`;
    case 'signal':
      return `completion signal after ${n} iteration(s)`;
    default:
      return `assumed complete after ${n} iteration(s) — 'until_bash' is not executed in a dry run`;
  }
}
