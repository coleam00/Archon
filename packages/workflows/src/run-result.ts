/**
 * A completed run's result as another run reads it: the `returns:` value its terminal
 * record holds, read from the database only, so it reads the same on every host. The
 * spill file of a text result past the output cap is never read.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { jsonValueSchema, type JsonValue } from './output-ref';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import type { RunPhase } from './executor-shared';
import type { ResolvedWorkflow, WorkflowExecutionResult, WorkflowRun } from './schemas';
import { readSubrunMetadata, runInputsMetadata, SUBRUN_METADATA_KEYS } from './schemas';
import { splitAttentionRead } from './schemas/attention-degraded';
import type { IWorkflowStore } from './store';
import { getTerminalRecord, type TerminalRecordEvent } from './terminal-record';
import { requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-result');
  return cachedLog;
}

export type RunResultRead = { kind: 'result'; value: JsonValue } | { kind: 'none'; reason: string };

/**
 * The result `run` completed with. A run that did not complete has none, even when its
 * `returns:` node finished first. Throws when the terminal record does not parse: an
 * unreadable record is not "no result".
 */
export function readCompletedRunResult(
  run: Pick<WorkflowRun, 'status'>,
  events: readonly TerminalRecordEvent[]
): RunResultRead {
  if (run.status !== 'completed') return { kind: 'none', reason: `it is ${run.status}` };
  const record = getTerminalRecord(run.status, events);
  if (record === null) return { kind: 'none', reason: 'it has no terminal record' };
  const { returns } = record;
  switch (returns.availability) {
    case 'available':
      return { kind: 'result', value: jsonValueSchema.parse(returns.value) };
    case 'truncated':
      return {
        kind: 'none',
        reason: `its returns node '${returns.node_id}' output text past the output cap; declare output_format on it to make its result readable`,
      };
    case 'unavailable':
      return { kind: 'none', reason: `its result is unavailable (${returns.reason})` };
  }
}

/** Which run, if any, a `result_of` input read, and what it read. */
export interface LatestResult {
  runId: string | null;
  result: RunResultRead;
}

type ItemResultStore = Pick<IWorkflowStore, 'getItemRuns' | 'listEventsForRuns'>;

/**
 * The result of the latest completed run of each named workflow on an item: greatest
 * `completed_at`, a tie to the run that started later. No older run is read in its place,
 * so an item run whose row does not read throws: it may be the latest, and an unreadable
 * row names no workflow to rule it out.
 */
export async function latestResultsOnItem(
  store: ItemResultStore,
  item: { projectKey: string; key: string },
  workflowNames: readonly string[]
): Promise<Map<string, LatestResult>> {
  const found = await store.getItemRuns(item.projectKey, item.key);
  if (found === null) throw new Error(`Item '${item.key}' was not found`);
  const { values: runs, degraded } = splitAttentionRead(found.runs);
  if (degraded.length > 0)
    throw new Error(
      `item runs ${degraded.map(report => report.runId).join(', ')} did not read, and any of them may be the latest`
    );
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (run.status !== 'completed' || run.completed_at === null) continue;
    const held = latest.get(run.workflow_name);
    if (held?.completed_at && held.completed_at > run.completed_at) continue;
    latest.set(run.workflow_name, run);
  }
  const read = workflowNames.flatMap(name => latest.get(name) ?? []);
  const events =
    read.length === 0
      ? new Map()
      : await store.listEventsForRuns(
          read.map(run => run.id),
          ['workflow_completed'],
          // A tolerant read turns a malformed record into an empty one, which reads as none.
          { strict: true }
        );
  const results = new Map<string, LatestResult>();
  for (const name of workflowNames) {
    const run = latest.get(name);
    results.set(
      name,
      run === undefined
        ? { runId: null, result: { kind: 'none', reason: 'no completed run on the item' } }
        : { runId: run.id, result: readCompletedRunResult(run, events.get(run.id) ?? []) }
    );
  }
  return results;
}

/** The declared `result_of` inputs a fresh run was not supplied, by input name. */
export function unsuppliedResultInputs(
  workflow: Pick<ResolvedWorkflow, 'inputs'>,
  startInputs: Readonly<Record<string, JsonValue>> | undefined
): Map<string, string> {
  return new Map(
    Object.entries(workflow.inputs ?? {}).flatMap(([name, spec]) =>
      spec.result_of !== undefined && !Object.hasOwn(startInputs ?? {}, name)
        ? [[name, spec.result_of] as const]
        : []
    )
  );
}

