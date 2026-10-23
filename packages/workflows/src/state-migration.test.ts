// @archon-test-isolated
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'path';

const fs = await import('fs/promises');
const paths = await import('@archon/paths');
const access = mock((_path: string): Promise<void> => Promise.resolve());
const warn = mock((_payload: Record<string, unknown>, _event: string) => {});
mock.module('fs/promises', () => ({ ...fs, access }));
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ warn }),
}));
const { maybeWarnLegacyCwdStoragePath } = await import('./state-migration');

beforeEach(() => {
  access.mockReset();
  warn.mockClear();
});

describe('legacy cwd storage warnings', () => {
  for (const firstFails of [false, true]) {
    for (const secondFails of [false, true]) {
      it(`warns once for overlapping probes (first fails: ${firstFails}, second fails: ${secondFails})`, async () => {
        const cwd = join('projects', `${firstFails}-${secondFails}`, 'notes');
        const newRoot = join('storage', `${firstFails}-${secondFails}`);
        const firstProbe = Promise.withResolvers<void>();
        const secondProbe = Promise.withResolvers<void>();
        access.mockImplementationOnce(() => firstProbe.promise);
        access.mockImplementationOnce(() => secondProbe.promise);

        const first = maybeWarnLegacyCwdStoragePath(cwd, newRoot);
        const second = maybeWarnLegacyCwdStoragePath(cwd, newRoot);
        expect(access).toHaveBeenCalledTimes(2);
        expect(warn).not.toHaveBeenCalled();

        const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        if (firstFails) firstProbe.reject(error);
        else firstProbe.resolve();
        await first;
        expect(warn).toHaveBeenCalledTimes(1);

        if (secondFails) secondProbe.reject(error);
        else secondProbe.resolve();
        await second;
        await maybeWarnLegacyCwdStoragePath(cwd, newRoot);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(access).toHaveBeenCalledTimes(2);
        const legacyPath = paths.getProjectRoot('_cwd', 'notes');
        expect(warn.mock.calls[0]).toEqual([
          firstFails
            ? { err: error, legacyPath }
            : expect.objectContaining({ legacyPath, newPath: newRoot }),
          firstFails
            ? 'workflow.legacy_cwd_storage_probe_error'
            : 'workflow.legacy_cwd_storage_detected',
        ]);
      });
    }
  }

  it('stays quiet for missing storage and can warn if it appears later', async () => {
    const cwd = join('projects', 'missing', 'notes');
    access.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'ENOENT' }));
    await maybeWarnLegacyCwdStoragePath(cwd, 'new-root');
    expect(warn).not.toHaveBeenCalled();

    access.mockResolvedValueOnce(undefined);
    await maybeWarnLegacyCwdStoragePath(cwd, 'new-root');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe('workflow.legacy_cwd_storage_detected');
  });
});
