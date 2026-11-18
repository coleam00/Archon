import type { WorkflowCheckout } from '@archon/workflows/schemas/workflow-checkout';
import * as codebaseDb from '../db/codebases';
import { startWorkflow } from '../handlers/command-handler';
import { judgeSignatureGates } from '../orchestrator/dispatch/gates';
import { dispatchAnswersContinuation, readContinuation } from '../orchestrator/dispatch/request';
import type { Codebase, Conversation } from '../types';
import { resolveWorkflowSourceRoot } from '../utils/workflow-source-root';
import type { RunActor } from './run-authorization';

/** One start by workflow name, as the run route receives it. */
export interface WorkflowStart {
  /** The web conversation id, for the gates' log lines. */
  conversationId: string;
  /** The conversation's row; `null` when the dispatch will create it. */
  conversation: Conversation | null;
  workflowName: string;
  checkout?: WorkflowCheckout;
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
 * resolves: a fresh run that adopts nothing, from a checkout that is its own workflow
 * source. That start gets the dispatch's own signature gates. Three starts are judged on a
 * definition only the dispatch can reach, so it answers them on the conversation as before:
 * one that adopts a run, whose branch can carry its own workflow; one whose conversation
 * sits in a worktree, which runs the workflow of the canonical repository; and one that
 * continues a paused run, which runs the definition frozen on that run. A start with more than
 * one run it could continue is left to the dispatch too, which lists them.
 *
 * A conversation with no project resolves workflows as the dispatch does for it, and has no
 * run to continue.
 */
export async function workflowStartRefusal(start: WorkflowStart): Promise<string | undefined> {
  const { conversation, workflowName, actor } = start;
  if (start.adoptRunId !== undefined) return undefined;
  const codebase = conversation?.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  const checkoutRefusal = checkoutConversationRefusal(start, codebase);
  if (checkoutRefusal) return checkoutRefusal;
  if (await dispatchOwnsWorkflowSource(conversation, codebase)) return undefined;

  const command = await startWorkflow(
    conversation ?? { codebase_id: null, cwd: null },
    workflowName,
    '',
    false,
    {}
  );
  const request = command.workflow;
  if (request?.kind !== 'start') return command.message;
  if (start.checkout) {
    if (request.definition.worktree?.enabled === false)
      return 'checkout requires a workflow with worktree isolation';
  }

  if (conversation && codebase) {
    const read = await readContinuation({ conversation, codebase }, request, request.definition);
    if (dispatchAnswersContinuation(read)) return continuationRefusal(start);
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

function checkoutConversationRefusal(
  start: WorkflowStart,
  codebase: Codebase | null
): string | undefined {
  if (!start.checkout) return undefined;
  if (!codebase || codebase.kind === 'folder' || start.conversation?.isolation_env_id) {
    return 'checkout requires a fresh conversation attached to a repository';
  }
  return undefined;
}

function continuationRefusal(start: WorkflowStart): string | undefined {
  return start.checkout ? 'checkout cannot resume an existing run' : undefined;
}

async function dispatchOwnsWorkflowSource(
  conversation: Conversation | null,
  codebase: Codebase | null
): Promise<boolean> {
  if (!conversation || !codebase) return false;
  // A worktree or unresolvable checkout is re-resolved by dispatch before loading its workflow.
  const sourceRoot = await resolveWorkflowSourceRoot(
    conversation.cwd ?? codebase.default_cwd
  ).catch(() => 'unknown');
  return sourceRoot !== undefined;
}
