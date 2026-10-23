import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const real = { ...fs };
let fail: (operation: string, path: string) => boolean = () => false;
/** Fails a rename (by its target) or a remove with EBUSY, as Windows does for a held file. */
let busy: (operation: string, path: string) => boolean = () => false;
const ebusy = () => Object.assign(new Error('injected EBUSY'), { code: 'EBUSY' });
mock.module('node:fs/promises', () => ({
  ...real,
  async lstat(path: string) {
    if (fail('lstat', path))
      throw Object.assign(new Error('injected stat failure'), { code: 'EACCES' });
    return real.lstat(path);
  },
  async copyFile(source: string, target: string) {
    if (fail('copyFile', source)) throw new Error('injected copy failure');
    return real.copyFile(source, target);
  },
  async rename(source: string, target: string) {
    if (fail('rename', source)) throw new Error('injected rename failure');
    if (busy('rename', target)) throw ebusy();
    return real.rename(source, target);
  },
  async rm(path: string, options: Parameters<typeof fs.rm>[1]) {
    if (fail('rm', path)) throw new Error('injected remove failure');
    if (busy('rm', path)) throw ebusy();
    return real.rm(path, options);
  },
}));
const { publishPlugin } = await import('./publish-plugin');
const isBackup = (path: string): boolean => /[a-f0-9]{12}\.partial$/.test(path);
const trackRoot = trackTempRoots();
afterEach(() => {
  fail = () => false;
  busy = () => false;
  mock.restore();
});

async function fixture(update: boolean, renamed: boolean) {
  const root = trackRoot(await real.mkdtemp(join(tmpdir(), 'archon-plugin-publication-')));
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
      await expect(publishPlugin(fixtureData)).rejects.toThrow('previous install restored');
      expect(injected).toBe(true);
      expect(await Bun.file(target).exists()).toBe(false);
      if (update) {
        expect(await Bun.file(receiptFile).text()).toBe('old receipt');
        expect(await Bun.file(oldBinary).text()).toBe('old binary');
      } else expect(await Bun.file(receiptFile).exists()).toBe(false);
      expect((await real.readdir(root)).filter(isBackup)).toEqual([]);
    });
  }
}

test.each(['lstat', 'copyFile'])(
  '%s failure refuses publication before replacing installed files',
  async operation => {
    const data = await fixture(true, false);
    fail = (op, path) => op === operation && path === data.oldBinary;
    await expect(publishPlugin(data)).rejects.toThrow(
      `Plugin could not back up installed files: ${data.receiptFile}. injected ${operation === 'lstat' ? 'stat' : 'copy'} failure`
    );
    expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
    expect(await Bun.file(data.target).text()).toBe('old binary');
    expect(await Bun.file(data.stagedReceipt).text()).toBe('new receipt');
    expect(await Bun.file(data.stagedBinary).text()).toBe('new binary');
    expect((await real.readdir(data.root)).sort()).toEqual([
      'binary',
      'binary.partial',
      'receipt.json',
      'receipt.partial',
    ]);
  }
);

test('failed same-name update restores executable bytes', async () => {
  const data = await fixture(true, false);
  fail = (op, path) => op === 'rename' && path === data.stagedBinary;
  await expect(publishPlugin(data)).rejects.toThrow('previous install restored');
  expect(await Bun.file(data.target).text()).toBe('old binary');
  expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
});

test('successful same-name update replaces receipt and executable without leftover staging files', async () => {
  const data = await fixture(true, false);
  await publishPlugin(data);
  expect(await Bun.file(data.receiptFile).text()).toBe('new receipt');
  expect(await Bun.file(data.target).text()).toBe('new binary');
  expect((await real.readdir(data.root)).sort()).toEqual(['binary', 'receipt.json']);
});

test('rollback failure reports recovery paths and preserves the usable backup', async () => {
  const data = await fixture(true, false);
  fail = (op, path) =>
    op === 'rename' && (path === data.stagedBinary || path.startsWith(data.receiptFile + '.'));
  const error = await publishPlugin(data).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(String(error)).toContain('rollback failed; recovery required');
  expect(String(error)).toContain(data.receiptFile);
  // The publication failure that triggered the rollback is the reason to act on.
  expect(String(error)).toContain('injected rename failure');
  expect((error as Error).cause).toBeInstanceOf(Error);
  const backup = (await real.readdir(data.root)).find(name => name.startsWith('receipt.json.'));
  expect(backup).toBeDefined();
  expect(await Bun.file(join(data.root, backup ?? '')).text()).toBe('old receipt');
});

test('backup cleanup after commit warns and preserves installed success', async () => {
  const data = await fixture(true, true);
  fail = (op, path) => op === 'rm' && isBackup(path);
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  await publishPlugin(data);
  expect(await Bun.file(data.receiptFile).text()).toBe('new receipt');
  expect(await Bun.file(data.target).text()).toBe('new binary');
  expect(await Bun.file(data.oldBinary).exists()).toBe(false);
  expect(warn.mock.calls.flat().join('\n')).toContain('Plugin backup cleanup failed:');
});

test('rollback waits out a briefly locked receipt', async () => {
  const data = await fixture(true, false);
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  let binaryFailed = false;
  let receiptFailures = 0;
  fail = (op, path) => {
    if (op === 'rename' && path === data.stagedBinary) binaryFailed = true;
    return binaryFailed && path === data.stagedBinary;
  };
  busy = (op, target) => {
    if (op !== 'rename' || !binaryFailed || target !== data.receiptFile || receiptFailures >= 3)
      return false;
    receiptFailures++;
    return true;
  };
  await expect(publishPlugin(data)).rejects.toThrow('previous install restored');
  expect(receiptFailures).toBe(3);
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
  expect(await Bun.file(data.target).text()).toBe('old binary');
});

test('backup cleanup after commit waits out a briefly locked backup', async () => {
  const data = await fixture(true, true);
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  let failures = 0;
  busy = (op, path) => {
    if (op !== 'rm' || !isBackup(path) || failures >= 3) return false;
    failures++;
    return true;
  };
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  await publishPlugin(data);
  expect(failures).toBe(3);
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(warn).not.toHaveBeenCalled();
  expect((await real.readdir(data.root)).sort()).toEqual(['binary', 'receipt.json']);
});

test('a failed update discards the backup of an executable it never replaced, even while that executable is held', async () => {
  const data = await fixture(true, false);
  spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  fail = (op, path) => op === 'rename' && path === data.stagedBinary;
  // Renaming the backup back over the untouched executable would never get through.
  busy = (op, target) => op === 'rename' && target === data.target;
  await expect(publishPlugin(data)).rejects.toThrow('previous install restored');
  expect(await Bun.file(data.target).text()).toBe('old binary');
  expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
  expect((await real.readdir(data.root)).filter(isBackup)).toEqual([]);
});

test('a failed update names a backup that stays locked instead of leaving it silently', async () => {
  const data = await fixture(true, false);
  spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  fail = (op, path) => op === 'rename' && path === data.stagedBinary;
  busy = (op, path) => op === 'rm' && isBackup(path);
  const error = await publishPlugin(data).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(String(error)).toContain('previous install restored');
  const leftovers = (await real.readdir(data.root)).filter(isBackup);
  expect(leftovers).toHaveLength(1);
  expect(String(error)).toContain(
    `Remove leftover backups: ${join(data.root, leftovers[0] ?? '')}`
  );
  expect(await Bun.file(data.target).text()).toBe('old binary');
  expect(await Bun.file(data.receiptFile).text()).toBe('old receipt');
});
