import type { ChatPluginDescriptor } from '@archon/chat-contract';

export const descriptor: ChatPluginDescriptor = {
  protocol: 'archon-chat/1',
  id: 'fixture-chat',
  displayName: 'Fixture chat',
  version: '1',
  capabilities: { defaultWorkflowDispatch: 'foreground', runEvents: true, resultFooter: true },
  policy: {
    workspaceRetention: 'retain',
    streaming: { envVar: 'FIXTURE_STREAMING', defaultMode: 'batch' },
  },
  allowlist: { envVar: 'FIXTURE_ALLOWED_USERS' },
  workflowCommand: { prefix: '/fixture-workflow ' },
};
