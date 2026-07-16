import { describe, test, expect } from 'bun:test';
import { InPlaceBackend } from './in-place';

describe('InPlaceBackend', () => {
  const backend = new InPlaceBackend();
  const req = {
    codebase: {
      id: 'cb-folder',
      defaultCwd: '/tmp/platform',
      name: 'platform',
      kind: 'folder' as const,
    },
  };

  test('id is in-place', () => {
    expect(backend.id).toBe('in-place');
  });

  test('prepare returns the real folder cwd + host execution context', async () => {
    const prepared = await backend.prepare(req);
    // Must be the real folder path (NOT the '/workspace' docker sentinel).
    expect(prepared.cwd).toBe('/tmp/platform');
    expect(prepared.execContext).toEqual({ kind: 'host' });
    // In-place creates no tracked environment row.
    expect(prepared.envId).toBeUndefined();
  });

  test('prepare cwd echoes codebase.defaultCwd (byte-identical to the pre-seam early-return)', async () => {
    const prepared = await backend.prepare(req);
    expect(prepared.cwd).toBe(req.codebase.defaultCwd);
  });

  test('destroy is a no-op (nothing tracked to tear down)', async () => {
    await expect(backend.destroy('unused')).resolves.toBeUndefined();
  });
});
