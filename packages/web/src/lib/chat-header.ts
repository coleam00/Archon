interface ChatHeaderWorkflowResult {
  workflowName?: string | null;
  runId?: string | null;
}

interface ChatHeaderWorkflowDispatch {
  workflowName?: string | null;
  workerConversationId?: string | null;
}

export interface ChatHeaderWorkflowMessage {
  workflowResult?: ChatHeaderWorkflowResult;
  workflowDispatch?: ChatHeaderWorkflowDispatch;
}

export type ChatHeaderWorkflowReference =
  | { kind: 'result'; runId: string }
  | { kind: 'dispatch'; workerConversationId: string };

function cleanPathCandidate(path: string | null | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}

export function resolveChatHeaderPath(
  conversationCwd: string | null | undefined,
  cwdOverride: string | null | undefined,
  workflowWorkingPath?: string | null
): string | undefined {
  return (
    cleanPathCandidate(cwdOverride) ??
    cleanPathCandidate(workflowWorkingPath) ??
    cleanPathCandidate(conversationCwd)
  );
}

export function getLatestWorkflowReference(
  messages: readonly ChatHeaderWorkflowMessage[]
): ChatHeaderWorkflowReference | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const resultRunId = message.workflowResult?.runId?.trim();
    if (resultRunId) {
      return { kind: 'result', runId: resultRunId };
    }

    const workerConversationId = message.workflowDispatch?.workerConversationId?.trim();
    if (workerConversationId) {
      return { kind: 'dispatch', workerConversationId };
    }
  }

  return undefined;
}