/**
 * A run whose `result_of` inputs were not supplied reads them from its item, so with no
 * item it is refused before it does any work. A `workflow:` child carries no item, so its
 * parent must pass such an input through `with:`.
 */
export async function refuseResultInputsWithoutItem(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  resultInputs: ReadonlyMap<string, string>
): Promise<WorkflowExecutionResult | undefined> {
  const [first] = resultInputs;
  if (first === undefined || workflowRun.item_id !== null) return undefined;
  const [input, source] = first;
  const reason = `Workflow '${workflow.name}' reads input '${input}' from result_of '${source}', which resolves from the run's item: start it with --item <key>, or supply '${input}'`;
  await sendCriticalMessage(platform, conversationId, `❌ **Workflow not started**: ${reason}`);
  await requireTerminalStatusWrite(
    deps.store.cancelWorkflowRun(
      workflowRun.id,
      { cancel_reason: 'precondition_failed' },
      { pendingOnly: true }
    ),
    { workflowRunId: workflowRun.id, site: 'workflow.result_inputs_without_item_refused' }
  );
  return { success: false, workflowRunId: workflowRun.id, error: reason };
}

/**
 * Fill a claimed fresh run's unsupplied `result_of` inputs from its item and write them
 * into its `$INPUTS`, once, so a resume keeps them. Says on the run's conversation what
 * each input read. A store error, an unreadable item run or record fails the run.
 */
export async function resolveResultInputs(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  unsupplied: ReadonlyMap<string, string>
): Promise<RunPhase<WorkflowRun>> {
  if (unsupplied.size === 0) return { stopped: false, value: workflowRun };
  try {
    // A run with no item was refused before its claim.
    const item = workflowRun.item_id ? await deps.store.getItem(workflowRun.item_id) : null;
    if (item === null) throw new Error(`Item '${String(workflowRun.item_id)}' was not found`);
    const results = await latestResultsOnItem(deps.store, item, [...new Set(unsupplied.values())]);
    const resolved: Record<string, JsonValue> = {};
    const lines: string[] = [];
    const read: Record<string, string | null> = {};
    for (const [input, workflowName] of unsupplied) {
      const latest = results.get(workflowName);
      if (latest === undefined) throw new Error(`No result read for '${workflowName}'`);
      const { runId, result } = latest;
      resolved[input] = result.kind === 'result' ? result.value : null;
      read[input] = runId;
      lines.push(
        result.kind === 'result'
          ? `• \`${input}\`: result of \`${workflowName}\` run \`${String(runId)}\``
          : runId === null
            ? `• \`${input}\`: null, no completed run of \`${workflowName}\` on the item`
            : `• \`${input}\`: null, the latest completed run of \`${workflowName}\`, \`${runId}\`, has no result: ${result.reason}`
      );
    }
    const metadata = runInputsMetadata(
      { ...readSubrunMetadata(workflowRun.metadata).inputs, ...resolved },
      Object.hasOwn(workflowRun.metadata, SUBRUN_METADATA_KEYS.inputsValues)
    );
    await deps.store.updateWorkflowRun(workflowRun.id, { metadata });
    getLog().info({ workflowRunId: workflowRun.id, read }, 'workflow.result_inputs_resolved');
    await safeSendMessage(
      platform,
      conversationId,
      `Earlier results read from the item:\n${lines.join('\n')}`
    );
    return {
      stopped: false,
      value: { ...workflowRun, metadata: { ...workflowRun.metadata, ...metadata } },
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: workflowRun.id }, 'workflow.result_inputs_failed');
    const reason = `Unable to read the earlier results its result_of inputs name: ${err.message}`;
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow failed**: ${reason}`);
    await requireTerminalStatusWrite(deps.store.failWorkflowRun(workflowRun.id, reason), {
      workflowRunId: workflowRun.id,
      site: 'workflow.result_inputs_failure_record_failed',
    });
    return {
      stopped: true,
      result: { success: false, workflowRunId: workflowRun.id, error: reason },
    };
  }
}
