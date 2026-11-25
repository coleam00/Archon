/**
 * Whether a waiting start a run's end or settled asks caused still follows its trigger file.
 * The receipt records the revision of the file's start config it was written from
 * (`startConfigRevision`); freshness is that one comparison against the file as the
 * trigger directory of the host that drains the start holds it now. A stale start is
 * rebuilt from the file by the matcher's own pieces (`bindsRunEnd`, `bindsSettlement`,
 * `mappedInputs`, `startIntent`, `settledSources`), or refused when it cannot be. Which
 * items start, and over which link, stays as the completing write matched it.
 */
import { createLogger } from '@archon/paths';
import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import { readCompletedRunResult } from '@archon/workflows/run-result';
import { isAttentionDegraded } from '@archon/workflows/schemas/attention-degraded';
import { readsItemAnswers } from '@archon/workflows/schemas/binding-input-source';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import type { StartRefusalReason } from '@archon/workflows/schemas/run-metadata';
import { readSubrunMetadata } from '@archon/workflows/schemas/run-metadata';
import { registeredProjectKeyForPath } from '../services/codebase-checkout-resolver';
import { bindsSettlement, settledSources } from './asks-settled';
import type { WorkflowHost } from './host-store';
import { itemAnswers } from './item-answers';
import {
  bindsRunEnd,
  findStartTriggerFile,
  getTriggersPath,
  isRevisionOf,
  launchProjectKey,
  linkedEntries,
  mappedInputs,
  readTriggerEntries,
  startIntent,
  type MappedSources,
  type OnBinding,
  type TriggerEntry,
} from './run-ended';

const log = createLogger('resource-start-host');

/** The install's trigger directory, read at most once however often it is asked for. */
export function triggerEntriesReader(): () => Promise<readonly TriggerEntry[]> {
  let entries: Promise<readonly TriggerEntry[]> | undefined;
  return () => (entries ??= readTriggerEntries(getTriggersPath()));
}

export type WaitingStartFreshness =
  /** Run it as it is: its file is unchanged, or it is not a start that follows a file. */
  | { fresh: true }
  /** Pending: its own trigger file does not read; it waits for the operator to fix it. */
  | { wait: Error }
  /** Queued, and its file changed, is gone or does not read: back to preparation. */
  | { stale: true }
  /** Pending: the intent its file builds now. */
  | { intent: ResourceStartBindingIntent }
  /** Pending: its file can no longer start it. */
  | { refused: { reason: StartRefusalReason; detail: string } };

type CausingActor = NonNullable<SourceReceiptInput['sourceActor']>;

/**
 * The freshness of one waiting start: its recorded revision against its trigger file as
 * registered now on its host (`isRevisionOf`). `entries` reads the drainer's trigger
 * directory, once per pass and only for a start a run's end or settled asks caused. A
 * start recorded with no revision is rebuilt once, and kept as frozen when its file cannot
 * rebuild it, so it is never lost for that reason alone.
 */
