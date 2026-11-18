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
import { existsSync } from 'node:fs';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  readAsksCheckout,
  type SourceReceiptAcceptance,
} from '@archon/workflows/schemas/resource-start';
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
  store: AnswerStore
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
  const recovery = notStarted.length > 0 ? await checkoutRecovery(receipts, store, itemKey) : '';
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
        `\n\u26a0\ufe0f The next stage was not started: ${reason}. Receipt ${receiptId} records it (archon trigger inspect ${receiptId}). Fix what it names, then start the stage by hand with the inputs the binding should have passed: the answers as archon workflow runs --item ${itemKey} --json lists them, and the asking run's inputs and result. For a binding without checkout, put them in a file and run archon trigger fire --config <trigger file> --item ${itemKey} --inputs <file>. For one that takes the asking run's checkout (on.asksSettled.checkout), which a fire refuses: ${recovery}`
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

type AnswerStore = Pick<IWorkflowStore, 'getStartReceipt' | 'getWorkflowRun'>;

/**
 * How to start a stage that takes the asking run's checkout by hand, from what that run
 * recorded: adopt the run whose worktree holds the checkout (the asking run, or for a
 * read-only asking stage the run whose checkout it was given, never its deleted copy), or
 * run the asking workflow again when no checkout is left to hand over.
 */
async function checkoutRecovery(
  receipts: readonly SourceReceiptAcceptance[],
  store: AnswerStore,
  itemKey: string
): Promise<string> {
  const actor = receipts.find(
    accepted => accepted.receipt.sourceActor?.source === ASKS_SETTLED_SOURCE_ACTOR
  )?.receipt.sourceActor;
  const asking = actor ? await store.getWorkflowRun(actor.id) : null;
  const recorded = asking ? readAsksCheckout(asking) : undefined;
  if (recorded === undefined || !('handoff' in recorded) || !existsSync(recorded.worktree))
    return `the checkout it left is gone or was never recorded, so run ${asking ? `'${asking.workflow_name}'` : 'the asking workflow'} again on the item.`;
  const holder = recorded.handoff.runId;
  return `run archon workflow run <stage> --adopt ${holder} --item ${itemKey} with an --input <name>=<value> for each input the binding maps, since --adopt carries the checkout and not the answers. Run ${holder} holds the checkout${holder === asking?.id ? '' : `, which the read-only asking run ${asking?.id ?? ''} was given`}; adoption continues its branch as it is now.`;
}

type StartState =
  | { kind: 'prepared' }
  | { kind: 'waiting'; receiptId: string; bindingId: string; hostId: string | null }
  | { kind: 'not_started'; receiptId: string; bindingId: string | null; reason: string };

/** Where each binding of one receipt stands, read back from the store. */
async function startStates(
  accepted: SourceReceiptAcceptance,
  store: AnswerStore
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

/**
 * The starts a close's settlement caused, as they stand once this process tried them. The
 * close has committed by now, so a failure to read them back is reported beside the
 * recorded answer, naming the receipts, and never turns the command into a failure.
 */
export async function startsOf(
  caused: readonly SourceReceiptAcceptance[],
  store: AnswerStore
): Promise<SettledStarts> {
  if (caused.length === 0) return NO_STARTS;
  try {
    return await settledStarts(caused, store);
  } catch (error) {
    const receiptIds = caused.map(accepted => accepted.receipt.id);
    const message = (error as Error).message;
    return {
      text: `\n\u26a0\ufe0f The settlement recorded ${String(receiptIds.length)} bound stage start(s), but where they stand could not be read: ${message}. archon trigger inspect <receipt> shows each: ${receiptIds.join(', ')}.`,
      json: { startsUnread: { receiptIds, error: message } },
    };
  }
}

function causedBy(
  result: AttentionItemAnswerResult | AttentionItemWithdrawResult
): readonly SourceReceiptAcceptance[] {
  return result.kind === 'ask_answered' || result.kind === 'withdrawn' ? result.startReceipts : [];
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
      outcome = withdrawn(
        request.withdraw,
        result,
        await startsOf(causedBy(result), host.deps.store)
      );
    } else {
      const answer: AttentionAnswerRequest = {
        ...request.selection,
        ...(request.text === undefined ? {} : { text: request.text }),
      };
      const result = await answerAttentionItem(deps, request.ref, answer, actor, 'cli');
      outcome = answered(request.ref, result, await startsOf(causedBy(result), host.deps.store));
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
