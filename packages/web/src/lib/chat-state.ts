import type { CodebaseResponse, ConversationResponse } from './api';

export function getEffectiveProjectId(
  selectedProjectId: string | null,
  codebases: CodebaseResponse[] | undefined
): string | undefined {
  if (!selectedProjectId) return undefined;
  return codebases?.some(codebase => codebase.id === selectedProjectId)
    ? selectedProjectId
    : undefined;
}

export function resolveCurrentConversation(
  conversationId: string,
  routeConversation: ConversationResponse | undefined,
  conversations: ConversationResponse[] | undefined
): ConversationResponse | undefined {
  if (routeConversation) return routeConversation;
  return conversations?.find(
    conversation => conversation.platform_conversation_id === conversationId
  );
}
