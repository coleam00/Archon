import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type { StoredItemWait } from '@archon/workflows/schemas/item-wait';
import {
  createItemWaitObserver,
  type ItemWaitObserverStore,
  loadWebhookSourcePlugins,
} from './source-plugins';

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
      hasDeliveryReceipt: async () => false,
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
      hasDeliveryReceipt: async () => false,
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
      hasDeliveryReceipt: async () => false,
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
      hasDeliveryReceipt: async () => false,
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
        hasDeliveryReceipt: async () => false,
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
      hasDeliveryReceipt: async () => false,
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
      hasDeliveryReceipt: async () => false,
    });
    await expect(
      host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toThrow('failed to normalize');
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('acknowledges a recorded delivery even after its run-as user is removed', async () => {
    const { configPath } = await fixture({ status: 'received', acceptance: acceptance() });
    const acceptReceipt = mock(async () => ({ receiptId: 'first', replay: true }));
    const isKnownUser = mock(async () => false);
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser,
      hasDeliveryReceipt: async (sourceInstanceId, deliveryId) =>
        sourceInstanceId === 'source-1' && deliveryId === 'delivery-1',
    });
    expect(
      await host.receive('source-1', {
        body: '',
        headers: {},
        receivedAt: new Date().toISOString(),
      })
    ).toBe('accepted');
    // The store, not the lookup, still decides replay versus conflict.
    expect(acceptReceipt).toHaveBeenCalledTimes(1);
    expect(isKnownUser).not.toHaveBeenCalled();
  });

  test('maps only typed delivery conflicts', async () => {
    const { configPath } = await fixture({ status: 'received', acceptance: acceptance() });
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: async () => {
        throw new SourceReceiptDigestConflictError('conflict');
      },
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    });
    expect(
      await host.receive('source-1', {
        body: '',
        headers: {},
        receivedAt: new Date().toISOString(),
      })
    ).toBe('conflict');
  });

  test('does not acknowledge a receipt whose durable acceptance fails', async () => {
    const { configPath } = await fixture({ status: 'received', acceptance: acceptance() });
    const cause = new Error('Delivery identity was reused with different verified content');
    const host = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: mock(async () => {
        throw cause;
      }),
      isKnownUser: mock(async () => true),
      hasDeliveryReceipt: async () => false,
    });
    await expect(
      host.receive('source-1', { body: '', headers: {}, receivedAt: new Date().toISOString() })
    ).rejects.toMatchObject({ message: expect.stringContaining('persistence failed'), cause });
  });
});

const REVISION = 'a'.repeat(40);
const REMOTE = 'https://github.com/owner/repo.git';

/**
 * A source that observes: it reads the checks at `revision` (by default the first wait's
 * `about`) and returns `acceptances`, each with a fresh receipt id as a plugin would.
 */
async function observingFixture(
  plugin: { acceptances: unknown[]; revision?: string },
  observe: unknown = { everySeconds: 60 }
) {
  const root = await mkdtemp(join(tmpdir(), 'archon-webhook-source-'));
  roots.push(root);
  const modulePath = join(root, 'source.ts');
  const configPath = join(root, 'sources.json');
  await writeFile(
    modulePath,
    `export default ({ config }) => ({
  receive: async () => ({ status: 'rejected', reason: 'unauthenticated' }),
  observe: async ({ waits, forge }) => {
    await forge.commitChecks({ remote: waits[0].remote, revision: config.revision ?? waits[0].about });
    return {
      acceptances: config.acceptances.map(a => ({ ...a, receipt: { ...a.receipt, id: crypto.randomUUID() } })),
      unserved: [],
    };
  },
});\n`,
    'utf8'
  );
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sources: [{ sourceInstanceId: 'source-1', module: modulePath, config: plugin, observe }],
    }),
    'utf8'
  );
  return configPath;
}

function waitStore(waits: Partial<StoredItemWait>[]): ItemWaitObserverStore {
  return {
    listOpenItemWaits: async () =>
      waits.map(wait => ({
        id: 'wait-1',
        itemId: 'item-1',
        runId: 'run-1',
        workflowName: 'host',
        position: 0,
        event: 'checks',
        about: REVISION,
        openedAt: '2026-01-01T00:00:00.000Z',
        deadlineAt: '2026-01-01T01:00:00.000Z',
        closed: null,
        ...wait,
      })),
    getWorkflowRun: (async () => ({ codebase_id: 'codebase-1' })) as never,
    getCodebase: (async () => ({ repository_url: REMOTE })) as never,
  };
}

function forgeReader() {
  const reads: { remote: string; revision: string }[] = [];
  return {
    reads,
    commitChecks: async (input: { remote: string; revision: string }) => {
      reads.push(input);
      return {} as never;
    },
  };
}

