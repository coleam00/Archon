import { describe, expect, test } from 'bun:test';
import {
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StatePatchError,
  type IStateDocumentStore,
  type StateWriter,
} from './state-document-store';

const writer: StateWriter = { kind: 'operator', identity: 'conformance' };
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the state write to reject');
}
export async function assertStatePutRace(
  store: Pick<IStateDocumentStore, 'putStateDocument' | 'listStateRevisions'>
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, value) =>
      store.putStateDocument({ project: 'race', name: 'put', value, ifRevision: 0, writer })
    )
  );
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of results)
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(StateRevisionConflictError);
  expect(await store.listStateRevisions('race', 'put')).toHaveLength(1);
}
export async function assertStatePatchRace(
  store: Pick<IStateDocumentStore, 'patchStateDocument' | 'listStateRevisions'>
): Promise<void> {
  await Promise.all(
    Array.from({ length: 8 }, (_, value) =>
      store.patchStateDocument({
        project: 'race',
        name: 'patch',
        ops: [{ op: 'append', path: '/seen', value }],
        writer,
      })
    )
  );
  const revisions = await store.listStateRevisions('race', 'patch');
  expect(revisions.map(row => row.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  expect(revisions[0]?.value).toEqual({ seen: expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]) });
  const value = revisions[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing ledger');
  expect(value.seen).toHaveLength(8);
}
export interface StateDocumentHarness {
  store: IStateDocumentStore;
  backdate(project: string, name: string): Promise<void>;
  close(): Promise<void>;
}
export function describeStateDocumentConformance(
  label: string,
  makeHarness: () => Promise<StateDocumentHarness>
): void {
  const check = (name: string, run: (harness: StateDocumentHarness) => Promise<void>): void => {
    test(name, async () => {
      const harness = await makeHarness();
      try {
        await run(harness);
      } finally {
        await harness.close();
      }
    });
  };
  describe(`state documents: ${label}`, () => {
    check(
      'eight appenders preserve every value and contiguous immutable revisions',
      async ({ store }) => {
        await assertStatePatchRace(store);
        const before = await store.listStateRevisions('race', 'patch');
        await store.patchStateDocument({
          project: 'race',
          name: 'patch',
          ops: [{ op: 'append', path: '/seen', value: 9 }],
          writer,
        });
        expect((await store.listStateRevisions('race', 'patch')).slice(1)).toEqual(before);
      }
    );
    check('put has exactly one winner', async ({ store }) => assertStatePutRace(store));
    check('writers, project isolation, tombstones and recreation', async ({ store }) => {
      const input = { project: 'one', name: 'ledger', value: { seen: [] }, ifRevision: 0, writer };
      const first = await store.putStateDocument(input);
      expect(first.writer).toEqual(writer);
      expect(first.operation).toEqual({ op: 'put' });
      expect(await rejection(store.putStateDocument(input))).toBeInstanceOf(
        StateRevisionConflictError
      );
      await store.putStateDocument({ ...input, project: 'two', value: 123 });
      const runWriter: StateWriter = { kind: 'run', runId: 'run', nodePath: 'loop/commit' };
      const deleted = await store.deleteStateDocument({
        ...input,
        ifRevision: 1,
        writer: runWriter,
      });
      expect(deleted.revision).toBe(2);
      expect(await store.getStateDocument('one', 'ledger')).toBeNull();
      expect((await store.listStateRevisions('one', 'ledger'))[0]).toMatchObject({
        value: null,
        operation: { op: 'delete' },
        writer: runWriter,
      });
      expect((await store.getStateDocument('two', 'ledger'))?.value).toBe(123);
      await store.putStateDocument({ ...input, ifRevision: 2 });
      expect((await store.getStateDocument('one', 'ledger'))?.revision).toBe(3);
      expect(await store.listStateRevisions('one', 'ledger', { limit: 1 })).toHaveLength(1);
    });
    check('audit history is complete unless the caller requests a limit', async ({ store }) => {
      for (let revision = 0; revision < 101; revision++) {
        await store.putStateDocument({
          project: 'audit',
          name: 'ledger',
          value: revision,
          ifRevision: revision,
          writer,
        });
      }
      expect(await store.listStateRevisions('audit', 'ledger')).toHaveLength(101);
      expect((await store.listStateRevisions('audit', 'ledger', { limit: 1 }))[0]?.revision).toBe(
        101
      );
    });
    check('cleanup never reuses a revision that a stale writer can still hold', async harness => {
      const { store } = harness;
      const input = { project: 'aba', name: 'ledger', writer };
      await store.putStateDocument({ ...input, value: 'old', ifRevision: 0 });
      await store.deleteStateDocument(input);
      await harness.backdate(input.project, input.name);
      await store.pruneStateRevisions(30);
      const head = (await store.listStateRevisions(input.project, input.name))[0];
      const recreated = await store.putStateDocument({
        ...input,
        value: 'new',
        ifRevision: head?.revision ?? 0,
      });
      expect(
        await rejection(store.putStateDocument({ ...input, value: 'stale', ifRevision: 1 }))
      ).toBeInstanceOf(StateRevisionConflictError);
      expect(recreated.revision).toBe(3);
      expect((await store.getStateDocument(input.project, input.name))?.value).toBe('new');
    });
    check('over-cap values and invalid patches write nothing', async ({ store }) => {
      const input = { project: 'one', name: 'limit', writer };
      expect(
        await rejection(
          store.putStateDocument({ ...input, value: 'é'.repeat(32768), ifRevision: 0 })
        )
      ).toBeInstanceOf(StateDocumentTooLargeError);
      expect(
        await rejection(
          store.patchStateDocument({
            ...input,
            ops: [{ op: 'set', path: '/large', value: 'x'.repeat(65536) }],
          })
        )
      ).toBeInstanceOf(StateDocumentTooLargeError);
      expect(
        await rejection(
          store.patchStateDocument({ ...input, ops: [{ op: 'set', path: 'invalid', value: 1 }] })
        )
      ).toBeInstanceOf(StatePatchError);
      expect(await store.listStateRevisions('one', 'limit')).toEqual([]);
      await store.putStateDocument({ ...input, value: { target: 2 }, ifRevision: 0 });
      expect(
        await rejection(
          store.patchStateDocument({
            ...input,
            ops: [
              { op: 'set', path: '/extra', value: true },
              { op: 'append', path: '/target', value: 3 },
            ],
          })
        )
      ).toMatchObject({ opIndex: 1 });
      expect(
        await rejection(
          store.patchStateDocument({ ...input, ops: [{ op: 'append', path: '/target', value: 3 }] })
        )
      ).toBeInstanceOf(StatePatchError);
      expect((await store.getStateDocument('one', 'limit'))?.value).toEqual({ target: 2 });
      expect(await store.listStateRevisions('one', 'limit')).toHaveLength(1);
    });
    check('retention preserves every latest revision, including tombstones', async harness => {
      const { store } = harness;
      for (const name of ['live', 'deleted']) {
        await store.putStateDocument({ project: 'one', name, value: {}, ifRevision: 0, writer });
        await store.patchStateDocument({
          project: 'one',
          name,
          ops: [{ op: 'set', path: '/v', value: 1 }],
          writer,
        });
      }
      await store.deleteStateDocument({ project: 'one', name: 'deleted', writer });
      await harness.backdate('one', 'live');
      await harness.backdate('one', 'deleted');
      expect(await store.pruneStateRevisions(30)).toEqual({ count: 3 });
      expect((await store.getStateDocument('one', 'live'))?.revision).toBe(2);
      expect(await store.listStateRevisions('one', 'live')).toHaveLength(1);
      expect(await store.listStateRevisions('one', 'deleted')).toMatchObject([
        { revision: 3, value: null },
      ]);
      expect(await store.getStateDocument('one', 'deleted')).toBeNull();
    });
  });
}
