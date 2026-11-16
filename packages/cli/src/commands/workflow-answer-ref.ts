/**
 * `archon workflow answer --ref <ref>` and `--withdraw <ref>`: answer an attention item by
 * the ref the queue gives it, through the one answer operation every surface uses. An ask
 * a completed run left has no run to name, so its ref is the only way to it; for an item a
 * paused run holds the ref works too, and the run-addressed commands stay as they are.
 */
import {
  answerAttentionItem,
  withdrawAttentionItem,
  type AttentionItemAnswerResult,
  type AttentionItemWithdrawResult,
} from '@archon/core/operations/attention-items';
import { attentionQueueSource } from '@archon/core/operations/attention-queue';
import type { AttentionAnswerRequest } from '@archon/core/operations/workflow-operations';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type { IWorkflowStore } from '@archon/workflows/store';
import { cliActor } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';

export const WORKFLOW_ANSWER_REF_USAGE =
  'Usage: archon workflow answer --ref <ref> [--choose <id>... | --recommended] [--text <text>] [--as <name>] [--json]\n' +
  '       archon workflow answer --withdraw <ref> [--as <name>] [--json]';

export type WorkflowAnswerRefRequest =
  | {
      ref: string;
      selection: { choose: readonly string[] } | { recommended: true };
      text?: string;
      as?: string;
    }
  | { withdraw: string; as?: string };

type Outcome =
  | { ok: true; text: string; json: object }
  | { ok: false; error: string; code: string };

type SettledStarts = { text: string; json: object };
const NO_STARTS: SettledStarts = { text: '', json: {} };

/**
 * What a settling close says about the starts it caused, read back from each receipt after
 * this process tried to start them: a matched receipt is only a start that was written, so
 * each binding is reported by where its preparation stands. A binding that matched but
 * could not start is printed with its receipt and how to start the stage by hand.
 */
async function settledStarts(
  receipts: readonly SourceReceiptAcceptance[],
  store: Pick<IWorkflowStore, 'getStartReceipt'>
): Promise<SettledStarts> {
  const itemKey = receipts.find(accepted => accepted.receipt.itemKey)?.receipt.itemKey ?? '<key>';
  const states = (await Promise.all(receipts.map(accepted => startStates(accepted, store)))).flat();
  const prepared = states.filter(state => state.kind === 'prepared');
  const waiting = states.flatMap(state =>
    state.kind === 'waiting'
      ? [{ receiptId: state.receiptId, bindingId: state.bindingId, hostId: state.hostId }]
      : []
  );
  const notStarted = states.flatMap(state =>
    state.kind === 'not_started'
      ? [{ receiptId: state.receiptId, bindingId: state.bindingId, reason: state.reason }]
      : []
  );
  const lines = [
    ...(prepared.length > 0
      ? [
          ` It prepared ${String(prepared.length)} bound stage start(s) on the item; archon workflow runs --item ${itemKey} shows them.`,
        ]
      : []),
    ...waiting.map(
      ({ receiptId, hostId }) =>
        `\nA bound stage waits for the next drain of host '${hostId ?? '<host>'}' (archon trigger drain --host ${hostId ?? '<host>'}); receipt ${receiptId} records it.`
    ),
    ...notStarted.map(
      ({ receiptId, reason }) =>
        `\n\u26a0\ufe0f The next stage was not started: ${reason}. Receipt ${receiptId} records it (archon trigger inspect ${receiptId}). Fix the trigger, then start the stage with archon trigger fire --config <trigger file> --item ${itemKey} --inputs <file>, where the file holds the inputs the binding should have passed: the answers as archon workflow runs --item ${itemKey} --json lists them, and the asking run's inputs and result.`
    ),
  ];
  return {
    text: lines.join(''),
    json: {
      ...(waiting.length > 0 ? { waiting } : {}),
      ...(notStarted.length > 0 ? { notStarted } : {}),
    },
  };
}

type StartState =
  | { kind: 'prepared' }
  | { kind: 'waiting'; receiptId: string; bindingId: string; hostId: string | null }
  | { kind: 'not_started'; receiptId: string; bindingId: string | null; reason: string };

/** Where each binding of one receipt stands, read back from the store. */
async function startStates(
  accepted: SourceReceiptAcceptance,
  store: Pick<IWorkflowStore, 'getStartReceipt'>
): Promise<StartState[]> {
  const receiptId = accepted.receipt.id;
  if (accepted.outcome !== 'matched')
    return [
      {
        kind: 'not_started',
        receiptId,
        bindingId: null,
        reason: accepted.reason ?? 'its binding was rejected',
      },
    ];
  const inspected = await store.getStartReceipt(receiptId);
  return (inspected?.bindings ?? []).map((binding): StartState => {
    if (binding.status === 'complete') return { kind: 'prepared' };
    if (binding.status === 'pending' || binding.status === 'preparing')
      return { kind: 'waiting', receiptId, bindingId: binding.bindingId, hostId: binding.hostId };
    return {
      kind: 'not_started',
      receiptId,
      bindingId: binding.bindingId,
      reason: binding.error ?? `its preparation is ${binding.status}`,
    };
  });
}

