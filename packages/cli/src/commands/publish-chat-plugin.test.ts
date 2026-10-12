import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const real = { ...fs };
let fail: (operation: string, path: string) => boolean = () => false;
mock.module('node:fs/promises', () => ({
  ...real,
  async rename(source: string, target: string) {
    if (fail('rename', source)) throw new Error('injected rename failure');
    return real.rename(source, target);
  },
  async rm(path: string, options: Parameters<typeof fs.rm>[1]) {
    if (fail('rm', path)) throw new Error('injected remove failure');
    return real.rm(path, options);
  },
}));
const { publishChatPlugin } = await import('./publish-chat-plugin');
const trackRoot = trackTempRoots();
afterEach(() => {
  fail = () => false;
  mock.restore();
});

async function fixture(update: boolean, renamed: boolean) {
  const root = trackRoot(await real.mkdtemp(join(tmpdir(), 'archon-chat-publication-')));
  const receiptFile = join(root, 'receipt.json');
  const target = join(root, 'binary');
  const oldBinary = renamed ? join(root, 'old-binary') : target;
  const stagedReceipt = join(root, 'receipt.partial');
  const stagedBinary = join(root, 'binary.partial');
  if (update) {
    await real.writeFile(receiptFile, 'old receipt');
    await real.writeFile(oldBinary, 'old binary');
  }
  await real.writeFile(stagedReceipt, 'new receipt');
  await real.writeFile(stagedBinary, 'new binary');
  return {
    root,
    oldBinary,
    receiptFile,
    target,
    stagedReceipt,
    stagedBinary,
    previousFiles: update ? [oldBinary] : [],
  };
}

for (const update of [false, true]) {
  for (const stage of ['receipt', 'binary', ...(update ? ['obsolete'] : [])]) {
    test(`${update ? 'update' : 'fresh install'} rolls back failure publishing ${stage}`, async () => {
      const fixtureData = await fixture(update, true);
      const { receiptFile, target, oldBinary, stagedReceipt, stagedBinary, root } = fixtureData;
      let injected = false;
      fail = (op, path) => {
        const matches =
          stage === 'receipt'
            ? op === 'rename' && path === stagedReceipt
            : stage === 'binary'
              ? op === 'rename' && path === stagedBinary
              : op === 'rm' && path === oldBinary;
        if (matches && !injected) {
          injected = true;
          return true;
        }
        return false;
      };
      await expect(publishChatPlugin(fixtureData)).rejects.toThrow('previous install restored');
      expect(injected).toBe(true);
      expect(await Bun.file(target).exists()).toBe(false);
      if (update) {
        expect(await Bun.file(receiptFile).text()).toBe('old receipt');
        expect(await Bun.file(oldBinary).text()).toBe('old binary');
      } else expect(await Bun.file(receiptFile).exists()).toBe(false);
      expect(
        (await real.readdir(root)).filter(name => /[a-f0-9]{12}\.partial$/.test(name))
      ).toEqual([]);
    });
  }
}

test('failed same-name update restores executable bytes', async () => {
  const data = await fixture(true, false);
  fail = (op, path) => op === 'rename' && path === data.stagedBinary;
  await expect(publishChatPlugin(data)).rejects.toThrow('previous install restored');
  expect(await Bun.file(data.target).text()).toBe('old binary');
  expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
});

test('successful same-name update replaces receipt and executable without leftover staging files', async () => {
  const data = await fixture(true, false);
  await publishChatPlugin(data);
  expect(await Bun.file(data.receiptFile).text()).toBe('new receipt');
  expect(await Bun.file(data.target).text()).toBe('new binary');
  expect((await real.readdir(data.root)).sort()).toEqual(['binary', 'receipt.json']);
});

test('rollback failure reports recovery paths and preserves the usable backup', async () => {
  const data = await fixture(true, false);
  fail = (op, path) =>
    op === 'rename' && (path === data.stagedBinary || path.startsWith(data.receiptFile + '.'));
  const error = await publishChatPlugin(data).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(String(error)).toContain('rollback failed; recovery required');
  expect(String(error)).toContain(data.receiptFile);
  const backup = (await real.readdir(data.root)).find(name => name.startsWith('receipt.json.'));
  expect(backup).toBeDefined();
  expect(await Bun.file(join(data.root, backup ?? '')).text()).toBe('old receipt');
});

test('backup cleanup after commit warns and preserves installed success', async () => {
  const data = await fixture(true, true);
  fail = (op, path) => op === 'rm' && /[a-f0-9]{12}\.partial$/.test(path);
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  await publishChatPlugin(data);
  expect(await Bun.file(data.receiptFile).text()).toBe('new receipt');
  expect(await Bun.file(data.target).text()).toBe('new binary');
  expect(await Bun.file(data.oldBinary).exists()).toBe(false);
  expect(warn.mock.calls.flat().join('\n')).toContain('Chat plugin backup cleanup failed:');
});
