import { generateConversationId } from '../utils/conversation-id';
import { CLIAdapter } from '../adapters/cli-adapter';
import { createCliWorkflowHost } from '../utils/workflow-host';
import { handleMessage } from '@archon/core';

export async function chatCommand(message: string): Promise<void> {
  const adapter = new CLIAdapter({ streamingMode: 'batch' });
  const conversationId = generateConversationId('cli-chat');

  const host = await createCliWorkflowHost(true);
  await handleMessage(adapter, conversationId, message, {
    actor: { kind: 'operator' },
    workflowOperations: host.operations,
    afterOwnedExecution: host.afterOwnedExecution,
  });
}
