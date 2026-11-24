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
      getReceipt: async () => null,
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

  test('an invalid configuration names the file, the field and what it must be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-webhook-source-'));
    roots.push(root);
    const configPath = join(root, 'sources.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [
          { sourceInstanceId: 's', module: '/m.ts', config: {}, observe: { everySeconds: 10 } },
        ],
      }),
      'utf8'
    );
    const load = loadWebhookSourcePlugins(configPath, {
      acceptReceipt: async () => ({ receiptId: 'unused', replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
    });
    await expect(load).rejects.toThrow(configPath);
    await expect(load).rejects.toThrow('sources.0.observe.everySeconds');
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
        getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
  plugin: {
    acceptances: unknown[];
    revision?: string;
    prNumber?: number;
    failed?: unknown[];
    failOnce?: boolean;
  },
  observe: unknown = { everySeconds: 60 }
) {
  const root = await mkdtemp(join(tmpdir(), 'archon-webhook-source-'));
  roots.push(root);
  const modulePath = join(root, 'source.ts');
  const configPath = join(root, 'sources.json');
  await writeFile(
    modulePath,
    `export default ({ config }) => {
  let failedOnce = false;
  return {
  receive: async () => ({ status: 'rejected', reason: 'unauthenticated' }),
  observe: async ({ waits, forge }) => {
    if (config.prNumber) await forge.prReviews({ remote: waits[0].remote, number: config.prNumber });
    else await forge.commitChecks({ remote: waits[0].remote, revision: config.revision ?? waits[0].about });
    const failing = config.failOnce === true && !failedOnce;
    failedOnce = true;
    return {
      acceptances: config.acceptances.map(a => ({ ...a, receipt: { ...a.receipt, id: crypto.randomUUID() } })),
      unserved: [],
      failed: failing || config.failOnce !== true ? (config.failed ?? []) : [],
    };
  },
};
};\n`,
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

function waitStore(waits: Partial<StoredItemWait>[], itemKey = 'pr-7'): ItemWaitObserverStore {
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
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        closed: null,
        ...wait,
      })),
    getItem: (async () => ({ key: itemKey })) as never,
    getWorkflowRun: (async () => ({ codebase_id: 'codebase-1' })) as never,
    getCodebase: (async () => ({ repository_url: REMOTE })) as never,
  };
}

