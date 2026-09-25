import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { loadWebhookSourcePlugins } from './webhook-source-plugins';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempTree));
});

function acceptance(
  sourceInstanceId = 'source-1'
): Extract<SourceReceiptAcceptance, { outcome: 'matched' }> {
  return {
    receipt: {
      id: '11111111-1111-4111-8111-111111111111',
      sourceInstanceId,
      deliveryId: 'delivery-1',
      contentDigest: 'sha256:digest',
      receivedAt: '2026-01-01T00:00:00.000Z',
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'binding-1',
        bindingRevision: null,
        hostId: 'host-1',
        runAsUserId: 'user-1',
        resource: 'repo:one',
        capacity: 1,
        overlap: 'queue',
        launch: {
          cwd: '/tmp/repo',
          workflowName: 'work',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
    ],
  };
}

async function fixture(result: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'archon-webhook-source-'));
  roots.push(root);
  const modulePath = join(root, 'source.ts');
  const configPath = join(root, 'sources.json');
  await writeFile(
    modulePath,
    `export default ({ config }) => ({ receive: async () => config });\n`,
    'utf8'
  );
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sources: [{ sourceInstanceId: 'source-1', module: modulePath, config: result }],
    }),
    'utf8'
  );
  return { configPath };
}

describe('webhook source plugin host', () => {
  test('loads an operator module outside the repository and persists before acknowledging', async () => {
    const { configPath } = await fixture({ status: 'received', acceptance: acceptance() });
    let release: (() => void) | undefined;
    const persisted = new Promise<void>(resolve => (release = resolve));
    const acceptReceipt = mock(async () => {
      await persisted;
      return { receiptId: acceptance().receipt.id, replay: false };
    });
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => true),
    });

    const result = host.receive('source-1', {
      body: 'raw',
      headers: { authorization: 'secret' },
      receivedAt: new Date().toISOString(),
    });
    let acknowledged = false;
    void result.then(() => (acknowledged = true));
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release?.();
    expect(await result).toBe('accepted');
    expect(acceptReceipt).toHaveBeenCalledTimes(1);
  });

  test('rejects an acceptance for a different configured source', async () => {
    const { configPath } = await fixture({
      status: 'received',
      acceptance: acceptance('source-2'),
    });
    const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => true),
    });
    await expect(
      host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toThrow('another source');
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('does not persist unauthenticated or unknown-user receipts', async () => {
    const unauthenticated = await fixture({ status: 'rejected', reason: 'unauthenticated' });
    const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
    const first = await loadWebhookSourcePlugins(unauthenticated.configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => false),
    });
    expect(
      await first.receive('source-1', {
        body: '',
        headers: {},
        receivedAt: new Date().toISOString(),
      })
    ).toBe('unauthenticated');

    const unknownUser = await fixture({ status: 'received', acceptance: acceptance() });
    const second = await loadWebhookSourcePlugins(unknownUser.configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => false),
    });
    await expect(
      second.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toThrow('unknown run-as user');
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test.each(['matched', 'unmatched', 'unsupported', 'malformed'] as const)(
    'rejects a contradictory %s receipt before persistence',
    async outcome => {
      const invalid = {
        ...acceptance(),
        outcome,
        bindings: outcome === 'matched' ? [] : acceptance().bindings,
      };
      const { configPath } = await fixture({ status: 'received', acceptance: invalid });
      const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
      const host = await loadWebhookSourcePlugins(configPath, {
        acceptReceipt,
        isKnownUser: mock(async () => true),
      });
      await expect(
        host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
      ).rejects.toThrow('failed to normalize');
      expect(acceptReceipt).not.toHaveBeenCalled();
    }
  );

  test('returns malformed only after the durable receipt is accepted', async () => {
    const malformed: SourceReceiptAcceptance = {
      ...acceptance(),
      outcome: 'malformed',
      bindings: [],
    };
    const { configPath } = await fixture({ status: 'received', acceptance: malformed });
    const acceptReceipt = mock(async () => ({ receiptId: malformed.receipt.id, replay: false }));
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => true),
    });
    expect(
      await host.receive('source-1', {
        body: '',
        headers: {},
        receivedAt: new Date().toISOString(),
      })
    ).toBe('malformed');
    expect(acceptReceipt).toHaveBeenCalledTimes(1);
  });

  test('rejects duplicate binding identities before persistence', async () => {
    const duplicate = acceptance();
    duplicate.evaluatedBindings = [
      {
        bindingId: duplicate.bindings[0].bindingId,
        bindingRevision: null,
        status: 'rejected',
        reason: 'not selected',
      },
    ];
    const { configPath } = await fixture({ status: 'received', acceptance: duplicate });
    const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: mock(async () => true),
    });
    await expect(
      host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toThrow('failed to normalize');
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('does not acknowledge a receipt whose durable acceptance fails', async () => {
    const { configPath } = await fixture({ status: 'received', acceptance: acceptance() });
    const cause = new Error('database detail');
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: mock(async () => {
        throw cause;
      }),
      isKnownUser: mock(async () => true),
    });
    await expect(
      host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toMatchObject({ message: expect.stringContaining('persistence failed'), cause });
  });
});
