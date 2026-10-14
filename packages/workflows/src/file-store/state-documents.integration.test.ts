import { expect, setSystemTime, spyOn, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';
const roots = trackTempRoots();
for (const phase of ['publication', 'redo'] as const) {
  test.each([false, true])(
    `prune removes published scratch links after ${phase} (deletion denied: %s)`,
    async denied => {
      const root = roots(await mkdtemp(join(tmpdir(), 'file-state-scratch-prune-')));
      const store = await createFileWorkflowStore({ root });
      const input = {
        scope: { kind: 'install' } as const,
        name: 'ledger',
        writer: { kind: 'surface', via: 'cli' } as const,
      };
      const realUnlink = fsPromises.unlink;
      const spy = spyOn(fsPromises, 'unlink').mockImplementation(async path => {
        if (String(path).endsWith('1.json.publish.tmp') && (await Bun.file(String(path)).exists()))
          throw Object.assign(new Error('scratch handle denies deletion'), { code: 'EPERM' });
        return realUnlink(path);
      });
      try {
        setSystemTime(new Date('2000-01-01T00:00:00Z'));
        const row = await store.putStateDocument({ ...input, value: 'old', ifRevision: 0 });
        setSystemTime();
        const dir = (await readdir(join(root, 'state')))[0]!;
        const revisionPath = join(root, 'state', dir, '1.json');
        const scratch = `${revisionPath}.publish.tmp`;
        expect(await readFile(scratch)).toEqual(await readFile(revisionPath));
        expect((await fsPromises.stat(scratch)).ino).toBe(
          (await fsPromises.stat(revisionPath)).ino
        );
        if (phase === 'redo') {
          const seq = JSON.parse(await readFile(join(root, 'head.json'), 'utf8')).seq;
          await fsPromises.writeFile(
            join(root, 'intent.json'),
            JSON.stringify({
              seq,
              lines: [],
              documents: {},
              deleteRuns: [],
              immutableDocuments: { [`state/${dir}/1.json`]: row },
            })
          );
          await createFileWorkflowStore({ root });
        }
        await store.deleteStateDocument(input);
        const latestPath = join(root, 'state', dir, '2.json');
        const latestBytes = await readFile(latestPath);
        if (denied) {
          await expect(store.pruneStateRevisions(30)).rejects.toThrow(
            'scratch handle denies deletion'
          );
          expect(await Bun.file(join(root, 'intent.json')).exists()).toBe(true);
          expect(await Bun.file(revisionPath).exists()).toBe(true);
          expect(await Bun.file(scratch).exists()).toBe(true);
          spy.mockRestore();
        } else {
          spy.mockRestore();
          expect(await store.pruneStateRevisions(30)).toEqual({ count: 1 });
        }
        const reopened = await createFileWorkflowStore({ root });
        expect(await Bun.file(revisionPath).exists()).toBe(false);
        expect(await Bun.file(scratch).exists()).toBe(false);
        expect((await readdir(join(root, 'state', dir))).sort()).toEqual(['2.json', 'name.json']);
        expect(await readFile(latestPath)).toEqual(latestBytes);
        expect(await reopened.getStateDocument(input.scope, input.name)).toBeNull();
        expect(
          (await reopened.listStateRevisions(input.scope, input.name)).map(row => row.revision)
        ).toEqual([2]);
        expect(await reopened.pruneStateRevisions(30)).toEqual({ count: 0 });
        expect(await Bun.file(join(root, 'intent.json')).exists()).toBe(false);
      } finally {
        setSystemTime();
        spy.mockRestore();
      }
    }
  );
}
test('prune removes only old non-latest revisions within a mixed-age document', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'file-state-mixed-age-')));
  const store = await createFileWorkflowStore({ root });
  const input = {
    scope: { kind: 'install' } as const,
    name: 'ledger',
    writer: { kind: 'surface', via: 'cli' } as const,
  };
  setSystemTime(new Date('2000-01-01T00:00:00Z'));
  try {
    await store.putStateDocument({ ...input, value: 1, ifRevision: 0 });
  } finally {
    setSystemTime();
  }
  await store.putStateDocument({ ...input, value: 2, ifRevision: 1 });
  await store.putStateDocument({ ...input, value: 3, ifRevision: 2 });
  expect(await store.pruneStateRevisions(30)).toEqual({ count: 1 });
  const reopened = await createFileWorkflowStore({ root });
  expect(
    (await reopened.listStateRevisions(input.scope, input.name)).map(row => [
      row.revision,
      row.value,
    ])
  ).toEqual([
    [3, 3],
    [2, 2],
  ]);
  const dir = (await readdir(join(root, 'state')))[0]!;
  expect((await readdir(join(root, 'state', dir))).sort()).toEqual([
    '2.json',
    '3.json',
    'name.json',
  ]);
});
test.each(['append', 'cas'] as const)(
  'independent processes serialize state %s',
  async mode => {
    const root = roots(await mkdtemp(join(tmpdir(), 'file-state-race-')));
    await createFileWorkflowStore({ root });
    const script = `import {createFileWorkflowStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
import {StateRevisionConflictError} from ${JSON.stringify(join(import.meta.dir, '../state-document-store.ts'))};
const store=await createFileWorkflowStore({root:process.env.TEST_ROOT});
const input={scope:{kind:'install'},name:'ledger',writer:{kind:'surface',via:'cli'}};
try {
  const row=process.env.TEST_MODE==='append'
    ? await store.patchStateDocument({...input,ops:[{op:'append',path:'/seen',value:Number(process.env.TEST_VALUE)}]})
    : await store.putStateDocument({...input,value:Number(process.env.TEST_VALUE),ifRevision:0});
  console.log(JSON.stringify({revision:row.revision}));
} catch(error) {if(!(error instanceof StateRevisionConflictError)) throw error; console.log(JSON.stringify({conflict:true}));}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, value) => {
        const child = Bun.spawn([process.execPath, '-e', script], {
          env: {
            ...process.env,
            LOG_LEVEL: 'silent',
            TEST_ROOT: root,
            TEST_MODE: mode,
            TEST_VALUE: String(value),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, error).toBe(0);
        return JSON.parse(output);
      })
    );
    const store = await createFileWorkflowStore({ root });
    const revisions = await store.listStateRevisions({ kind: 'install' }, 'ledger');
    if (mode === 'append') {
      expect(revisions.map(row => row.revision)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(revisions[0]?.value).toEqual({
        seen: expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]),
      });
      const value = revisions[0]?.value;
      if (!value || Array.isArray(value) || typeof value !== 'object')
        throw new Error('Missing ledger');
      expect(value.seen).toHaveLength(8);
    } else {
      expect(results.filter(result => result.conflict)).toHaveLength(7);
      expect(revisions).toHaveLength(1);
    }
    const head = await readFile(join(root, 'head.json'));
    await expect(
      store.patchStateDocument({
        scope: { kind: 'install' },
        name: 'ledger',
        writer: { kind: 'surface', via: 'cli' },
        ops: [{ op: 'remove', path: '/absent' }],
      })
    ).rejects.toThrow();
    expect(await readFile(join(root, 'head.json'))).toEqual(head);
    const [dir] = await readdir(join(root, 'state'));
    expect((await readdir(join(root, 'state', dir!))).sort()).toEqual(
      [...revisions.map(row => `${row.revision}.json`), 'name.json'].sort()
    );
  },
  30000
);

test('a history reader holds the lock until prune can remove its revisions', async () => {
  const { setSystemTime, spyOn } = await import('bun:test');
  const persistence = await import('./commit');
  const root = roots(await mkdtemp(join(tmpdir(), 'file-state-read-prune-')));
  const store = await createFileWorkflowStore({ root });
  const input = {
    scope: { kind: 'install' } as const,
    name: 'ledger',
    writer: { kind: 'surface', via: 'cli' } as const,
  };
  setSystemTime(new Date('2000-01-01T00:00:00Z'));
  try {
    await store.putStateDocument({ ...input, value: {}, ifRevision: 0 });
    await store.deleteStateDocument(input);
  } finally {
    setSystemTime();
  }
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readJson = persistence.readJson;
  const spy = spyOn(persistence, 'readJson').mockImplementation(async path => {
    if (basename(path) === '1.json') {
      reading.resolve();
      await release.promise;
    }
    return readJson(path);
  });
  let history: ReturnType<typeof store.listStateRevisions> | undefined;
  let prune: ReturnType<typeof store.pruneStateRevisions> | undefined;
  try {
    history = store.listStateRevisions(input.scope, input.name);
    await reading.promise;
    expect(JSON.parse(await readFile(join(root, 'lock'), 'utf8')).pid).toBe(process.pid);
    prune = store.pruneStateRevisions(7);
    release.resolve();
    expect((await history).map(row => row.revision)).toEqual([2, 1]);
    expect(await prune).toEqual({ count: 1 });
  } finally {
    release.resolve();
    await Promise.allSettled([history, prune]);
    spy.mockRestore();
  }
  expect(
    (await store.listStateRevisions(input.scope, input.name)).map(row => row.revision)
  ).toEqual([2]);
});
