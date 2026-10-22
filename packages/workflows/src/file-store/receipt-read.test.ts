import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZodError } from 'zod';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
import { pathFor } from './admission-documents';
import * as commitModule from './commit';

const roots = trackTempRoots();

test.each(['json', 'schema', 'unreadable'] as const)(
  'receipt lists remain strict and preserve %s evidence without writes',
  async damage => {
    const root = roots(await mkdtemp(join(tmpdir(), 'receipt-read-')));
    const store = await createFileWorkflowStore({ root });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of ids.entries()) {
      await store.acceptStartReceipt({
        receipt: {
          id,
          sourceInstanceId: 'source',
          deliveryId: null,
          contentDigest: 'digest',
          receivedAt: new Date().toISOString(),
          occurredAt: null,
          sourceActor: null,
        },
        outcome: 'matched',
        bindings: [
          {
            bindingId: 'binding',
            bindingRevision: null,
            hostId: index === 0 ? 'host' : 'other',
            runAsUserId: 'operator',
            resource: 'resource',
            capacity: 1,
            overlap: 'queue',
            launch: {
              cwd: '/test',
              workflowName: 'test',
              inputs: {},
              isolation: { kind: 'in-place' },
            },
          },
        ],
      });
    }
    expect(await store.listPendingStartBindings({ hostId: 'host' })).toMatchObject([
      { receiptId: ids[0] },
    ]);
    expect(await store.listStartReceipts()).toHaveLength(2);
    const relative = pathFor('receipts', ids[1]!);
    const path = join(root, relative);
    if (damage === 'json') await writeFile(path, '{');
    if (damage === 'schema') {
      const row = JSON.parse(await readFile(path, 'utf8'));
      row.bindings = [{}];
      await writeFile(path, JSON.stringify(row));
    }
    const tracked = ['head.json', ...ids.map(id => pathFor('receipts', id))];
    const before = await Promise.all(tracked.map(name => readFile(join(root, name), 'utf8')));
    const failure = Object.assign(new Error('read refused'), { code: 'EACCES' });
    const read = commitModule.readJson;
    let original: unknown;
    const fault = spyOn(commitModule, 'readJson').mockImplementation(async file => {
      try {
        if (damage === 'unreadable' && file === path) throw failure;
        return await read(file);
      } catch (error) {
        original = error;
        throw error;
      }
    });
    try {
      for (const list of [
        () => store.listPendingStartBindings({ hostId: 'host' }),
        () => store.listStartReceipts(),
      ]) {
        const error = await list().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error('expected receipt failure');
        expect(error.message).toContain(relative);
        if (damage === 'schema') expect(error.cause).toBeInstanceOf(ZodError);
        else {
          expect(error.cause).toBe(original);
          expect(error.cause).toBeInstanceOf(damage === 'json' ? SyntaxError : Error);
        }
      }
    } finally {
      fault.mockRestore();
    }
    expect(await Promise.all(tracked.map(name => readFile(join(root, name), 'utf8')))).toEqual(
      before
    );
  }
);
