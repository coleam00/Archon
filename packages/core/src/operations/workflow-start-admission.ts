import * as codebaseDb from '../db/codebases';
import { startWorkflow } from '../handlers/command-handler';
import { judgeSignatureGates } from '../orchestrator/dispatch/gates';
import { readContinuation } from '../orchestrator/dispatch/request';
import type { Conversation } from '../types';
import type { RunActor } from './run-authorization';

/** One start by workflow name, as the run route receives it. */
export interface WorkflowStart {
  /** The web conversation id, for the gates' log lines. */
  conversationId: string;
  /** The conversation's row; `null` when the dispatch will create it. */
  conversation: Conversation | null;
  workflowName: string;
  inputs: Readonly<Record<string, string>> | undefined;
  actor: RunActor;
}

/**
 * Why this start cannot run, or `undefined` when it can. The run route asks before it writes
 * or dispatches anything, so a refusal is the request's response and never a later chat
 * message.
 *
 * The answer is the dispatch's own: the workflow resolves the way a start by name resolves
 * it, and the signature gates judge it with the continuation the dispatch would detect. An
 * input error is therefore deferred here exactly when the dispatch defers it. The dispatch
 * still runs the gates, because an adopted branch can replace the definition after this.
 *
 * A conversation with no project resolves workflows as the dispatch does for it, and has no
 * run to continue.
 */
export async function workflowStartRefusal(start: WorkflowStart): Promise<string | undefined> {
  const { conversation, workflowName, actor } = start;
  const command = await startWorkflow(
    conversation ?? { codebase_id: null, cwd: null },
    workflowName,
    '',
    false,
    {}
  );
  const request = command.workflow;
  if (request?.kind !== 'start') return command.message;

  const codebase = conversation?.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  const continuation =
    conversation && codebase
      ? await readContinuation({ conversation, codebase }, request, request.definition)
      : undefined;
  const verdict = await judgeSignatureGates(
    {
      conversationId: start.conversationId,
      userId: actor.kind === 'user' ? actor.userId : undefined,
      inputs: start.inputs,
    },
    request.definition,
    continuation?.willContinueExistingRun ?? false
  );
  return verdict.ok ? undefined : verdict.reason;
}