function answered(ref: string, result: AttentionItemAnswerResult, starts: SettledStarts): Outcome {
  switch (result.kind) {
    case 'ask_answered': {
      return {
        ok: true,
        text: `Answered ${ref}.${result.settled ? ' That was the last open ask of its set; the set is settled.' : ''}${starts.text}`,
        json: { ok: true, ref, action: 'answer', settled: result.settled, ...starts.json },
      };
    }
    case 'answered':
      return {
        ok: true,
        text: `Answered ${ref} (run ${result.item.run.id}).${result.cancelled ? ' The gate has no rework path, so the run is cancelled.' : result.continues ? ' The run continues on its own while an Archon server is running.' : ` Continue it with archon workflow resume ${result.item.run.id}.`}`,
        json: {
          ok: true,
          ref,
          action: 'answer',
          runId: result.item.run.id,
          cancelled: result.cancelled,
          continues: result.continues,
        },
      };
    case 'unchanged':
      return {
        ok: true,
        text: `${ref} already has this answer; nothing changed.`,
        json: { ok: true, ref, action: 'answer', unchanged: true },
      };
    case 'unknown':
      return { ok: false, code: 'unknown', error: `Nothing you may answer has ref '${ref}'.` };
    case 'none':
      return { ok: false, code: 'closed', error: `Item '${ref}' is no longer open.` };
    case 'moved':
      return {
        ok: false,
        code: 'moved',
        error: `Item '${ref}' is over; its run now asks something else, as '${result.item.ref}'.`,
      };
    case 'takes_no_answer':
      return { ok: false, code: 'takes_no_answer', error: `Item '${ref}' takes no answer.` };
    case 'refused':
      return {
        ok: false,
        code: result.reason,
        error:
          result.reason === 'already_answered'
            ? `Item '${ref}' was already answered differently; that answer stands.`
            : result.reason === 'gate_has_no_recommendation'
              ? 'A gate has no recommendation. Choose one decision.'
              : 'A gate takes exactly one decision.',
      };
  }
}

function withdrawn(
  ref: string,
  result: AttentionItemWithdrawResult,
  starts: SettledStarts
): Outcome {
  switch (result.kind) {
    case 'withdrawn': {
      return {
        ok: true,
        text: `Withdrew ${ref}.${result.settled ? ' That was the last open ask of its set; the set is settled.' : ''}${starts.text}`,
        json: { ok: true, ref, action: 'withdraw', settled: result.settled, ...starts.json },
      };
    }
    case 'unchanged':
      return {
        ok: true,
        text: `${ref} was already withdrawn; nothing changed.`,
        json: { ok: true, ref, action: 'withdraw', unchanged: true },
      };
    case 'unknown':
      return { ok: false, code: 'unknown', error: `Nothing you may withdraw has ref '${ref}'.` };
    case 'not_an_ask':
      return {
        ok: false,
        code: 'not_an_ask',
        error: `Item '${ref}' is held by a paused run; answer it, or abandon the run.`,
      };
    case 'refused':
      return {
        ok: false,
        code: `already_${result.closedAs}`,
        error: `Item '${ref}' was already ${result.closedAs}; that stands.`,
      };
  }
}

/** The starts a close's settlement caused, as they stand once this process tried them. */
function startsOf(
  result: AttentionItemAnswerResult | AttentionItemWithdrawResult,
  host: WorkflowHost
): Promise<SettledStarts> | SettledStarts {
  return (result.kind === 'ask_answered' || result.kind === 'withdrawn') &&
    result.startReceipts.length > 0
    ? settledStarts(result.startReceipts, host.deps.store)
    : NO_STARTS;
}

export async function workflowAnswerRefCommand(
  host: WorkflowHost,
  request: WorkflowAnswerRefRequest,
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const deps = {
    queue: attentionQueueSource(host.deps.store, host.records.isolation),
    operations: host.operations,
  };
  const actor = cliActor(request.as, env);
  let outcome: Outcome;
  try {
    if ('withdraw' in request) {
      const result = await withdrawAttentionItem(deps, request.withdraw, actor, 'cli');
      outcome = withdrawn(request.withdraw, result, await startsOf(result, host));
    } else {
      const answer: AttentionAnswerRequest = {
        ...request.selection,
        ...(request.text === undefined ? {} : { text: request.text }),
      };
      const result = await answerAttentionItem(deps, request.ref, answer, actor, 'cli');
      outcome = answered(request.ref, result, await startsOf(result, host));
    }
  } catch (error) {
    outcome = { ok: false, code: 'error', error: (error as Error).message };
  }
  if (outcome.ok) {
    if (json) await writeJsonLine(outcome.json);
    else console.log(outcome.text);
    return 0;
  }
  if (json) await writeJsonLine({ ok: false, error: outcome.code, message: outcome.error });
  else console.error(`Error: ${outcome.error}`);
  return 1;
}
