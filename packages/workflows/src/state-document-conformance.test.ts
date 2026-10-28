// @archon-test-isolated
import { expect, test } from 'bun:test';
import { assertStatePutRace, assertStatePatchRace } from './state-document-conformance';
import { applyStatePatch, type StateRevision } from './state-document-store';

test('the single-winner contract rejects a read-then-write store', async () => {
  const history: StateRevision[] = [];
  await expect(
    assertStatePutRace({
      putStateDocument: async input => {
        const revision = history.length + 1;
        await Promise.resolve();
        const next: StateRevision = {
          name: input.name,
          revision,
          value: input.value,
          operation: { op: 'put' },
          writer: input.writer,
          createdAt: new Date().toISOString(),
        };
        history.push(next);
        return next;
      },
      listStateRevisions: async () => [...history].reverse(),
    })
  ).rejects.toThrow();
  expect(history).toHaveLength(8);
});

test('the append contract rejects lost updates from a read-then-write store', async () => {
  const history: StateRevision[] = [];
  await expect(
    assertStatePatchRace({
      patchStateDocument: async input => {
        const prior = history.at(-1);
        const value = applyStatePatch(prior?.value ?? {}, input.ops, input.name);
        await Promise.resolve();
        const next: StateRevision = {
          name: input.name,
          revision: (prior?.revision ?? 0) + 1,
          value,
          operation: { op: 'patch', ops: input.ops },
          writer: input.writer,
          createdAt: new Date().toISOString(),
        };
        history.push(next);
        return next;
      },
      listStateRevisions: async () => [...history].reverse(),
    })
  ).rejects.toThrow();
  expect(history.map(row => row.revision)).toEqual(Array(8).fill(1));
});
