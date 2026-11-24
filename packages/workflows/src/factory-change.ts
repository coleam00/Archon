/**
 * An item's change: the one a run names at a declared `change` source's pointer in its result,
 * with the run's forge audit rows (`runChange`), and the one the item shows, picked from its
 * runs' and its recorded merge, with its merge state (`changeOf`). Split from
 * `factory-items.ts`, which owns the shapes these fill.
 */
import type { FactoryChangeMerged, FactoryItemProgress, FactoryRunFacts } from './factory-items';
import { resolveJsonPointer } from './json-pointer';
import type { JsonValue } from './output-ref';
import { changeSources, type FactoryView } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import { getTerminalRecord } from './terminal-record';

function changeFacts(
  pointer: string,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): FactoryRunFacts['change'] {
  const record = getTerminalRecord(run.status, events);
  if (record?.returns.availability !== 'available') return null;
  const url = resolveJsonPointer(record.returns.value as JsonValue, pointer);
  if (typeof url !== 'string') return null;
  const audits = events
    .filter(row => row.event_type === 'integration_operation')
    .map(row => row.data);
  const trimmed = url.trim();
  return { url: trimmed === '' ? null : trimmed, audits };
}

/** The run's change, at the pointer of the change source naming its workflow; null when none does. */
export function runChange(
  view: FactoryView,
  workflow: string | null,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): FactoryRunFacts['change'] {
  const source = changeSources(view).find(entry => entry.workflow === workflow);
  return source === undefined ? null : changeFacts(source.pointer, run, events);
}

/**
 * Which change to ask about: a change URL with the forge audit rows of the run that recorded
 * it, or, when no run named a URL, the pull request on the item's run branches, keyed by the
 * newest run of the change workflow that delivered without one.
 */
export type FactoryChangeLookup =
  | { kind: 'url'; url: string; audits: readonly unknown[] }
  | { kind: 'branch'; run: string };

/**
 * The merge the engine recorded on the item (a land run's, or `archon workflow merged`'s): the
 * change it names and when it merged. A merge does not come undone, so it is read before the
 * change host is asked, and an item that carries one is never asked whether it merged.
 */
export interface FactoryChangeRecord {
  change: string;
  at: string;
}

/**
 * The URL, merge state and pull request number of a change, given the branches the item's
 * declared runs recorded, newest first (for a URL lookup, read only when its audit rows name
 * no pull request), and the item's recorded merge: when there is one, the answer is merged
 * as recorded at once and the change host is not asked whether it merged (at most, in the
 * background, for a pull request number no audit row names).
 */
export type FactoryChangeState = (
  lookup: FactoryChangeLookup,
  branches: () => Promise<readonly string[]>,
  recorded: FactoryChangeRecord | null
) => Promise<{
  url: string | null;
  merged: FactoryChangeMerged;
  mergedAt: string | null;
  number: number | null;
}>;

/**
 * The item's change: the latest declared run that named a URL at the change pointer, as it
 * named it. When none did, the pull request on the item's run branches, but only when a run
 * delivered with an empty URL there and some run recorded a branch, so an item that has not
 * reached delivery never asks the change host. An item with neither but a recorded merge (a
 * person merged it and recorded it) shows the recorded change, merged.
 */
export async function changeOf(
  declared: readonly WorkflowRun[],
  latest: <T>(pick: (run: WorkflowRun, fact: FactoryRunFacts) => T | null) => T | null,
  changeState: FactoryChangeState,
  branchOf: (run: WorkflowRun) => Promise<string | null>,
  recorded: FactoryChangeRecord | null
): Promise<FactoryItemProgress['change']> {
  const named = latest((_run, fact) =>
    fact.change?.url ? { url: fact.change.url, audits: fact.change.audits } : null
  );
  if (named !== null) {
    const answer = await changeState(
      { kind: 'url', ...named },
      () => runBranches(declared, branchOf),
      recorded
    );
    return { ...answer, url: named.url };
  }
  const unnamed = latest((run, fact) => (fact.change !== null ? run : null));
  const branches = unnamed === null ? [] : await runBranches(declared, branchOf);
  if (unnamed === null || branches.length === 0)
    return recorded === null
      ? null
      : { url: recorded.change, merged: true, mergedAt: recorded.at, number: null };
  return changeState({ kind: 'branch', run: unnamed.id }, async () => branches, recorded);
}

/** The distinct branches `runs` recorded, newest-started first. */
async function runBranches(
  runs: readonly WorkflowRun[],
  branchOf: (run: WorkflowRun) => Promise<string | null>
): Promise<string[]> {
  const branches = await Promise.all([...runs].reverse().map(run => branchOf(run)));
  return [...new Set(branches.filter((branch): branch is string => branch !== null))];
}
