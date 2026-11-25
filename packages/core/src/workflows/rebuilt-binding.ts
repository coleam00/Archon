/**
 * A waiting start a run's end or settled asks caused, rebuilt from its trigger file as the
 * file is now. The write that ends the run (or settles the asks) decides which items start
 * and over which link; that is not decided again here. What it froze on the receipt is the
 * binding and its mapped inputs, and those follow the file: when the file's start config
 * changed before the start was admitted, the binding is built again by the same code
 * (`mappedInputs`, `startIntent`) from what the run recorded. A file that is gone, or
 * that no longer binds that end, refuses the start.
 *
 * Read at preparation (`preparePendingBinding`) and, for a start already queued, at each
 * host drain, which sends a queued start whose file now starts something else back to
 * preparation.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '@archon/workflows/output-ref';
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
import {
  readAsksResult,
  readSubrunMetadata,
  type StartRefusalReason,
} from '@archon/workflows/schemas/run-metadata';
import { registeredProjectKeyForPath } from '../services/codebase-checkout-resolver';
import { settlementStarts } from './asks-settled';
import type { WorkflowHost } from './host-store';
import { itemAnswers, settledAnswer } from './item-answers';
import {
  getTriggersPath,
  launchProjectKey,
  linkedEntries,
  mappedInputs,
  onBindingRevision,
  readOnBindings,
  startIntent,
  type AsksSettledBinding,
  type MappedSources,
  type OnBinding,
  type RunEndedBinding,
} from './run-ended';

export type CurrentBinding =
  | { unchanged: true }
  | { intent: ResourceStartBindingIntent }
  | { refused: { reason: StartRefusalReason; detail: string } };

/**
 * Every trigger file with `on`, read once however often it is called; throws, naming the
 * file, when one does not read.
 */
export function triggerFilesReader(): () => Promise<OnBinding[]> {
  let files: Promise<OnBinding[]> | undefined;
  return () => (files ??= readOnBindings(getTriggersPath()));
}

type CausingActor = NonNullable<SourceReceiptInput['sourceActor']>;

/**
 * The binding a waiting start runs with: its own intent while its trigger file is
 * unchanged, the one its file builds now, or why the file no longer starts it. Only a start
 * a run's end or settled asks caused follows its file; any other is unchanged. The file is
 * unchanged when its revision is the receipt's, or, failing that, when it builds the same
 * intent from what the run recorded: a receipt an older Archon wrote hashed its binding
 * alone, and a cosmetic edit moves the revision without changing the start. The one
 * freshness rule for a pending start's preparation and for a queued start's admission.
 * Throws when the trigger files or what the start was caused by cannot be read.
 */
