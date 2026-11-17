import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { addTriggerFile } from './add-trigger-file';

const tempRoot = trackTempRoots();

describe('addTriggerFile', () => {
  it('places the file under its own name, replacing an earlier one, and leaves no temp file', async () => {
    const root = tempRoot(await mkdtemp(join(tmpdir(), 'archon-trigger-add-')));
    const source = join(root, 'build-after-plan.json');
    const triggers = join(root, 'home', 'triggers');

    await writeFile(source, '{"version":1}');
    await addTriggerFile(source, triggers);
    await writeFile(source, '{"version":2}');
    const placed = await addTriggerFile(source, triggers);

    expect(placed).toBe(join(triggers, 'build-after-plan.json'));
    expect(await readFile(placed, 'utf8')).toBe('{"version":2}');
    expect(await readdir(triggers)).toEqual(['build-after-plan.json']);
  });

  it('refuses a name the engine would never read', async () => {
    const root = tempRoot(await mkdtemp(join(tmpdir(), 'archon-trigger-add-')));
    const source = join(root, 'binding.txt');
    await writeFile(source, '{}');

    await expect(addTriggerFile(source, join(root, 'triggers'))).rejects.toThrow(
      'does not end in .json'
    );
  });
});
