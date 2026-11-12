/**
 * Chat workflow dispatch: starting, resuming and continuing workflow runs on
 * behalf of a conversation. `handleMessage` in orchestrator-agent.ts stays the
 * public entry and calls in here; the dispatch phases live under `./dispatch/`.
 */
import { withCapturedSource } from '@archon/workflows/run-source';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import type { WorkflowSource } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { spellWorkflowCommand } from '@archon/workflows/deps';
import type { RunActor } from '../operations/run-authorization';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  WorkflowRequest,
} from '../types';
import * as codebaseDb from '../db/codebases';
import { toError } from '../utils/error';
import { getLog } from './agent-log';
import { dispatchOrchestratorWorkflowOwned } from './dispatch/owned-dispatch';
import type { WorkflowDispatchOptions } from './dispatch/scope';

export type { WorkflowDispatchOptions } from './dispatch/scope';

/**
 * Dispatch a workflow, owning any capture it takes.
 *
 * A thin owner around the implementation, matching the CLI's shape. The implementation has
 * five ordinary early returns after a capture is allocated — the inputs gate, the GitHub
 * requirement gate, an isolation error, a resume with no working path, and the routine
 * "resume or force?" menu — and every one of them used to abandon a complete frozen tree.
 */
export async function dispatchOrchestratorWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  request: WorkflowRequest,
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints'],
  source?: WorkflowSource,
  options?: WorkflowDispatchOptions
): Promise<void> {
  await withCapturedSource(owner =>
    dispatchOrchestratorWorkflowOwned({
      owner,
      platform,
      conversationId,
      conversation,
      codebase,
      request,
      actor,
      isolationHints,
      source,
      options,
    })
  );
}

/** A human gate the chat agent resolved during a turn, awaiting continuation. */
export interface ResolvedGate {
  run: WorkflowRun;
  action: 'approve' | 'reject' | 'respond';
}

/**
 * Continue a run whose human gate the chat agent just resolved (#2565).
 *
 * A resolution leaves the run `paused` on purpose — `approveWorkflow` and
 * `rejectWorkflow` record the decision and let the caller decide when to move
 * (`workflow-operations.ts`). This is chat's "when": the same resume dispatch the
 * removed natural-language branch performed, now triggered by the agent's
 * explicit approve/reject verb instead of by "the message did not start with /".
 * Resolution without continuation would strand the run on every chat surface.
 *
 * Never throws — the gate decision is already committed, so a failure here costs
 * the user a manual `/workflow resume`, not the decision. The whole body is
 * guarded so that guarantee holds for the `finally` this runs from, where a
 * throw would replace the error the user actually needs to see.
 *
 * Exported so its continuation behavior can be tested without staging a whole agent turn
 * with a gate-resolving tool call.
 */
export async function continueResolvedGateRun(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase | null,
  run: WorkflowRun,
  action: 'approve' | 'reject' | 'respond',
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  const decision =
    action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Responded';
  const notify = async (text: string): Promise<void> => {
    await platform.sendMessage(conversationId, text).catch((sendErr: unknown) => {
      getLog().warn(
        { err: toError(sendErr), conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_notice_failed'
      );
    });
  };

  try {
    if (!codebase) {
      getLog().warn(
        { conversationId, workflowRunId: run.id },
        'orchestrator.gate_continuation_no_codebase'
      );
      await notify(
        `${decision}, but no project is attached to this conversation, so the run could not ` +
          `continue. The decision is recorded — use \`${spellWorkflowCommand(platform, `resume ${run.id}`)}\` from the project.`
      );
      return;
    }

    getLog().info(
      { conversationId, workflowRunId: run.id, workflowName: run.workflow_name, action },
      'orchestrator.gate_continuation_requested'
    );
    try {
      await notify(`${decision}. Continuation requested for **${run.workflow_name}**.`);
      await dispatchOrchestratorWorkflow(
        platform,
        conversationId,
        conversation,
        codebase,
        { kind: 'resume', run },
        actor,
        isolationHints
      );
      getLog().info(
        { conversationId, workflowRunId: run.id, workflowName: run.workflow_name, action },
        'orchestrator.gate_continuation_request_handled'
      );
    } catch (error) {
      const err = toError(error);
      // The run's terminal status could not be written, so its row still says `running`
      // and its true outcome is unknown. `/workflow resume` is the wrong advice — it
      // refuses a non-terminal row, and the run may well have finished its work.
      if (error instanceof TerminalStatusWriteError) {
        getLog().error(
          { err, conversationId, workflowRunId: run.id, action },
          'orchestrator.gate_continuation_terminal_write_failed'
        );
        await notify(
          `${decision}, and **${run.workflow_name}** ran, but its final status could not be saved ` +
            `(${err.message}). The decision is recorded — check \`${spellWorkflowCommand(platform, `get ${run.id}`)}\` ` +
            'before starting another run on this project.'
        );
        return;
      }
      getLog().error(
        { err, errorType: err.constructor.name, conversationId, workflowRunId: run.id, action },
        'orchestrator.gate_continuation_failed'
      );
      await notify(
        `${decision}, but resuming **${run.workflow_name}** failed: ${err.message}. ` +
          `The decision is recorded — retry with \`${spellWorkflowCommand(platform, `resume ${run.id}`)}\`.`
      );
    }
  } catch (error) {
    // Belt and braces for the "never throws" contract the finally relies on.
    getLog().error(
      { err: toError(error), conversationId, workflowRunId: run.id, action },
      'orchestrator.gate_continuation_failed'
    );
  }
}

/**
 * Handle /workflow run command when project context may be missing.
 * Implements Edge Case E2 from the plan.
 */
export async function handleWorkflowRunCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  request: WorkflowRequest,
  actor: RunActor,
  isolationHints?: HandleMessageContext['isolationHints'],
  options?: WorkflowDispatchOptions
): Promise<void> {
  // Check if conversation has a project
  if (conversation.codebase_id) {
    const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    if (!codebase) {
      await platform.sendMessage(conversationId, 'Codebase not found.');
      return;
    }

    // Route through dispatchOrchestratorWorkflow so validateAndResolveIsolation
    // always runs — ensures a worktree is created regardless of how the codebase
    // was registered (local path or GitHub URL clone).
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      request,
      actor,
      isolationHints,
      undefined,
      options
    );
    return;
  }

  const codebases = await codebaseDb.listCodebases();

  if (codebases.length === 0) {
    await platform.sendMessage(
      conversationId,
      'No projects registered. Ask me to set up a project first.'
    );
    return;
  }

  // Never pick a project for the user, even when only one is registered.
  const projectList = codebases.map(c => `- ${c.name}`).join('\n');
  await platform.sendMessage(
    conversationId,
    request.kind === 'resume'
      ? `Choose a project for this conversation with \`/setproject <name>\`, then retry \`${spellWorkflowCommand(platform, `resume ${request.run.id}`)}\`.\n\n${projectList}`
      : `Which project should this workflow run on?\n\n${projectList}\n\nReply with the project name, or choose one with \`/setproject <name>\` and then use: ${spellWorkflowCommand(platform, `run ${request.definition.name} "${request.args}"`)}`
  );
}
