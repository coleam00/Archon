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
  | { kind: 'bash' }
  | { kind: 'incomplete' };

export function loopIterationCompletes(
  control: LoopChannels,
  hydrated: { output: string; structuredOutput?: unknown },
  bash: 'assumed' | 'complete' | 'incomplete' = 'assumed'
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
        assumed = control.until_bash !== undefined && bash === 'assumed';
        break;
      default: {
        const unhandled: never = field;
        return unhandled;
      }
    }
  }
  if (fieldComplete) return { kind: 'field' };
  if (signalComplete) return { kind: 'signal' };
  if (control.until_bash !== undefined && bash === 'complete') return { kind: 'bash' };
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
    case 'bash':
      return `until_bash completed after ${n} iteration(s)`;
    default:
      return `assumed complete after ${n} iteration(s) — 'until_bash' is not executed in a dry run`;
  }
}
