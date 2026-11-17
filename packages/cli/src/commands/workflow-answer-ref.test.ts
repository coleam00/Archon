import { describe, expect, test } from 'bun:test';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { startsOf } from './workflow-answer-ref';

const CAUSED: SourceReceiptAcceptance = {
  outcome: 'matched',
  bindings: [
    {
      bindingId: 'build',
      bindingRevision: null,
      hostId: 'factory-host',
      runAsUserId: 'factory-operator',
      resource: 'build',
      overlap: 'queue',
      launch: {
        cwd: '/projects/acme',
        workflowName: 'build',
        inputs: {},
        isolation: { kind: 'default' },
      },
    },
  ],
  receipt: {
    id: '00000000-0000-4000-8000-000000000001',
    sourceInstanceId: 'build-after-answers',
    deliveryId: 'asking-run',
    contentDigest: 'digest',
    receivedAt: '2026-11-16T10:00:00.000Z',
    occurredAt: null,
    sourceActor: null,
  },
};

describe('the starts a settling answer reports', () => {
  test('a receipt that cannot be read back is reported, naming it, without failing the answer', async () => {
    const starts = await startsOf([CAUSED], {
      getStartReceipt: async () => {
        throw new Error('receipt read unavailable');
      },
    });
    expect(starts.json).toEqual({
      startsUnread: { receiptIds: [CAUSED.receipt.id], error: 'receipt read unavailable' },
    });
    expect(starts.text).toContain(CAUSED.receipt.id);
  });
});
