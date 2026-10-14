import { describe, expect, test } from 'bun:test';
import {
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StatePatchError,
  stateValueSchema,
  statePutSchema,
  stateWriterSchema,
  stateScopeSchema,
  stateDocumentSummarySchema,
  type IStateDocumentStore,
  type StateScope,
  type StateWriter,
} from './state-document-store';

const writer: StateWriter = { kind: 'surface', via: 'cli' };
const p = (name: string): StateScope => ({ kind: 'project', key: `conformance/${name}` });
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
      store.putStateDocument({ scope: p('race'), name: 'put', value, ifRevision: 0, writer })
    )
  );
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of results)
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(StateRevisionConflictError);
  expect(await store.listStateRevisions(p('race'), 'put')).toHaveLength(1);
}
export async function assertStatePatchRace(
  store: Pick<IStateDocumentStore, 'patchStateDocument' | 'listStateRevisions'>
): Promise<void> {
  await Promise.all(
    Array.from({ length: 8 }, (_, value) =>
      store.patchStateDocument({
        scope: p('race'),
        name: 'patch',
        ops: [{ op: 'append', path: '/seen', value }],
        writer,
      })
    )
  );
  const revisions = await store.listStateRevisions(p('race'), 'patch');
  expect(revisions.map(row => row.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  expect(revisions[0]?.value).toEqual({ seen: expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]) });
  const value = revisions[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing ledger');
  expect(value.seen).toHaveLength(8);
}
export interface StateDocumentHarness {
  store: IStateDocumentStore;
  backdate(scope: StateScope, name: string): Promise<void>;
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
        const before = await store.listStateRevisions(p('race'), 'patch');
        await store.patchStateDocument({
          scope: p('race'),
          name: 'patch',
          ops: [{ op: 'append', path: '/seen', value: 9 }],
          writer,
        });
        expect((await store.listStateRevisions(p('race'), 'patch')).slice(1)).toEqual(before);
      }
    );
    check('put has exactly one winner', async ({ store }) => assertStatePutRace(store));
    check('a patch that names a stale revision conflicts and writes nothing', async ({ store }) => {
      const input = { scope: p('cas'), name: 'patch', writer };
      await store.putStateDocument({ ...input, value: { owner: 'a' }, ifRevision: 0 });
      await store.patchStateDocument({
        ...input,
        ops: [{ op: 'set', path: '/owner', value: 'b' }],
      });
      expect(
        await rejection(
          store.patchStateDocument({
            ...input,
            ifRevision: 1,
            ops: [{ op: 'set', path: '/owner', value: 'c' }],
          })
        )
      ).toBeInstanceOf(StateRevisionConflictError);
      expect((await store.getStateDocument(p('cas'), 'patch'))?.value).toEqual({ owner: 'b' });
      expect(await store.listStateRevisions(p('cas'), 'patch')).toHaveLength(2);
    });
    check('a patch records the revision it named, and only then', async ({ store }) => {
      const input = { scope: p('cas'), name: 'basis', writer };
      const ops = [{ op: 'set' as const, path: '/v', value: 1 }];
      await store.patchStateDocument({ ...input, ifRevision: 0, ops });
      await store.patchStateDocument({ ...input, ops });
      expect((await store.listStateRevisions(p('cas'), 'basis')).map(row => row.operation)).toEqual(
        [
          { op: 'patch', ops },
          { op: 'patch', ops, ifRevision: 0 },
        ]
      );
    });
    check('install scope and each project hold separate documents', async ({ store }) => {
      const install: StateScope = { kind: 'install' };
      const input = { name: 'shared', writer, ifRevision: 0 };
      await store.putStateDocument({ ...input, scope: install, value: 'install' });
      await store.putStateDocument({ ...input, scope: p('one'), value: 'project' });
      expect((await store.getStateDocument(install, 'shared'))?.value).toBe('install');
      expect((await store.getStateDocument(p('one'), 'shared'))?.value).toBe('project');
      expect(await store.listStateRevisions(install, 'shared')).toHaveLength(1);
      expect(stateScopeSchema.safeParse({ kind: 'project', key: '_install' }).success).toBe(false);
    });
    check('listing returns names and latest revisions, never values', async ({ store }) => {
      const scope = p('list');
      for (const name of ['b_x/1', 'a/2', 'b_x/3', 'bax/4'])
        await store.putStateDocument({
          scope,
          name,
          value: { secret: name },
          ifRevision: 0,
          writer,
        });
      await store.patchStateDocument({
        scope,
        name: 'a/2',
        ops: [{ op: 'set', path: '/v', value: 1 }],
        writer,
      });
      await store.deleteStateDocument({ scope, name: 'bax/4', writer });
      const all = await store.listStateDocuments(scope);
      expect(all.map(row => [row.name, row.revision, row.deleted])).toEqual([
        ['a/2', 2, false],
        ['b_x/1', 1, false],
        ['b_x/3', 1, false],
        ['bax/4', 2, true],
      ]);
      for (const row of all) {
        expect(stateDocumentSummarySchema.strict().parse(row)).toEqual(row);
        expect(row.writer).toEqual(writer);
      }
      // `_` is a literal prefix character, not a wildcard.
      expect(
        (await store.listStateDocuments(scope, { prefix: 'b_' })).map(row => row.name)
      ).toEqual(['b_x/1', 'b_x/3']);
      expect(await store.listStateDocuments(p('empty'))).toEqual([]);
    });
    check('writers, project isolation, tombstones and recreation', async ({ store }) => {
      const input = { scope: p('one'), name: 'ledger', value: { seen: [] }, ifRevision: 0, writer };
      const first = await store.putStateDocument(input);
      expect(first.writer).toEqual(writer);
      expect(first.operation).toEqual({ op: 'put' });
      expect(await rejection(store.putStateDocument(input))).toBeInstanceOf(
        StateRevisionConflictError
      );
      await store.putStateDocument({ ...input, scope: p('two'), value: 123 });
      const runWriter: StateWriter = { kind: 'run', runId: 'run', nodePath: 'loop/commit' };
      const deleted = await store.deleteStateDocument({
        ...input,
        ifRevision: 1,
        writer: runWriter,
      });
      expect(deleted.revision).toBe(2);
      expect(await store.getStateDocument(p('one'), 'ledger')).toBeNull();
      expect((await store.listStateRevisions(p('one'), 'ledger'))[0]).toMatchObject({
        value: null,
        operation: { op: 'delete' },
        writer: runWriter,
      });
      expect((await store.getStateDocument(p('two'), 'ledger'))?.value).toBe(123);
      await store.putStateDocument({ ...input, ifRevision: 2 });
      expect((await store.getStateDocument(p('one'), 'ledger'))?.revision).toBe(3);
      expect(await store.listStateRevisions(p('one'), 'ledger', { limit: 1 })).toHaveLength(1);
    });
    check('every schema-defined writer field round-trips', async ({ store }) => {
      for (const variant of stateWriterSchema.options) {
        const supplied = Object.fromEntries(
          Object.keys(variant.shape).map(field => [
            field,
            field === 'kind' ? variant.shape.kind.value : `writer-${field}`,
          ])
        );
        const writer = stateWriterSchema.parse(supplied);
        const input = { scope: p('writers'), name: writer.kind, writer };
        await store.putStateDocument({ ...input, value: {}, ifRevision: 0 });
        expect((await store.getStateDocument(input.scope, input.name))?.writer).toEqual(writer);
        expect((await store.listStateRevisions(input.scope, input.name))[0]?.writer).toEqual(
          writer
        );
      }
    });
    check(
      'JSON members survive reads, patch values and subsequent unrelated patches',
      async ({ store }) => {
        const supplied: unknown = JSON.parse(
          '{"__proto__":{"own":true},"nested":{"__proto__":null},"array":[{"__proto__":[1]}]}'
        );
        const value = stateValueSchema.parse(supplied);
        expect(supplied).toEqual(value);
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Expected JSON object');
        const input = { scope: p('json'), name: 'members', writer };
        await store.putStateDocument({ ...input, value, ifRevision: 0 });
        expect((await store.getStateDocument(input.scope, input.name))?.value).toEqual(value);
        const ops = [{ op: 'set' as const, path: '/added', value }];
        await store.patchStateDocument({ ...input, ops });
        const expected = { ...value, added: value };
        expect((await store.getStateDocument(input.scope, input.name))?.value).toEqual(expected);
        const history = await store.listStateRevisions(input.scope, input.name);
        expect(history[0]?.operation).toEqual({ op: 'patch', ops });
        expect(history[1]?.value).toEqual(value);
        await store.patchStateDocument({
          ...input,
          ops: [{ op: 'set', path: '/other', value: true }],
        });
        expect((await store.getStateDocument(input.scope, input.name))?.value).toEqual({
          ...expected,
          other: true,
        });
      }
    );
    check('audit history is complete unless the caller requests a limit', async ({ store }) => {
      for (let revision = 0; revision < 101; revision++) {
        await store.putStateDocument({
          scope: p('audit'),
          name: 'ledger',
          value: revision,
          ifRevision: revision,
          writer,
        });
      }
      expect(await store.listStateRevisions(p('audit'), 'ledger')).toHaveLength(101);
      expect(
        (await store.listStateRevisions(p('audit'), 'ledger', { limit: 1 }))[0]?.revision
      ).toBe(101);
    });
    check('cleanup never reuses a revision that a stale writer can still hold', async harness => {
      const { store } = harness;
      const input = { scope: p('aba'), name: 'ledger', writer };
      await store.putStateDocument({ ...input, value: 'old', ifRevision: 0 });
      await store.deleteStateDocument(input);
      await harness.backdate(input.scope, input.name);
      await store.pruneStateRevisions(30);
      const head = (await store.listStateRevisions(input.scope, input.name))[0];
      const recreated = await store.putStateDocument({
        ...input,
        value: 'new',
        ifRevision: head?.revision ?? 0,
      });
      expect(
        await rejection(store.putStateDocument({ ...input, value: 'stale', ifRevision: 1 }))
      ).toBeInstanceOf(StateRevisionConflictError);
      expect(recreated.revision).toBe(3);
      expect((await store.getStateDocument(input.scope, input.name))?.value).toBe('new');
    });
    check('over-cap values and invalid patches write nothing', async ({ store }) => {
      const input = { scope: p('one'), name: 'limit', writer };
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
      const oversized = statePutSchema.shape.value.parse(
        JSON.parse(`{"__proto__":"${'x'.repeat(65536)}"}`) as unknown
      );
      expect(
        await rejection(store.putStateDocument({ ...input, value: oversized, ifRevision: 0 }))
      ).toBeInstanceOf(StateDocumentTooLargeError);
      expect(
        await rejection(
          store.patchStateDocument({
            ...input,
            ops: [{ op: 'append', path: '/values', value: oversized }],
          })
        )
      ).toBeInstanceOf(StateDocumentTooLargeError);
      expect(await store.listStateRevisions(p('one'), 'limit')).toEqual([]);
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
      expect((await store.getStateDocument(p('one'), 'limit'))?.value).toEqual({ target: 2 });
      expect(await store.listStateRevisions(p('one'), 'limit')).toHaveLength(1);
    });
    check('retention preserves every latest revision, including tombstones', async harness => {
      const { store } = harness;
      for (const name of ['live', 'deleted']) {
        await store.putStateDocument({ scope: p('one'), name, value: {}, ifRevision: 0, writer });
        await store.patchStateDocument({
          scope: p('one'),
          name,
          ops: [{ op: 'set', path: '/v', value: 1 }],
          writer,
        });
      }
      await store.deleteStateDocument({ scope: p('one'), name: 'deleted', writer });
      await harness.backdate(p('one'), 'live');
      await harness.backdate(p('one'), 'deleted');
      expect(await store.pruneStateRevisions(30)).toEqual({ count: 3 });
      expect((await store.getStateDocument(p('one'), 'live'))?.revision).toBe(2);
      expect(await store.listStateRevisions(p('one'), 'live')).toHaveLength(1);
      expect(await store.listStateRevisions(p('one'), 'deleted')).toMatchObject([
        { revision: 3, value: null },
      ]);
      expect(await store.getStateDocument(p('one'), 'deleted')).toBeNull();
    });
  });
}
