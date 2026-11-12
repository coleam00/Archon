import { expect, test } from 'bun:test';
import {
  admissionWorkflowNotice,
  workflowNoticeSchema,
  WORKFLOW_NOTICE_LIMITS,
} from './workflow-notice';
import type { AdmissionNoticeFacts } from './admission-notice';
import { requestingRun } from './schemas/resource-start';

const facts: AdmissionNoticeFacts = {
  requestId: '00000000-0000-4000-8000-000000000001',
  receiptId: '00000000-0000-4000-8000-000000000002',
  bindingId: `binding\n${'b'.repeat(300)}`,
  resource: `resource\u001b${'r'.repeat(300)}`,
  overlap: 'skip',
  blocker: { kind: 'run', id: '00000000-0000-4000-8000-000000000003' },
  deliveryId: `delivery\u007f${'d'.repeat(300)}`,
  receivedAt: '2026-01-01T00:00:00.000Z',
  sourceActor: null,
  codebaseId: 'deleted-codebase',
  cwd: '/unregistered-project',
};

test('admission projection bounds presentation without dropping the signal or its request identity', async () => {
  const notice = await admissionWorkflowNotice(
    { store: { getCodebase: async () => null } },
    facts,
    null
  );
  expect(workflowNoticeSchema.safeParse(notice).success).toBe(true);
  expect(notice.text.length).toBeLessThanOrEqual(WORKFLOW_NOTICE_LIMITS.textLength);
  expect(notice.text).toContain(facts.blocker.id);
  expect(notice.labels.request).toBe(facts.requestId);
  expect(Object.keys(notice.labels)).toHaveLength(8);
  expect(notice.labels.binding).toEndWith('…');
  expect(notice.labels.binding).toHaveLength(WORKFLOW_NOTICE_LIMITS.labelValueLength);
  expect(notice.project).toMatchObject({ codebaseId: null });
  expect(notice.text).not.toMatch(/[\n\u001b\u007f]/u);
});

test('a deleted source retains run attribution with binding project context', async () => {
  const sourced = {
    ...facts,
    sourceActor: { source: 'archon-run', id: 'deleted-source', display: 'handoff' },
  };
  expect(requestingRun(sourced.sourceActor)).not.toBeNull();
  const notice = await admissionWorkflowNotice(
    { store: { getCodebase: async () => null } },
    sourced,
    null
  );
  expect(workflowNoticeSchema.safeParse(notice).success).toBe(true);
  expect(notice).toMatchObject({
    runId: 'deleted-source',
    node: 'handoff',
    workflow: null,
    parentRunId: null,
  });
  expect(notice.project).not.toBeNull();
});