export async function currentBinding(
  host: WorkflowHost,
  receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId' | 'itemKey'>,
  binding: { bindingRevision: string | null; intent: ResourceStartBindingIntent },
  files: () => Promise<readonly OnBinding[]> = triggerFilesReader()
): Promise<CurrentBinding> {
  const actor = receipt.sourceActor;
  // Checked before the files are read, so a broken file holds back only these starts.
  if (actor?.source !== RUN_ENDED_SOURCE_ACTOR && actor?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return { unchanged: true };
  const file = (await files()).find(
    candidate => candidate.sourceInstanceId === receipt.sourceInstanceId
  );
  if (file && onBindingRevision(file) === binding.bindingRevision) return { unchanged: true };
  if (!file) return refuse(`trigger file for '${receipt.sourceInstanceId}' is gone`);
  // A file now about the other event cannot be read against this one's cause.
  if ('runEnded' in file !== (actor.source === RUN_ENDED_SOURCE_ACTOR))
    return refuse(`${file.file}: it no longer binds the event that caused this start`);
  if (file.binding.bindingId !== binding.intent.bindingId)
    return refuse(`${file.file}: its binding is now '${file.binding.bindingId}'`);
  const projectKey = await launchProjectKey(cwd =>
    registeredProjectKeyForPath(cwd, host.records.codebases)
  )(file.binding.launch.cwd);
  const read =
    'runEnded' in file
      ? await runEndedSources(host, file, actor, receipt.itemKey, projectKey)
      : await asksSettledSources(host, file, actor, receipt.itemKey, projectKey);
  if ('refused' in read) return read;
  const takesCheckout =
    ('runEnded' in file ? file.runEnded.checkout : file.asksSettled.checkout) !== undefined;
  const { checkoutFrom } = binding.intent;
  if (takesCheckout !== (checkoutFrom !== undefined))
    return refuse(
      `${file.file}: checkout is ${takesCheckout ? 'now taken' : 'no longer taken'}, and the hand-off was recorded when the run ended`,
      'checkout_refused'
    );
  const sources = 'runEnded' in file ? file.runEnded.inputs : file.asksSettled.inputs;
  const mapped = mappedInputs(sources, read.sources);
  if ('missing' in mapped) return refuse(`${file.file}: ${mapped.missing}`, 'inputs_unmapped');
  // The hand-off is kept as the run's end recorded it.
  const built = startIntent(file, mapped.inputs, checkoutFrom);
  const intent =
    binding.intent.itemKey === undefined ? built : { ...built, itemKey: binding.intent.itemKey };
  return sameStart(intent, binding.intent) ? { unchanged: true } : { intent };
}

/** Whether two intents start the same thing, whatever revision each records. */
function sameStart(a: ResourceStartBindingIntent, b: ResourceStartBindingIntent): boolean {
  const plain = ({ bindingRevision: _revision, ...intent }: ResourceStartBindingIntent) =>
    JSON.parse(JSON.stringify(intent)) as unknown;
  return isDeepStrictEqual(plain(a), plain(b));
}

function refuse(
  detail: string,
  reason: StartRefusalReason = 'launch_preparation_failed'
): { refused: { reason: StartRefusalReason; detail: string } } {
  return { refused: { reason, detail } };
}

type Sources = { sources: MappedSources } | ReturnType<typeof refuse>;

/**
 * What a run-ended binding maps from, read again from the ended run's record. The run is
 * needed: its inputs, result, outcome and item are what the start was matched on.
 */
async function runEndedSources(
  host: WorkflowHost,
  file: RunEndedBinding,
  actor: CausingActor,
  receiptItemKey: string | null,
  projectKey: string | null
): Promise<Sources> {
  const { runEnded } = file;
  const run = await host.deps.store.getWorkflowRun(actor.id);
  const item = run?.item_id ? await host.deps.store.getItem(run.item_id) : null;
  if (!run || !item)
    return refuse(`${file.file}: run '${actor.id}', which caused this start, or its item is gone`);
  if (projectKey !== item.projectKey)
    return refuse(`${file.file}: binding.launch.cwd is no longer in the item's project`);
  const outcome = actor.display ?? '';
  if (runEnded.workflowName !== run.workflow_name || runEnded.outcome !== outcome)
    return refuse(
      `${file.file}: it no longer binds '${run.workflow_name}' completing with '${outcome}'`
    );
  // A start on another item was matched over a link; one on the run's own item was not.
  const itemKey = receiptItemKey ?? item.key;
  const onLink = itemKey !== item.key;
  if ((runEnded.linked !== undefined) !== onLink)
    return refuse(
      `${file.file}: it ${onLink ? 'no longer starts' : 'now starts'} linked items`,
      'link_refused'
    );
  // The run's events are read only when the file reads its result.
  const readsResult =
    runEnded.linked?.items !== undefined ||
    Object.values(runEnded.inputs ?? {}).some(source => 'result' in source);
  const recorded = readsResult
    ? readCompletedRunResult(run, await host.deps.store.listWorkflowEvents(run.id))
    : undefined;
  const result = recorded?.kind === 'result' ? recorded.value : undefined;
  let entry: JsonValue | undefined;
  if (runEnded.linked?.items !== undefined) {
    const entries = linkedEntries(result, runEnded.linked.items);
    entry = typeof entries === 'string' ? undefined : entries.find(e => e.key === itemKey)?.entry;
    if (entry === undefined)
      return refuse(
        `${file.file}: linked.items '${runEnded.linked.items}' does not name item '${itemKey}'`,
        'link_refused'
      );
  }
  return {
    sources: {
      inputs: readSubrunMetadata(run.metadata).inputs ?? {},
      result,
      itemKey: item.key,
      ...(entry === undefined ? {} : { entry }),
      ...(Object.values(runEnded.inputs ?? {}).some(readsItemAnswers)
        ? { itemAnswers: itemAnswers(await host.deps.store.listItemAsks(item.id)) }
        : {}),
    },
  };
}

/**
 * What an asks-settled binding maps from: the settled set and the item's asks, which
 * outlive the asking run, and the asking run's inputs and result while it exists. With the
 * run deleted, a mapping that reads it refuses (`mappedInputs`), as at the settlement.
 */
async function asksSettledSources(
  host: WorkflowHost,
  file: AsksSettledBinding,
  actor: CausingActor,
  receiptItemKey: string | null,
  projectKey: string | null
): Promise<Sources> {
  const { asksSettled } = file;
  // The receipt names the asking item: an asks-settled start is never on a linked one.
  const found =
    projectKey === null || receiptItemKey === null
      ? null
      : await host.deps.store.getItemRuns(projectKey, receiptItemKey);
  if (!found) return refuse(`${file.file}: binding.launch.cwd is no longer in the item's project`);
  const onItem = await host.deps.store.listItemAsks(found.item.id);
  const rows: StoredItemAsk[] = [];
  for (const row of onItem) {
    if (row.runId !== actor.id) continue;
    // Thrown: the set cannot be read again by this binary, so the start waits for one that can.
    if (isAttentionDegraded(row)) throw new Error(`An ask run '${actor.id}' left cannot be read`);
    if (row.closed !== null && row.closed.as !== 'replaced') rows.push(row);
  }
  const workflow = rows[0]?.workflowName;
  if (workflow !== asksSettled.workflowName)
    return refuse(`${file.file}: it no longer binds the asks run '${actor.id}' left`);
  const settledAs = actor.display === 'withdrawn' ? 'withdrawn' : 'answered';
  if (!settlementStarts(asksSettled, rows, settledAs))
    return refuse(`${file.file}: it no longer starts when the asks settle as they did`);
  const answers = rows.map(settledAnswer);
  const run = await host.deps.store.getWorkflowRun(actor.id);
  return {
    sources: run
      ? {
          inputs: readSubrunMetadata(run.metadata).inputs ?? {},
          result: readAsksResult(run.metadata),
          answers,
          itemAnswers: itemAnswers(onItem),
        }
      : {
          gone: `run '${actor.id}', which left the asks, no longer exists`,
          answers,
          itemAnswers: itemAnswers(onItem),
        },
  };
}