function forgeReader() {
  const reads: ({ remote: string; revision: string } | { remote: string; number: number })[] = [];
  return {
    reads,
    commitChecks: async (input: { remote: string; revision: string }) => {
      reads.push(input);
      return {} as never;
    },
    prReviews: async (input: { remote: string; number: number }) => {
      reads.push(input);
      return {} as never;
    },
    issuesWithLabel: async (): Promise<never> => {
      throw new Error('no label read expected');
    },
    labelAdded: async (): Promise<never> => {
      throw new Error('no label read expected');
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
      getReceipt: async () => null,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    expect(observer?.observing).toEqual([
      { sourceInstanceId: 'source-1', everySeconds: 60, labels: [], unservedBindings: [] },
    ]);
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
      getReceipt: async () => null,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({ sources, store: waitStore([{}]), forge });
    const [report] = (await observer?.pass(new Date())) ?? [];
    expect(report).toMatchObject({ source: 'source-1', waits: 1, reads: 0, receipts: [] });
    expect(report?.error).toContain('No open wait names commit');
    expect(forge.reads).toEqual([]);
    expect(acceptReceipt).not.toHaveBeenCalled();
  });

  test('a pull request is read only when an open wait is on the item it names', async () => {
    const observeNumber = async (prNumber: number, itemKey?: string) => {
      const configPath = await observingFixture({ acceptances: [], prNumber });
      const sources = await loadWebhookSourcePlugins(configPath, {
        acceptReceipt: async () => ({ receiptId: 'unused', replay: false }),
        isKnownUser: async () => true,
        hasDeliveryReceipt: async () => false,
        getReceipt: async () => null,
      });
      const forge = forgeReader();
      const observer = createItemWaitObserver({
        sources,
        store: waitStore([{}], itemKey),
        forge,
      });
      const [report] = (await observer?.pass(new Date())) ?? [];
      return { report, reads: forge.reads };
    };
    // The wait is on item pr-7.
    expect(await observeNumber(7)).toMatchObject({
      report: { reads: 1 },
      reads: [{ remote: REMOTE, number: 7 }],
    });
    const refused = await observeNumber(8);
    expect(refused.reads).toEqual([]);
    expect(refused.report?.error).toContain('No open wait is on pull request 8');
    // A mapping whose prefix ends in a digit (`pr2` and 7 make `pr27`) still names 7.
    expect((await observeNumber(7, 'pr27')).reads).toEqual([{ remote: REMOTE, number: 7 }]);
  });

  test('a read the source could not make fails the pass, and what it did read is still admitted', async () => {
    const configPath = await observingFixture({
      acceptances: [acceptance()],
      failed: [
        {
          wait: { workflowName: 'host', event: 'checks', about: 'c'.repeat(40), itemKey: 'pr-8' },
          reason: 'commit not found',
        },
      ],
    });
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: async input => ({ receiptId: input.receipt.id, replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
    });
    const observer = createItemWaitObserver({
      sources,
      store: waitStore([{}]),
      forge: forgeReader(),
    });
    const [report] = (await observer?.pass(new Date())) ?? [];
    expect(report?.receipts).toHaveLength(1);
    expect(report?.error).toContain("on item 'pr-8': commit not found");
  });

  test('observes a source again only once its interval has passed', async () => {
    const configPath = await observingFixture({ acceptances: [acceptance()] });
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: async input => ({ receiptId: input.receipt.id, replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
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
      getReceipt: async () => null,
    });
    expect(replayed).toMatchObject({ receipts: [], conflicts: 0 });
    expect(replayed?.error).toBeUndefined();

    const [conflicting] = await observe({
      acceptReceipt: async () => {
        throw new SourceReceiptDigestConflictError('conflict');
      },
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
    });
    expect(conflicting).toMatchObject({ receipts: [], conflicts: 1 });
  });

  test('a host that receives no webhooks loads only the sources that observe', async () => {
    const configPath = await observingFixture({ acceptances: [] });
    const config = JSON.parse(await Bun.file(configPath).text()) as {
      sources: Record<string, unknown>[];
    };
    // A webhook-only source whose module this process could never load.
    config.sources.push({
      sourceInstanceId: 'webhook-only',
      module: '/missing/source.ts',
      config: {},
    });
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    const dependencies = {
      acceptReceipt: async () => ({ receiptId: 'unused', replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
    };
    await expect(loadWebhookSourcePlugins(configPath, dependencies)).rejects.toThrow(
      'webhook-only'
    );
    const sources = await loadWebhookSourcePlugins(configPath, dependencies, {
      observingOnly: true,
    });
    expect(sources.observing.map(source => source.sourceInstanceId)).toEqual(['source-1']);
    expect(sources.hasSource('webhook-only')).toBe(false);
  });

  test('a source without observe is never observed, and one whose plugin cannot is refused', async () => {
    const { configPath } = await fixture({ status: 'rejected', reason: 'unauthenticated' });
    const dependencies = {
      acceptReceipt: async () => ({ receiptId: 'unused', replay: false }),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
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

const LABEL_REPO = { host: 'github.com', path: 'owner/repo' };
const LABEL_READ = { bindingId: 'binding-1', repo: LABEL_REPO, label: 'factory' };

/**
 * A source with one declared label read. Each pass lists the label, reads when it was added
 * to each listed item, as the kind it was listed as (or to `asks`), and returns one
 * acceptance per item: unmatched while the read is seeding, matched otherwise. `listLabel` lists another label than declared.
 */
async function labelFixture(
  plugin: {
    listLabel?: string;
    asks?: { kind: 'issue' | 'pr'; number: number }[];
    reads?: unknown[];
    unserved?: unknown[];
    failureKind?: string;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'archon-webhook-source-'));
  roots.push(root);
  const modulePath = join(root, 'source.ts');
  const configPath = join(root, 'sources.json');
  await writeFile(
    modulePath,
    `export default ({ config }) => ({
  receive: async () => ({ status: 'rejected', reason: 'unauthenticated' }),
  observedLabels: {
    reads: config.reads ?? [config.read],
    unserved: config.unserved ?? [{ bindingId: 'pr-binding', reason: 'issues only' }],
  },
  observe: async ({ labels, forge }) => {
    const acceptances = [];
    const labelFailures = [];
    for (const read of labels) {
      let listed;
      try {
        listed = await forge.issuesWithLabel({ repo: read.repo, label: config.listLabel ?? read.label });
      } catch (error) {
        labelFailures.push({ bindingId: read.bindingId, label: read.label, reason: error.message, ...(config.failureKind ? { kind: config.failureKind } : {}) });
        continue;
      }
      const asks = config.asks ?? listed.items.map(item => ({ kind: item.kind, number: item.ref.number }));
      for (const { kind, number } of asks) {
        let added;
        try {
          added = await forge.labelAdded({ repo: read.repo, kind, number, label: read.label });
        } catch (error) {
          labelFailures.push({ bindingId: read.bindingId, label: read.label, number, reason: error.message, ...(config.failureKind ? { kind: config.failureKind } : {}) });
          continue;
        }
        if (added.added === null) {
          labelFailures.push({ bindingId: read.bindingId, label: read.label, number, reason: 'no add' });
          continue;
        }
        const deliveryId = 'observe:label:' + number + ':' + added.added.id + ':' + read.bindingId;
        const receipt = {
          id: crypto.randomUUID(),
          sourceInstanceId: 'source-1',
          deliveryId,
          contentDigest: deliveryId,
          receivedAt: '2026-01-01T00:00:00.000Z',
          occurredAt: null,
          sourceActor: null,
        };
        const binding = { ...config.binding, bindingId: read.bindingId };
        acceptances.push({
          bindingId: read.bindingId,
          label: read.label,
          acceptance:
            read.seenSince === null
              ? { receipt, outcome: 'unmatched', reason: 'seen', bindings: [] }
              : { receipt, outcome: 'matched', bindings: [binding] },
        });
      }
    }
    return { acceptances: [], labelAcceptances: acceptances, unserved: [], failed: [], labelFailures };
  },
});\n`,
    'utf8'
  );
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sources: [
        {
          sourceInstanceId: 'source-1',
          module: modulePath,
          config: { ...plugin, read: LABEL_READ, binding: acceptance().bindings[0] },
          observe: { everySeconds: 15 },
        },
      ],
    }),
    'utf8'
  );
  return configPath;
}

/**
 * A forge with open items carrying the label, each with its latest label-added event id, or
 * null while the forge records no add: issues, except the pull requests in `prs`. An item
 * in `updated` is listed with that `updatedAt`; any other is listed without one.
 */
function labelForge(
  issues: Map<number, string | null>,
  failing = new Set<number>(),
  updated = new Map<number, string>(),
  prs = new Set<number>()
) {
  const reads: string[] = [];
  return {
    ...forgeReader(),
    reads,
    issuesWithLabel: async ({ repo, label }: { repo: typeof LABEL_REPO; label: string }) => {
      reads.push(`list ${label}`);
      return {
        repo,
        label,
        items: [...issues.keys()].map(number => ({
          ref: { repo, number },
          kind: prs.has(number) ? ('pr' as const) : ('issue' as const),
          url: `https://github.com/owner/repo/issues/${String(number)}`,
          state: 'open' as const,
          ...(updated.has(number) ? { updatedAt: updated.get(number) } : {}),
        })),
      };
    },
    labelAdded: async ({
      repo,
      kind,
      number,
      label,
    }: {
      repo: typeof LABEL_REPO;
      kind: 'issue' | 'pr';
      number: number;
      label: string;
    }) => {
      reads.push(`added ${String(number)}`);
      if (failing.has(number)) throw new Error('events unavailable');
      return {
        subject: { kind, ref: { repo, number } },
        name: label,
        added:
          issues.get(number) === null
            ? null
            : { id: issues.get(number) ?? 'none', at: '2026-01-01T00:00:00Z', actor: null },
      };
    },
  };
}

/** Receipts kept by delivery id, replaying a recorded one as the store does. */
function receiptStore(knownUser: (id: string) => boolean = () => true) {
  const receipts = new Map<string, SourceReceiptAcceptance>();
  return {
    receipts,
    dependencies: {
      acceptReceipt: async (input: SourceReceiptAcceptance) => {
        const deliveryId = input.receipt.deliveryId ?? input.receipt.id;
        const replay = receipts.has(deliveryId);
        if (!replay) receipts.set(deliveryId, input);
        return { receiptId: deliveryId, replay };
      },
      isKnownUser: async (id: string) => knownUser(id),
      hasDeliveryReceipt: async (_source: string, deliveryId: string) => receipts.has(deliveryId),
      getReceipt: async (id: string) => {
        const found = [...receipts.values()].find(receipt => receipt.receipt.id === id);
        return found ? { occurredAt: found.receipt.occurredAt } : null;
      },
    },
  };
}

test('before-deadline waits are read normally, after-deadline waits are not read', async () => {
  const configPath = await observingFixture({ acceptances: [acceptance()] });
  const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt,
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();

  // Test at exactly the deadline: should be overdue
  const deadlineTime = new Date('2026-01-01T01:00:00.000Z');
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([{ deadlineAt: '2026-01-01T01:00:00.000Z' }]),
    forge,
  });
  const [report] = (await observer?.pass(deadlineTime)) ?? [];
  expect(report?.waits).toBe(0);
  expect(report?.reads).toBe(0);
  expect(forge.reads).toEqual([]);
  expect(report?.unserved).toHaveLength(1);
  expect(report?.unserved?.[0]?.reason).toContain('deadline passed at');
});

