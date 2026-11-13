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
  /** Set when the start adopts another run's estate. */
  adoptRunId: string | undefined;
  actor: RunActor;
}

/**
 * Why this start cannot run, or `undefined` when the dispatch should take it. The run route
 * asks before it writes or dispatches anything, so a refusal is the request's response and
 * never a later chat message.
 *
 * It answers only for a start the dispatch judges on the workflow this conversation
 * resolves: a fresh run that adopts nothing. That start gets the dispatch's own signature
 * gates. Two starts are judged on a definition only the dispatch can reach, so it answers
 * them on the conversation as before: one that adopts a run, whose branch can carry its own
 * workflow, and one that continues a paused run, which runs the definition frozen on that
 * run.
 *
 * A conversation with no project resolves workflows as the dispatch does for it, and has no
 * run to continue.
 */
export async function workflowStartRefusal(start: WorkflowStart): Promise<string | undefined> {
  const { conversation, workflowName, actor } = start;
  if (start.adoptRunId !== undefined) return undefined;
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
  if (conversation && codebase) {
    const { willContinueExistingRun } = await readContinuation(
      { conversation, codebase },
      request,
      request.definition
    );
    if (willContinueExistingRun) return undefined;
  }
  const verdict = await judgeSignatureGates(
    {
      conversationId: start.conversationId,
      userId: actor.kind === 'user' ? actor.userId : undefined,
      options: { inputs: start.inputs },
    },
    request.definition,
    false
  );
  return verdict.ok ? undefined : verdict.reason;
}
