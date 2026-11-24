/**
 * Whether an item is held open by its last run: parked (kept for later by an outcome the view
 * file declares `parked`), or waiting on a person (an outcome it declares `awaits`). Nothing here
 * names a pack's outcome or words; the declaration gives the label and where in the run's
 * result its reason and questions are. Placement still decides where it sits.
 */
import { z } from 'zod';
import { resolveJsonPointer } from './json-pointer';
import type { JsonValue } from './output-ref';
import type { FactoryView } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { displayedRunOutcome, type WorkflowRun } from './schemas/workflow-run';
import { getTerminalRecord } from './terminal-record';

/** The trimmed, non-empty string at `pointer` in a completed run's result; else null. */
export function resultString(
  pointer: string,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): string | null {
  if (run.status !== 'completed') return null;
  const record = getTerminalRecord(run.status, events);
  if (record?.returns.availability !== 'available') return null;
  const value = resolveJsonPointer(record.returns.value as JsonValue, pointer);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * The entry of `entries` (the view's `parked` or `awaits`) a completed run of `workflow` (as the
 * view names it) takes: its exact `workflow:outcome` key, else `workflow:*`. As in `asked`, `*`
 * takes every outcome, not a run that recorded none.
 */
function heldEntry<T>(
  entries: Record<string, T> | undefined,
  workflow: string | null,
  run: WorkflowRun
): T | undefined {
  const outcome = displayedRunOutcome(run);
  if (run.status !== 'completed' || workflow === null || outcome === null) return undefined;
  return entries?.[`${workflow}:${outcome}`] ?? entries?.[`${workflow}:*`];
}

/**
 * The non-empty trimmed strings of the list at `pointer` in a completed run's result; empty when
 * there is no list there. An entry that is not a string, or is blank, is left out.
 */
function resultStrings(
  pointer: string,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): string[] {
  if (run.status !== 'completed') return [];
  const record = getTerminalRecord(run.status, events);
  if (record?.returns.availability !== 'available') return [];
  const value = resolveJsonPointer(record.returns.value as JsonValue, pointer);
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const text = typeof entry === 'string' ? entry.trim() : '';
    return text === '' ? [] : [text];
  });
}

/**
 * What a run that parked its item says: the declared label, and the reason at the entry's `why`
 * pointer in its result (null when the entry names none or the result has no non-empty string
 * there). Null when the run did not complete with an outcome the view declares `parked`.
 */
export function runParked(
  view: FactoryView,
  workflow: string | null,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): { label: string; why: string | null } | null {
  const entry = heldEntry(view.parked, workflow, run);
  if (entry === undefined) return null;
  return {
    label: entry.label,
    why: entry.why === undefined ? null : resultString(entry.why, run, events),
  };
}

/** What an item waiting on a person reads (`runAwaits`), as the progress read carries it. */
export const factoryAwaitsSchema = z.object({
  label: z.string(),
  why: z.string().nullable(),
  questions: z.array(z.string()),
  next: z.string().nullable(),
});

/**
 * What a run that left its item waiting on a person says: the declared label and `next`, the
 * reason at the entry's `why` pointer and the questions at its `questions` pointer in its result
 * (null, and empty, when the entry names none or the result has none there). Null when the run did not
 * complete with an outcome the view declares `awaits`.
 */
export function runAwaits(
  view: FactoryView,
  workflow: string | null,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): z.infer<typeof factoryAwaitsSchema> | null {
  const entry = heldEntry(view.awaits, workflow, run);
  if (entry === undefined) return null;
  return {
    label: entry.label,
    why: entry.why === undefined ? null : resultString(entry.why, run, events),
    questions: entry.questions === undefined ? [] : resultStrings(entry.questions, run, events),
    next: entry.next ?? null,
  };
}