test('one overdue report per observer process across repeated passes', async () => {
  const configPath = await observingFixture({ acceptances: [acceptance()] });
  const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt,
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();

  const deadlineTime = new Date('2026-01-01T02:00:00.000Z');
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([{ deadlineAt: '2026-01-01T01:00:00.000Z' }]),
    forge,
  });

  // First pass: should report overdue
  const [report1] = (await observer?.pass(deadlineTime)) ?? [];
  expect(report1?.unserved).toHaveLength(1);
  expect(report1?.unserved?.[0]?.reason).toContain('deadline passed at');

  // Second pass: same overdue wait should not be reported again (once per process)
  const [report2] = (await observer?.pass(new Date(deadlineTime.getTime() + 60_000))) ?? [];
  expect(report2?.unserved).toHaveLength(0);
});

test('active and overdue waits mixed: only active are read', async () => {
  const configPath = await observingFixture({ acceptances: [acceptance()] });
  const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt,
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();

  const now = new Date('2026-01-01T02:00:00.000Z');
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([
      { deadlineAt: '2026-01-01T01:00:00.000Z' }, // overdue
      { deadlineAt: '2026-01-01T03:00:00.000Z' }, // active
    ]),
    forge,
  });

  const [report] = (await observer?.pass(now)) ?? [];
  expect(report?.waits).toBe(1); // only active
  expect(report?.reads).toBe(1); // only active is read
  expect(report?.unserved).toHaveLength(1); // overdue is reported
});

