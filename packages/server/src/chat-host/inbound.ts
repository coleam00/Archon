import type {
  ChatActor,
  ChatPluginDescriptor,
  ConnectedChat,
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
import { CancelRefusedError } from '@archon/core/operations/workflow-operations';
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
  } catch {
    getLog().warn({ platform }, 'server.user_resolve_failed');
    return undefined;
  }
}

export function createMessageErrorHandler(
  platform: string,
  adapter: IPlatformAdapter,
  conversationId: string
): (error: unknown) => Promise<void> {
  return async error => {
    getLog().error({ platform }, 'message_processing_failed');
    try {
      await adapter.sendMessage(conversationId, classifyAndFormatError(error as Error, adapter));
    } catch {
      getLog().error({ platform }, 'error_message_send_failed');
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
  connection.onRunAction(async (action): Promise<ChatRunActionResponse> => {
    if (!isAllowed(action.sender.platformUserId))
      return { status: 'rejected', reason: 'not_allowed' };
    const actor = await actorFor(action.sender);
    try {
      const operations = createSqlWorkflowOperations();
      if (action.action === 'cancel') {
        const result = await operations.cancelWorkflow(action.runId, actor);
        return {
          status: 'done',
          result:
            result.kind === 'cooperative'
              ? { kind: 'cooperative', cancelled: result.cancelled }
              : {
                  kind: 'stopped',
                  pid: result.pid,
                  cleanupWarnings: result.cleanupWarnings,
                  cascadeFailures: result.cascadeFailures,
                  blockedParentRunId: result.blockedParentRunId,
                },
        };
      }
      const response = action.response;
      const result = await operations.respondToWorkflow(
        action.runId,
        action.action === 'respond' ? action.response.decision : action.action,
        response?.text,
        actor,
        response?.nodeId
          ? response.pauseId
            ? { nodeId: response.nodeId, pauseId: response.pauseId }
            : response.nodeId
          : undefined
      );
      let resumed = false;
      if (!('cancelled' in result) || !result.cancelled) {
        const run = await workflowDb.getWorkflowRun(action.runId);
        if (run) {
          const target = await workflowResumeTargetForRun(run, platforms);
          resumed = await resumeWorkflowRunFromServer(
            createSqlWorkflowHost(),
            run,
            actor.kind === 'user' ? actor.userId : undefined,
            target
          );
        }
      }
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
                resumed,
              }
            : { kind: 'approved', type: result.type, resumed },
      };
    } catch (error) {
      if (error instanceof RunActionForbiddenError)
        return { status: 'forbidden', message: error.message };
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
    }
  });
}
