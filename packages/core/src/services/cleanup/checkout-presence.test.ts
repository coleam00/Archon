// @archon-test-isolated
import { describe, expect, mock, test } from 'bun:test';

const mockLstat = mock(() => Promise.resolve());
const realFs = await import('node:fs/promises');
mock.module('node:fs/promises', () => ({ ...realFs, lstat: mockLstat }));

const { checkoutExists } = await import('./checkout-presence');

const fsError = (code: string): Error => Object.assign(new Error(code), { code });

describe('checkoutExists', () => {
  test('a missing path is absent', async () => {
    mockLstat.mockRejectedValueOnce(fsError('ENOENT'));
    expect(await checkoutExists('/gone')).toBe(false);
  });

  // An unreadable checkout must fail the sweep, not read as a gone repository.
  test('a path that cannot be read rejects', async () => {
    mockLstat.mockRejectedValueOnce(fsError('EACCES'));
    await expect(checkoutExists('/locked')).rejects.toThrow('EACCES');
  });
});