test('only-overdue waits with no labels perform zero plugin calls but report once', async () => {
  const configPath = await observingFixture({ acceptances: [acceptance()] });
  const acceptReceipt = mock(async () => ({ receiptId: 'unused', replay: false }));
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt,
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();

  const now = new Date('2026-01-01T02:00:00.000Z');
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([{ deadlineAt: '2026-01-01T01:00:00.000Z' }]), // only overdue
    forge,
  });

  const [report] = (await observer?.pass(now)) ?? [];
  expect(report?.waits).toBe(0);
  expect(report?.reads).toBe(0);
  expect(report?.unserved).toHaveLength(1);
  expect(acceptReceipt).not.toHaveBeenCalled();
});

const waited = {
  workflowName: 'host',
  event: 'checks',
  about: REVISION,
  itemKey: 'pr-7',
};

async function backedOff(kind: string, failOnce = false) {
  const configPath = await observingFixture(
    {
      acceptances: [acceptance()],
      failed: [{ wait: waited, reason: 'slow down', kind }],
      ...(failOnce ? { failOnce: true } : {}),
    },
    { everySeconds: 15 }
  );
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt: mock(async () => ({ receiptId: 'receipt-1', replay: false })),
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([{ deadlineAt: '2026-12-31T23:59:59.000Z' }]),
    forge,
  });
  return { forge, observer };
}

