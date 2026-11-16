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

function answered(ref: string, result: AttentionItemAnswerResult): Outcome {
  switch (result.kind) {
    case 'ask_answered':
      return {
        ok: true,
        text: `Answered ${ref}.${result.settled ? ' That was the last open ask of its set; the set is settled.' : ''}`,
        json: { ok: true, ref, action: 'answer', settled: result.settled },
      };
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

function withdrawn(ref: string, result: AttentionItemWithdrawResult): Outcome {
  switch (result.kind) {
    case 'withdrawn':
      return {
        ok: true,
        text: `Withdrew ${ref}.${result.settled ? ' That was the last open ask of its set; the set is settled.' : ''}`,
        json: { ok: true, ref, action: 'withdraw', settled: result.settled },
      };
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
      outcome = withdrawn(
        request.withdraw,
        await withdrawAttentionItem(deps, request.withdraw, actor, 'cli')
      );
    } else {
      const answer: AttentionAnswerRequest = {
        ...request.selection,
        ...(request.text === undefined ? {} : { text: request.text }),
      };
      outcome = answered(
        request.ref,
        await answerAttentionItem(deps, request.ref, answer, actor, 'cli')
      );
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
