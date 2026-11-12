import type {
  ChatActor,
  ChatPluginDescriptor,
  ConnectedChat,
  ChatRunAction,
  ChatRunActionResponse,
} from '@archon/chat-contract';
import {
  handleMessage,
  classifyAndFormatError,
  type IPlatformAdapter,
  type IdentityPlatform,
  type ConversationLockManager,
} from '@archon/core';
import * as userDb from '@archon/core/db/users';
import * as workflowDb from '@archon/core/db/workflows';
import { RunActionForbiddenError } from '@archon/core/operations/run-authorization';
import {
  ChildRunRedirectError,
  CancelRefusedError,
  ResumeRefusedError,
  StaleGateAnswerError,
  assertAnswerAdmissible,
  assertAnswerable,
  attentionAnswerFor,
  workflowOperationErrorMessage,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import {
  createSqlWorkflowHost,
  createSqlWorkflowOperations,
} from '@archon/core/workflows/sql-host';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';
import {
  workflowResumeTargetForRun,
  resumeWorkflowRunFromServer,
} from '../services/workflow-resume-service';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('server'));
}

/** Identity lookup failure preserves message delivery, with an unidentified actor. */
export async function resolveUserId(
  platform: IdentityPlatform,
  platformUserId: string | number | undefined,
  displayName: string | undefined
): Promise<string | undefined> {
  if (platformUserId === undefined || platformUserId === '') return undefined;
  try {
    return (
      await userDb.findOrCreateUserByPlatformIdentity(platform, String(platformUserId), displayName)
    ).id;
  } catch (err) {
    getLog().warn({ err, platform }, 'server.user_resolve_failed');
    return undefined;
  }
}

export function createMessageErrorHandler(
  platform: string,
  adapter: IPlatformAdapter,
  conversationId: string
): (error: unknown) => Promise<void> {
  return async error => {
    getLog().error({ err: error, platform }, 'message_processing_failed');
    try {
      await adapter.sendMessage(conversationId, classifyAndFormatError(error as Error, adapter));
    } catch (sendError) {
      getLog().error({ err: sendError, platform }, 'error_message_send_failed');
    }
  };
}

