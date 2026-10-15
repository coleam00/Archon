import type { ChatPluginDescriptor } from '@archon/chat-contract';
import { version } from '../package.json';

export const descriptor = {
  protocol: 'archon-chat/1',
  id: 'slack',
  displayName: 'Slack',
  version,
  capabilities: {
    attentionNotices: true,
    canDetachProject: true,
    defaultWorkflowDispatch: 'foreground',
    resultFooter: true,
    runEvents: true,
  },
  workflowCommand: { prefix: '/archon-workflow ' },
  policy: {
    workspaceRetention: 'age-based',
    streaming: { defaultMode: 'batch', envVar: 'SLACK_STREAMING_MODE' },
  },
  allowlist: { envVar: 'SLACK_ALLOWED_USER_IDS' },
} satisfies ChatPluginDescriptor;
