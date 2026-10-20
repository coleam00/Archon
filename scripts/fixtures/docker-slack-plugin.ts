import { serveChat, type ChatPluginDescriptor } from '../../packages/chat-contract/src/index';

export const descriptor: ChatPluginDescriptor = {
  protocol: 'archon-chat/1',
  id: 'slack',
  displayName: 'Docker Slack fixture',
  version: 'fixture',
  capabilities: { defaultWorkflowDispatch: 'background' },
  policy: { workspaceRetention: 'age-based' },
};

if (import.meta.main) {
  await serveChat({
    descriptor,
    async start() {
      return undefined;
    },
    async send() {
      return undefined;
    },
  });
}