describe('observing open item waits', () => {
  test('with no open waits, no source is called and nothing reads the forge', async () => {
    const configPath = await observingFixture({ acceptances: [acceptance()] });
    const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    expect(observer?.observing).toEqual([{ sourceInstanceId: 'source-1', everySeconds: 60 }]);
    expect(await observer?.pass(new Date())).toEqual([]);
    expect(forge.reads).toEqual([]);
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('the forge is asked only about a commit an open wait names', async () => {
    const configPath = await observingFixture({
      acceptances: [acceptance()],
      revision: 'b'.repeat(40),
    });
    const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt,
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({ sources, store: waitStore([{}]), forge });
    const [report] = (await observer?.pass(new Date())) ?? [];
    expect(report).toMatchObject({ source: 'source-1', waits: 1, commits: 0, receipts: [] });
    expect(report?.error).toContain('No open wait names commit');
    expect(forge.reads).toEqual([]);
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('observes a source again only once its interval has passed', async () => {
    const configPath = await observingFixture({ acceptances: [acceptance()] });
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: async input => ({ receiptId: input.receipt.id, replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({ sources, store: waitStore([{}]), forge });
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    expect(await observer?.pass(new Date(start))).toHaveLength(1);
    expect(await observer?.pass(new Date(start + 59_000))).toEqual([]);
    expect(await observer?.pass(new Date(start + 60_000))).toHaveLength(1);
    expect(forge.reads).toEqual([
      { remote: REMOTE, revision: REVISION },
      { remote: REMOTE, revision: REVISION },
    ]);
  });

  test('admits an observed acceptance as a delivered one: run-as gate, replay and conflict', async () => {
    const configPath = await observingFixture({ acceptances: [acceptance()] });
    const forge = forgeReader();
    const observe = async (dependencies: Parameters<typeof loadWebhookSourcePlugins>[1]) => {
      const sources = await loadWebhookSourcePlugins(configPath, dependencies);
      const observer = createItemWaitObserver({ sources, store: waitStore([{}]), forge });
      return (await observer?.pass(new Date())) ?? [];
    };
    const acceptReceipt = mock(async () => ({ receiptId: 'first', replay: true }));
    const [unknown] = await observe({
      acceptReceipt,
      isKnownUser: async () => false,
      hasDeliveryReceipt: async () => false,
    });
    expect(unknown?.error).toContain('unknown run-as user');
    expect(acceptReceipt).not.toHaveBeenCalled();

    // One acceptance refused does not hide another admitted in the same pass.
    const ghost = acceptance();
    ghost.receipt.deliveryId = 'delivery-ghost';
    ghost.bindings[0].runAsUserId = 'ghost';
    const mixedPath = await observingFixture({ acceptances: [ghost, acceptance()] });
    const mixed = await loadWebhookSourcePlugins(mixedPath, {
      acceptReceipt: async input => ({ receiptId: input.receipt.id, replay: false }),
      isKnownUser: async id => id !== 'ghost',
      hasDeliveryReceipt: async () => false,
    });
    const [partial] =
      (await createItemWaitObserver({ sources: mixed, store: waitStore([{}]), forge })?.pass(
        new Date()
      )) ?? [];
    expect(partial?.receipts).toHaveLength(1);
    expect(partial?.error).toContain('unknown run-as user');

    // A replay is recorded already, so it is no receipt of this pass.
    const [replayed] = await observe({
      acceptReceipt,
      isKnownUser: async () => false,
      hasDeliveryReceipt: async () => true,
    });
    expect(replayed).toMatchObject({ receipts: [], conflicts: 0 });
    expect(replayed?.error).toBeUndefined();

    const [conflicting] = await observe({
      acceptReceipt: async () => {
        throw new SourceReceiptDigestConflictError('conflict');
      },
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    });
    expect(conflicting).toMatchObject({ receipts: [], conflicts: 1 });
  });

  test('a source without observe is never observed, and one whose plugin cannot is refused', async () => {
    const { configPath } = await fixture({ status: 'rejected', reason: 'unauthenticated' });
    const dependencies = {
      acceptReceipt: async () => ({ receiptId: 'unused', replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
    };
    const sources = await loadWebhookSourcePlugins(configPath, dependencies);
    expect(
      createItemWaitObserver({ sources, store: waitStore([{}]), forge: forgeReader() })
    ).toBeUndefined();

    const declared = JSON.parse(await Bun.file(configPath).text()) as {
      sources: Record<string, unknown>[];
    };
    for (const source of declared.sources) source.observe = { everySeconds: 60 };
    await writeFile(configPath, JSON.stringify(declared), 'utf8');
    await expect(loadWebhookSourcePlugins(configPath, dependencies)).rejects.toThrow(
      'its plugin cannot observe waits'
    );
  });
});
