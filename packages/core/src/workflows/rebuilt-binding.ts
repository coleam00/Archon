/**
 * A waiting start a run's end or settled asks caused, rebuilt from its trigger file as the
 * file is now. The write that ends the run (or settles the asks) decides which items start
 * and over which link; that is not decided again here. What it froze on the receipt is the
 * binding and its mapped inputs, and those follow the file: when the file's start config
 * changed before the start was admitted, the binding is built again by the same code
 * (`bindingReceipt`, `mappedInputs`) from what the run recorded. A file that is gone, or
 * that no longer binds that end, refuses the start.
 *
 * Read at preparation (`preparePendingBinding`) and, for a start already queued, at each
 * host drain, which sends a queued start whose file changed back to preparation.
 */
import type { JsonValue } from '@archon/workflows/output-ref';
import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import { readCompletedRunResult } from '@archon/workflows/run-result';
import { isAttentionDegraded } from '@archon/workflows/schemas/attention-degraded';
import { readsItemAnswers } from '@archon/workflows/schemas/binding-input-source';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  type EndedCheckout,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import {
  readAsksResult,
  readSubrunMetadata,
  type StartRefusalReason,
} from '@archon/workflows/schemas/run-metadata';
import type { WorkflowItem, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { registeredProjectKeyForPath } from '../services/codebase-checkout-resolver';
import { settlementStarts } from './asks-settled';
import type { WorkflowHost } from './host-store';
import { itemAnswers, settledAnswer } from './item-answers';
import {
  bindingReceipt,
  getTriggersPath,
  launchProjectKey,
  linkedEntries,
  mappedInputs,
  onBindingRevision,
  readOnBindings,
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
 * Whether a start of this receipt's binding waits on a file that changed since the receipt
 * froze it: the file as it is now (undefined when it is gone) and the run that caused the
 * start. Undefined when the file is unchanged, or the start was not caused by a run's end
 * or settled asks: other sources' files are not rebuilt from.
 */
export async function changedTriggerFile(
  receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId'>,
  bindingRevision: string | null,
  files: () => Promise<readonly OnBinding[]>
): Promise<{ file: OnBinding | undefined; actor: CausingActor } | undefined> {
  const actor = receipt.sourceActor;
  // Checked before the files are read, so a broken file holds back only these starts.
  if (actor?.source !== RUN_ENDED_SOURCE_ACTOR && actor?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return undefined;
  const file = (await files()).find(
    candidate => candidate.sourceInstanceId === receipt.sourceInstanceId
  );
  if (file && onBindingRevision(file) === bindingRevision) return undefined;
  return { file, actor };
}

/**
 * The binding a pending start prepares with: its own intent when its file is unchanged, the
 * one its file builds now, or why the file no longer starts it. Throws when the trigger
 * files or the causing run cannot be read; the start then stays pending.
 */
export async function currentBinding(
  host: WorkflowHost,
  receipt: StartReceiptInspection,
  binding: { bindingRevision: string | null; intent: ResourceStartBindingIntent },
  files: () => Promise<readonly OnBinding[]> = triggerFilesReader()
): Promise<CurrentBinding> {
  const changed = await changedTriggerFile(receipt, binding.bindingRevision, files);
  if (!changed) return { unchanged: true };
  const { file, actor } = changed;
  if (!file) return refuse(`trigger file for '${receipt.sourceInstanceId}' is gone`);
  const runId = actor.id;
  const run = await host.deps.store.getWorkflowRun(runId);
  const item = run?.item_id ? await host.deps.store.getItem(run.item_id) : null;
  if (!run || !item)
    return refuse(`${file.file}: run '${runId}', which caused this start, or its item is gone`);
  if (file.binding.bindingId !== binding.intent.bindingId)
    return refuse(`${file.file}: its binding is now '${file.binding.bindingId}'`);
  const projectKey = await launchProjectKey(cwd =>
    registeredProjectKeyForPath(cwd, host.records.codebases)
  )(file.binding.launch.cwd);
  if (projectKey !== item.projectKey)
    return refuse(`${file.file}: binding.launch.cwd is no longer in the item's project`);
  // A start on another item was matched over a link; one on the run's own item was not.
  const itemKey = receipt.itemKey ?? item.key;
  const onLink = itemKey !== item.key;
  const read =
    'runEnded' in file
      ? await runEndedSources(host, file, { run, item, actor, onLink, itemKey })
      : await asksSettledSources(host, file, { run, item, actor, onLink });
  if ('refused' in read) return read;
  const takesCheckout =
    ('runEnded' in file ? file.runEnded.checkout : file.asksSettled.checkout) !== undefined;
  const { checkoutFrom } = binding.intent;
  if (takesCheckout !== (checkoutFrom !== undefined))
    return refuse(
      `${file.file}: checkout is ${takesCheckout ? 'now taken' : 'no longer taken'}, and the hand-off was recorded when the run ended`,
      'checkout_refused'
    );
  // The hand-off is kept as the run's end recorded it.
  const checkout: EndedCheckout | undefined = checkoutFrom ? { handoff: checkoutFrom } : undefined;
  const sources = 'runEnded' in file ? file.runEnded.inputs : file.asksSettled.inputs;
  // Only the binding is kept: the receipt it would make is the one already recorded.
  const built = bindingReceipt(
    file,
    { deliveryId: runId, sourceActor: actor, itemKey },
    mappedInputs(sources, read.sources),
    checkout,
    new Date()
  );
  const rebuilt = built.bindings[0];
  if (!rebuilt) {
    const evaluated = built.evaluatedBindings?.[0];
    return refuse(
      `${file.file}: ${evaluated?.reason ?? 'it starts nothing'}`,
      evaluated?.refused?.reason ?? 'inputs_unmapped'
    );
  }
  return {
    intent: {
      ...rebuilt,
      ...(binding.intent.itemKey === undefined ? {} : { itemKey: binding.intent.itemKey }),
    },
  };
}

function refuse(
  detail: string,
  reason: StartRefusalReason = 'launch_preparation_failed'
): { refused: { reason: StartRefusalReason; detail: string } } {
  return { refused: { reason, detail } };
}

type Sources = { sources: MappedSources } | ReturnType<typeof refuse>;

interface Cause {
  run: WorkflowRun;
  item: WorkflowItem;
  actor: CausingActor;
  /** Whether the start is on an item linked to the run's, not on the run's own. */
  onLink: boolean;
}

/** What a run-ended binding maps from, read again from the ended run's record. */
async function runEndedSources(
  host: WorkflowHost,
  file: RunEndedBinding,
  { run, item, actor, onLink, itemKey }: Cause & { itemKey: string }
): Promise<Sources> {
  const { runEnded } = file;
  const outcome = actor.display ?? '';
  if (runEnded.workflowName !== run.workflow_name || runEnded.outcome !== outcome)
    return refuse(
      `${file.file}: it no longer binds '${run.workflow_name}' completing with '${outcome}'`
    );
  if ((runEnded.linked !== undefined) !== onLink)
    return refuse(
      `${file.file}: it ${onLink ? 'no longer starts' : 'now starts'} linked items`,
      'link_refused'
    );
  const read = readCompletedRunResult(run, await host.deps.store.listWorkflowEvents(run.id));
  const result = read.kind === 'result' ? read.value : undefined;
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

/** What an asks-settled binding maps from, read again from the asking run and its asks. */
async function asksSettledSources(
  host: WorkflowHost,
  file: AsksSettledBinding,
  { run, item, actor, onLink }: Cause
): Promise<Sources> {
  const { asksSettled } = file;
  if (onLink || asksSettled.workflowName !== run.workflow_name)
    return refuse(`${file.file}: it no longer binds the asks of '${run.workflow_name}'`);
  const onItem = await host.deps.store.listItemAsks(item.id);
  const rows: StoredItemAsk[] = [];
  for (const row of onItem) {
    if (row.runId !== run.id) continue;
    // Thrown: the set cannot be read again by this binary, so the start waits for one that can.
    if (isAttentionDegraded(row)) throw new Error(`An ask run '${run.id}' left cannot be read`);
    if (row.closed !== null && row.closed.as !== 'replaced') rows.push(row);
  }
  const settledAs = actor.display === 'withdrawn' ? 'withdrawn' : 'answered';
  if (!settlementStarts(asksSettled, rows, settledAs))
    return refuse(`${file.file}: it no longer starts when the asks settle as they did`);
  return {
    sources: {
      inputs: readSubrunMetadata(run.metadata).inputs ?? {},
      result: readAsksResult(run.metadata),
      answers: rows.map(settledAnswer),
      itemAnswers: itemAnswers(onItem),
    },
  };
}