export async function waitingStartFreshness(
  host: WorkflowHost,
  entries: () => Promise<readonly TriggerEntry[]>,
  start: {
    receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId' | 'itemKey'>;
    binding: { bindingRevision: string | null; intent: ResourceStartBindingIntent };
    phase: 'pending' | 'queued';
  }
): Promise<WaitingStartFreshness> {
  const { receipt, binding, phase } = start;
  const actor = receipt.sourceActor;
  if (actor?.source !== RUN_ENDED_SOURCE_ACTOR && actor?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return { fresh: true };
  const lookup = findStartTriggerFile(await entries(), {
    sourceInstanceId: receipt.sourceInstanceId,
    hostId: binding.intent.hostId,
  });
  if ('found' in lookup && isRevisionOf(lookup.found, binding.bindingRevision))
    return { fresh: true };
  // A queued start is checked again when it is prepared, with the rest of this rule.
  if (phase === 'queued') return { stale: true };
  if ('unread' in lookup) return { wait: lookup.unread };
  const rebuilt =
    'found' in lookup
      ? await rebuild(host, lookup.found, actor, receipt.itemKey, binding.intent)
      : refuse(lookup.gone);
  if ('refused' in rebuilt && binding.bindingRevision === null) {
    log.info(
      { sourceInstanceId: receipt.sourceInstanceId, detail: rebuilt.refused.detail },
      'resource_start.unrevised_start_kept'
    );
    return { fresh: true };
  }
  return rebuilt;
}

function refuse(
  detail: string,
  reason: StartRefusalReason = 'launch_preparation_failed'
): { refused: { reason: StartRefusalReason; detail: string } } {
  return { refused: { reason, detail } };
}

/** The start as `file` builds it now from what its cause recorded, or why it cannot. */
async function rebuild(
  host: WorkflowHost,
  file: OnBinding,
  actor: CausingActor,
  itemKey: string | null,
  stored: ResourceStartBindingIntent
): Promise<{ intent: ResourceStartBindingIntent } | ReturnType<typeof refuse>> {
  if ('runEnded' in file !== (actor.source === RUN_ENDED_SOURCE_ACTOR))
    return refuse(`${file.file}: it no longer binds the event that caused this start`);
  // The binding row is keyed by its id.
  if (file.binding.bindingId !== stored.bindingId)
    return refuse(`${file.file}: its binding is now '${file.binding.bindingId}'`);
  const sources =
    'runEnded' in file
      ? await runEndedSources(host, file, actor, itemKey)
      : await asksSettledSources(host, file, actor.id, itemKey, stored);
  if ('refused' in sources) return sources;
  const mapped = mappedInputs(
    'runEnded' in file ? file.runEnded.inputs : file.asksSettled.inputs,
    sources
  );
  if ('missing' in mapped) return refuse(`${file.file}: ${mapped.missing}`, 'inputs_unmapped');
  // The checkout hand-off stays as the run's end recorded it.
  const intent = startIntent(file, mapped.inputs, stored.checkoutFrom);
  return { intent: stored.itemKey === undefined ? intent : { ...intent, itemKey: stored.itemKey } };
}

/**
 * What a run-ended binding maps from, read again from the ended run's record. The run is
 * needed: the file must still bind its workflow and outcome (`bindsRunEnd`).
 */
async function runEndedSources(
  host: WorkflowHost,
  file: Extract<OnBinding, { runEnded: unknown }>,
  actor: CausingActor,
  startedItemKey: string | null
): Promise<MappedSources | ReturnType<typeof refuse>> {
  const { store } = host.deps;
  const run = await store.getWorkflowRun(actor.id);
  const item = run?.item_id ? await store.getItem(run.item_id) : null;
  if (!run || !item) return refuse(`run '${actor.id}', which caused this start, is gone`);
  const end = { workflowName: run.workflow_name, outcome: actor.display ?? '' };
  if (!bindsRunEnd(file.runEnded, end))
    return refuse(
      `${file.file}: it no longer binds '${end.workflowName}' completing with '${end.outcome}'`
    );
  const { inputs: sources, linked } = file.runEnded;
  const readsResult =
    linked?.items !== undefined || Object.values(sources ?? {}).some(source => 'result' in source);
  const recorded = readsResult
    ? readCompletedRunResult(run, await store.listWorkflowEvents(run.id))
    : undefined;
  const result = recorded?.kind === 'result' ? recorded.value : undefined;
  const entries = linked?.items === undefined ? undefined : linkedEntries(result, linked.items);
  const entry =
    entries === undefined || typeof entries === 'string'
      ? undefined
      : entries.find(named => named.key === startedItemKey)?.entry;
  return {
    inputs: readSubrunMetadata(run.metadata).inputs ?? {},
    result,
    itemKey: item.key,
    ...(entry === undefined ? {} : { entry }),
    ...(Object.values(sources ?? {}).some(readsItemAnswers)
      ? { itemAnswers: itemAnswers(await store.listItemAsks(item.id)) }
      : {}),
  };
}

/**
 * What an asks-settled binding maps from. The settled set is the asks the run left, on the
 * start's item: they outlive the run, so a mapping that reads only answers still rebuilds.
 */
async function asksSettledSources(
  host: WorkflowHost,
  file: Extract<OnBinding, { asksSettled: unknown }>,
  runId: string,
  itemKey: string | null,
  stored: ResourceStartBindingIntent
): Promise<MappedSources | ReturnType<typeof refuse>> {
  const { store } = host.deps;
  const projectKey = await launchProjectKey(cwd =>
    registeredProjectKeyForPath(cwd, host.records.codebases)
  )(stored.launch.cwd);
  const found =
    projectKey === null || itemKey === null ? null : await store.getItemRuns(projectKey, itemKey);
  const itemAsks = found ? await store.listItemAsks(found.item.id) : [];
  const rows: StoredItemAsk[] = [];
  for (const row of itemAsks) {
    if (row.runId !== runId) continue;
    // Thrown: the set cannot be read by this binary, so the start waits for one that can.
    if (isAttentionDegraded(row)) throw new Error(`An ask run '${runId}' left cannot be read`);
    rows.push(row);
  }
  if (rows.length === 0) return refuse(`the asks run '${runId}' left are gone`);
  if (!bindsSettlement(file.asksSettled, rows))
    return refuse(`${file.file}: it no longer starts on the asks run '${runId}' left`);
  const run = await store.getWorkflowRun(runId);
  return settledSources(runId, rows, run, itemAsks);
}