test.each(['rate_limited', 'unavailable'])(
  'a %s read pauses the source, and a later clean pass resumes',
  async kind => {
    const { forge, observer } = await backedOff(kind, true);
    const start = Date.parse('2026-06-01T00:00:00.000Z');
    const [first] = (await observer?.pass(new Date(start))) ?? [];
    expect(forge.reads).toHaveLength(1);
    expect(first?.receipts).toEqual(['receipt-1']);
    expect(first?.error).toContain('slow down');

    await observer?.pass(new Date(start + 15_000));
    expect(forge.reads).toHaveLength(1);

    await observer?.pass(new Date(start + 60_000));
    expect(forge.reads).toHaveLength(2);

    await observer?.pass(new Date(start + 75_000));
    expect(forge.reads).toHaveLength(3);
  }
);

test('repeated temporary failures wait longer, once per pass', async () => {
  const { forge, observer } = await backedOff('rate_limited');
  const start = Date.parse('2026-06-01T00:00:00.000Z');
  await observer?.pass(new Date(start));
  await observer?.pass(new Date(start + 15_000));
  expect(forge.reads).toHaveLength(1);
  await observer?.pass(new Date(start + 60_000));
  await observer?.pass(new Date(start + 120_000));
  expect(forge.reads).toHaveLength(2);
  await observer?.pass(new Date(start + 180_000));
  expect(forge.reads).toHaveLength(3);
});

test.each(['not_found', 'unspecified'] as const)(
  'a %s failure does not pause the source',
  async label => {
    const kind = label === 'unspecified' ? undefined : label;
    const configPath = await observingFixture(
      {
        acceptances: [acceptance()],
        failed: [{ wait: waited, reason: 'missing', ...(kind === undefined ? {} : { kind }) }],
      },
      { everySeconds: 15 }
    );
    const sources = await loadWebhookSourcePlugins(configPath, {
      acceptReceipt: mock(async () => ({ receiptId: 'receipt-1', replay: false })),
      isKnownUser: async () => true,
      hasDeliveryReceipt: async () => false,
      getReceipt: async () => null,
    });
    const forge = forgeReader();
    const observer = createItemWaitObserver({
      sources,
      store: waitStore([{ deadlineAt: '2026-12-31T23:59:59.000Z' }]),
      forge,
    });
    const start = Date.parse('2026-06-01T00:00:00.000Z');
    await observer?.pass(new Date(start));
    await observer?.pass(new Date(start + 15_000));
    expect(forge.reads).toHaveLength(2);
  }
);

test('an admission error does not pause the source', async () => {
  const configPath = await observingFixture({ acceptances: [acceptance()] }, { everySeconds: 15 });
  const sources = await loadWebhookSourcePlugins(configPath, {
    acceptReceipt: mock(async () => {
      throw new Error('store down');
    }),
    isKnownUser: async () => true,
    hasDeliveryReceipt: async () => false,
    getReceipt: async () => null,
  });
  const forge = forgeReader();
  const observer = createItemWaitObserver({
    sources,
    store: waitStore([{ deadlineAt: '2026-12-31T23:59:59.000Z' }]),
    forge,
  });
  const start = Date.parse('2026-06-01T00:00:00.000Z');
  const [first] = (await observer?.pass(new Date(start))) ?? [];
  expect(first?.error).toContain('store down');
  await observer?.pass(new Date(start + 15_000));
  expect(forge.reads).toHaveLength(2);
});

