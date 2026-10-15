import { expect, test } from 'bun:test';
import { descriptor } from './descriptor';

test('Slack declares the installed host policy', () => {
  expect(descriptor).toMatchObject({
    id: 'slack',
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
  });
});
