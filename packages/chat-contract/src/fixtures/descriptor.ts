import type { ChatPluginDescriptor } from '../descriptor';

export const descriptor = {
  protocol: 'archon-chat/1',
  id: 'test-chat',
  displayName: 'Test chat',
  version: '1',
  capabilities: {
    attentionNotices: true,
    defaultWorkflowDispatch: 'background',
    resultFooter: true,
    runEvents: true,
  },
  workflowCommand: { prefix: '/archon-workflow ' },
  policy: {
    workspaceRetention: 'age-based',
    streaming: { defaultMode: 'batch', envVar: 'CHAT_STREAMING' },
  },
  allowlist: { envVar: 'CHAT_ALLOWED' },
} satisfies ChatPluginDescriptor;