describe('observing label bindings', () => {
  const MARKER = 'observe:label-seen:binding-1:github.com/owner/repo:factory';

  test('a label already on an issue starts nothing; a later add starts once, and a re-add again', async () => {
    const configPath = await labelFixture();
    const store = receiptStore();
    const sources = await loadWebhookSourcePlugins(configPath, store.dependencies);
    const issues = new Map([[5, 'event-1']]);
    const forge = labelForge(issues);
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    const matched = () =>
      [...store.receipts.values()].filter(receipt => receipt.outcome === 'matched').length;
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const pass = async () => {
      const reports = (await observer?.pass(new Date(now))) ?? [];
      now += 15_000;
      return reports;
    };

    // No wait is open, yet the declared read is observed, and first seen.
    const [first] = await pass();
    expect(first).toMatchObject({
      waits: 0,
      labels: 1,
      reads: 2,
      unservedBindings: [{ bindingId: 'pr-binding', reason: 'issues only' }],
    });
    expect(first?.error).toBeUndefined();
    expect(store.receipts.has(MARKER)).toBe(true);
    expect(matched()).toBe(0);

    // A second issue labelled after the first pass starts.
    issues.set(6, 'event-2');
    const [second] = await pass();
    expect(second?.receipts).toEqual(['observe:label:6:event-2:binding-1']);
    expect(matched()).toBe(1);

    // The same label state is a replay, which the report names apart from new receipts.
    expect((await pass())[0]).toMatchObject({
      receipts: [],
      replayed: ['observe:label:5:event-1:binding-1', 'observe:label:6:event-2:binding-1'],
    });

    // Removed and added again: the forge's new event is a new delivery.
    issues.set(6, 'event-3');
    expect((await pass())[0]?.receipts).toEqual(['observe:label:6:event-3:binding-1']);
    expect(matched()).toBe(2);
  });

  test('the forge lists only a declared label, and reads only items that list returned, by kind', async () => {
    const observeWith = async (plugin: Parameters<typeof labelFixture>[0]) => {
      const sources = await loadWebhookSourcePlugins(
        await labelFixture(plugin),
        receiptStore().dependencies
      );
      const listed = new Map([
        [5, 'event-1'],
        [7, 'event-2'],
      ]);
      const forge = labelForge(listed, new Set(), new Map(), new Set([7]));
      const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
      const [report] = (await observer?.pass(new Date())) ?? [];
      return { report, reads: forge.reads };
    };
    const undeclared = await observeWith({ listLabel: 'other' });
    expect(undeclared.reads).toEqual([]);
    expect(undeclared.report?.error).toContain(
      "No binding of this source names label 'other' in 'github.com/owner/repo'"
    );

    // Issue 5 and pull request 7 are listed; a number not listed, or asked as the other
    // kind, is refused.
    const listed = await observeWith({});
    expect(listed.reads).toEqual(['list factory', 'added 5', 'added 7']);
    expect(listed.report?.error).toBeUndefined();
    const unlisted = await observeWith({
      asks: [
        { kind: 'issue', number: 5 },
        { kind: 'pr', number: 7 },
        { kind: 'issue', number: 9 },
        { kind: 'pr', number: 5 },
        { kind: 'issue', number: 7 },
      ],
    });
    expect(unlisted.reads).toEqual(['list factory', 'added 5', 'added 7']);
    for (const refused of ['Issue 9 of', 'Pull request 5 of', 'Issue 7 of'])
      expect(unlisted.report?.error).toContain(
        `${refused} 'github.com/owner/repo' was not listed with label 'factory' in this pass`
      );
  });

  test('one read whose acceptance cannot be admitted does not hold back another read', async () => {
    let userKnown = true;
    const store = receiptStore(() => userKnown);
    const issues = new Map([[5, 'event-1']]);
    const observe = async (reads: unknown[]) => {
      const sources = await loadWebhookSourcePlugins(
        await labelFixture({ reads }),
        store.dependencies
      );
      return (
        (await createItemWaitObserver({
          sources,
          store: waitStore([]),
          forge: labelForge(issues),
        })?.pass(new Date())) ?? []
      );
    };
    // binding-1 is seen first; then its run-as user is removed and binding-2 is added.
    await observe([LABEL_READ]);
    expect(store.receipts.has(MARKER)).toBe(true);
    userKnown = false;
    issues.set(5, 'event-2');
    const otherRead = { bindingId: 'binding-2', repo: LABEL_REPO, label: 'urgent' };
    const [report] = await observe([LABEL_READ, otherRead]);
    // binding-1's new start cannot be admitted, yet binding-2 is still seen.
    expect(report?.error).toContain('unknown run-as user');
    expect(store.receipts.has('observe:label-seen:binding-2:github.com/owner/repo:urgent')).toBe(
      true
    );
  });

  test('a pass reads only the issues whose updatedAt changed since the last pass', async () => {
    const store = receiptStore();
    const sources = await loadWebhookSourcePlugins(await labelFixture(), store.dependencies);
    const issues = new Map([
      [5, 'event-1'],
      [6, 'event-2'],
      [7, 'event-3'],
    ]);
    const updated = new Map([
      [5, '2026-01-01T00:00:01Z'],
      [6, '2026-01-01T00:00:02Z'],
      [7, '2026-01-01T00:00:03Z'],
    ]);
    const forge = labelForge(issues, new Set(), updated);
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const pass = async () => {
      forge.reads.length = 0;
      const [report] = (await observer?.pass(new Date(now))) ?? [];
      now += 15_000;
      return { report, reads: [...forge.reads] };
    };

    expect((await pass()).reads).toEqual(['list factory', 'added 5', 'added 6', 'added 7']);

    // Nothing changed: only the list is read.
    const unchanged = await pass();
    expect(unchanged.reads).toEqual(['list factory']);
    expect(unchanged.report).toMatchObject({ reads: 1, receipts: [] });

    // Issue 6 is relabelled and issue 8 labelled while the host sleeps for an hour.
    issues.set(6, 'event-4');
    updated.set(6, '2026-01-01T00:30:00Z');
    issues.set(8, 'event-5');
    updated.set(8, '2026-01-01T00:40:00Z');
    now += 3_600_000;
    const woke = await pass();
    expect(woke.reads).toEqual(['list factory', 'added 6', 'added 8']);
    expect(woke.report?.receipts).toEqual([
      'observe:label:6:event-4:binding-1',
      'observe:label:8:event-5:binding-1',
    ]);
    expect(await pass()).toMatchObject({ reads: ['list factory'], report: { receipts: [] } });
  });

  test('an add the forge did not yet record is read again, and starts once it is', async () => {
    const sources = await loadWebhookSourcePlugins(
      await labelFixture(),
      receiptStore().dependencies
    );
    const issues = new Map<number, string | null>();
    const updated = new Map([[6, '2026-01-01T00:00:10Z']]);
    const forge = labelForge(issues, new Set(), updated);
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await observer?.pass(new Date(start));

    // The list shows issue 6's label before its event is readable.
    issues.set(6, null);
    const [missing] = (await observer?.pass(new Date(start + 15_000))) ?? [];
    expect(missing?.error).toContain('on issue 6: no add');

    // The issue is unchanged, but the event is readable now.
    issues.set(6, 'event-1');
    forge.reads.length = 0;
    const [found] = (await observer?.pass(new Date(start + 30_000))) ?? [];
    expect(forge.reads).toEqual(['list factory', 'added 6']);
    expect(found?.receipts).toEqual(['observe:label:6:event-1:binding-1']);
  });

  test('an issue listed without updatedAt is read on every pass', async () => {
    const sources = await loadWebhookSourcePlugins(
      await labelFixture(),
      receiptStore().dependencies
    );
    const forge = labelForge(new Map([[5, 'event-1']]));
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await observer?.pass(new Date(start));
    await observer?.pass(new Date(start + 15_000));
    expect(forge.reads).toEqual(['list factory', 'added 5', 'list factory', 'added 5']);
  });

  test('a remembered add whose admission failed starts on the next unchanged pass', async () => {
    let userKnown = true;
    const store = receiptStore(() => userKnown);
    const sources = await loadWebhookSourcePlugins(await labelFixture(), store.dependencies);
    const issues = new Map([[5, 'event-1']]);
    const updated = new Map([[5, '2026-01-01T00:00:01Z']]);
    const forge = labelForge(issues, new Set(), updated);
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    await observer?.pass(new Date(start));

    issues.set(6, 'event-2');
    updated.set(6, '2026-01-01T00:00:10Z');
    userKnown = false;
    const [failed] = (await observer?.pass(new Date(start + 15_000))) ?? [];
    expect(failed?.error).toContain('unknown run-as user');

    userKnown = true;
    forge.reads.length = 0;
    const [retried] = (await observer?.pass(new Date(start + 30_000))) ?? [];
    expect(forge.reads).toEqual(['list factory']);
    expect(retried?.receipts).toEqual(['observe:label:6:event-2:binding-1']);
  });

  test('a restarted observer reads each issue once, and an add already recorded starts nothing', async () => {
    const store = receiptStore();
    const issues = new Map([[5, 'event-1']]);
    const updated = new Map([[5, '2026-01-01T00:00:01Z']]);
    const observer = async () =>
      createItemWaitObserver({
        sources: await loadWebhookSourcePlugins(await labelFixture(), store.dependencies),
        store: waitStore([]),
        forge,
      });
    const forge = labelForge(issues, new Set(), updated);
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const first = await observer();
    await first?.pass(new Date(start));
    issues.set(6, 'event-2');
    updated.set(6, '2026-01-01T00:00:10Z');
    expect((await first?.pass(new Date(start + 15_000)))?.[0]?.receipts).toEqual([
      'observe:label:6:event-2:binding-1',
    ]);

    forge.reads.length = 0;
    const [restarted] = (await (await observer())?.pass(new Date(start + 30_000))) ?? [];
    expect(forge.reads).toEqual(['list factory', 'added 5', 'added 6']);
    expect(restarted?.receipts).toEqual([]);
  });

  test('a source with only label bindings it cannot observe is reported, and reads nothing', async () => {
    const configPath = await labelFixture({ reads: [] });
    const sources = await loadWebhookSourcePlugins(configPath, receiptStore().dependencies);
    const forge = labelForge(new Map([[5, 'event-1']]));
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    expect(await observer?.pass(new Date())).toEqual([
      {
        source: 'source-1',
        waits: 0,
        labels: 0,
        reads: 0,
        receipts: [],
        replayed: [],
        conflicts: 0,
        unserved: [],
        unservedBindings: [{ bindingId: 'pr-binding', reason: 'issues only' }],
      },
    ]);
    expect(forge.reads).toEqual([]);
  });

  test('a rate_limited label read pauses the source', async () => {
    const configPath = await labelFixture({ failureKind: 'rate_limited' });
    const sources = await loadWebhookSourcePlugins(configPath, receiptStore().dependencies);
    const forge = labelForge(new Map([[5, 'event-1']]), new Set([5]));
    const observer = createItemWaitObserver({ sources, store: waitStore([]), forge });
    const start = Date.parse('2026-06-01T00:00:00.000Z');
    const [first] = (await observer?.pass(new Date(start))) ?? [];
    expect(first?.error).toContain('events unavailable');
    const reads = forge.reads.length;
    expect(reads).toBeGreaterThan(0);
    await observer?.pass(new Date(start + 15_000));
    expect(forge.reads).toHaveLength(reads);
  });
});