export function registerChatInbound(
  connection: ConnectedChat,
  descriptor: ChatPluginDescriptor,
  platform: IPlatformAdapter,
  lockManager: ConversationLockManager,
  platforms: ReadonlyMap<string, IWorkflowPlatform>
): void {
  const configured = descriptor.allowlist ? process.env[descriptor.allowlist.envVar] : undefined;
  const allowed = new Set(
    configured
      ?.split(',')
      .map(id => id.trim())
      .filter(Boolean)
  );
  const isAllowed = (id: string): boolean => allowed.size === 0 || allowed.has(id);
  const actorFor = async (sender: {
    platformUserId: string;
    displayName?: string;
  }): Promise<ChatActor> => {
    const userId = await resolveUserId(descriptor.id, sender.platformUserId, sender.displayName);
    return userId ? { kind: 'user', userId } : { kind: 'unidentified' };
  };
  connection.onInbound(async message => {
    if (!isAllowed(message.sender.platformUserId))
      return { status: 'rejected', reason: 'not_allowed' };
    const actor = await actorFor(message.sender);
    void lockManager
      .acquireLock(message.conversationId, () =>
        handleMessage(platform, message.conversationId, message.text, {
          threadContext: message.threadContext,
          parentConversationId: message.parentConversationId,
          isolationHints: { workflowType: 'thread', workflowId: message.conversationId },
          actor,
        }).catch(createMessageErrorHandler(descriptor.id, platform, message.conversationId))
      )
      .catch(createMessageErrorHandler(descriptor.id, platform, message.conversationId));
    return { status: 'accepted' };
  });
  // Runs after the action is recorded or admitted; a failed resume must not report it refused.
  const continueRun = async (
    runId: string,
    actor: ChatActor,
    action: ChatRunAction['action']
  ): Promise<{ resumed: boolean; waitingForCapacity?: true }> => {
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return { resumed: false };
      const target = await workflowResumeTargetForRun(run, platforms);
      const outcome = await resumeWorkflowRunFromServer(
        createSqlWorkflowHost(),
        run,
        actor.kind === 'user' ? actor.userId : undefined,
        target
      );
      return outcome.kind === 'waiting_for_capacity'
        ? { resumed: false, waitingForCapacity: true }
        : { resumed: outcome.kind === 'resumed' };
    } catch (err) {
      getLog().warn({ err, runId, plugin: descriptor.id, action }, 'chat.run_resume_failed');
      return { resumed: false };
    }
  };
  type Operations = ReturnType<typeof createSqlWorkflowOperations>;
  const answerRun = async (
    operations: Operations,
    action: Extract<ChatRunAction, { action: 'answer' }>,
    actor: ChatActor
  ): Promise<ChatRunActionResponse> => {
    const run = await workflowDb.getWorkflowRun(action.runId);
    if (!run) return { status: 'refused', message: 'Workflow run not found' };
    // Authorize first, so a member who may not answer never learns the open occurrence.
    await operations.assertRunActionAllowed(run, actor, 'respond');
    const { nodeId, pauseId, choose, text } = action.response;
    const origin: GateAnswerOrigin = { via: descriptor.id, expectedGate: { nodeId, pauseId } };
    const request = text === undefined ? { choose } : { choose, text };
    try {
      assertAnswerAdmissible(run, origin);
      attentionAnswerFor(run, assertAnswerable(run), request);
    } catch (refusal) {
      return { status: 'refused', message: workflowOperationErrorMessage(refusal, platform) };
    }
    await operations.answerWorkflow(action.runId, request, actor, origin);
    return {
      status: 'done',
      result: { kind: 'answered', ...(await continueRun(action.runId, actor, 'answer')) },
    };
  };
  const cancelRun = async (
    operations: Operations,
    action: ChatRunAction,
    actor: ChatActor
  ): Promise<ChatRunActionResponse> => {
    const result = await operations.cancelWorkflow(action.runId, actor);
    return {
      status: 'done',
      result:
        result.kind === 'cooperative'
          ? {
              kind: 'cooperative',
              cancelled: result.cancelled,
              cleanupWarnings: result.cleanupWarnings,
            }
          : {
              kind: 'stopped',
              pid: result.pid,
              cleanupWarnings: result.cleanupWarnings,
              cascadeFailures: result.cascadeFailures,
              blockedParentRunId: result.blockedParentRunId,
            },
    };
  };
  const respondToRun = async (
    operations: Operations,
    action: Exclude<ChatRunAction, { action: 'answer' | 'resume' | 'cancel' }>,
    actor: ChatActor
  ): Promise<ChatRunActionResponse> => {
    const response = action.response;
    const result = await operations.respondToWorkflow(
      action.runId,
      action.action === 'respond' ? action.response.decision : action.action,
      response?.text,
      actor,
      {
        via: descriptor.id,
        ...(response?.nodeId
          ? {
              expectedGate: response.pauseId
                ? { nodeId: response.nodeId, pauseId: response.pauseId }
                : response.nodeId,
            }
          : {}),
      }
    );
    const resume =
      !('cancelled' in result) || !result.cancelled
        ? await continueRun(action.runId, actor, action.action)
        : { resumed: false };
    return {
      status: 'done',
      result:
        'cancelled' in result
          ? {
              kind: 'rejected',
              cancelled: result.cancelled,
              maxAttemptsReached: result.maxAttemptsReached,
              writeBack: result.writeBack,
              newMode: result.newMode,
              cleanupWarnings: result.cleanupWarnings,
              ...resume,
            }
          : { kind: 'approved', type: result.type, ...resume },
    };
  };
  const actionFailure = (error: unknown, action: ChatRunAction): ChatRunActionResponse => {
    if (error instanceof RunActionForbiddenError)
      return { status: 'forbidden', message: error.message };
    if (error instanceof ChildRunRedirectError)
      return { status: 'refused', message: error.messageFor(platform) };
    if (error instanceof StaleGateAnswerError || error instanceof ResumeRefusedError)
      return { status: 'refused', message: error.message };
    if (error instanceof CancelRefusedError)
      return {
        status: 'refused',
        message: error.message,
        ...(error.reason === 'no_owner_answered'
          ? {
              abandonHint: `Use ${platform.formatWorkflowCommand?.(`abandon ${action.runId}`) ?? `/workflow abandon ${action.runId}`} only after confirming the owner is gone.`,
            }
          : {}),
      };
    getLog().error({ plugin: descriptor.id, action: action.action }, 'chat.run_action_failed');
    return { status: 'refused', message: 'The run action failed. Check the server diagnostics.' };
  };
  connection.onRunAction(async (action): Promise<ChatRunActionResponse> => {
    if (!isAllowed(action.sender.platformUserId))
      return { status: 'rejected', reason: 'not_allowed' };
    const actor = await actorFor(action.sender);
    try {
      const operations = createSqlWorkflowOperations();
      if (action.action === 'resume') {
        await operations.resumeWorkflow(action.runId, actor);
        return {
          status: 'done',
          result: { kind: 'resumed', ...(await continueRun(action.runId, actor, 'resume')) },
        };
      }
      if (action.action === 'answer') return await answerRun(operations, action, actor);
      if (action.action === 'cancel') return await cancelRun(operations, action, actor);
      return await respondToRun(operations, action, actor);
    } catch (error) {
      return actionFailure(error, action);
    }
  });
}
