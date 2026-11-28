import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readWakeLastPass, writeWakeLastPass } from './wake-last-pass';

const track = trackTempRoots();

describe('reading the wake last-pass record', () => {
  test('no record is none, a valid one reads, and one that fails the schema is unreadable', async () => {
    const directory = track(await mkdtemp(join(tmpdir(), 'archon-wake-last-pass-')));
    const path = join(directory, 'last-pass.json');
    expect(await readWakeLastPass(path)).toEqual({ kind: 'none' });

    const pass = { at: '2026-11-24T12:00:00.000Z', pid: 7, ok: true, parts: {} };
    await writeWakeLastPass(path, pass);
    expect(await readWakeLastPass(path)).toEqual({ kind: 'read', pass });

    await writeFile(path, JSON.stringify({ ...pass, ok: 'yes' }));
    const invalid = await readWakeLastPass(path);
    expect(invalid.kind).toBe('unreadable');
    expect(invalid.kind === 'unreadable' && invalid.reason).toContain('ok');

    await writeFile(path, '{ not json');
    expect((await readWakeLastPass(path)).kind).toBe('unreadable');
  });
});
