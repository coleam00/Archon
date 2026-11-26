/**
 * The discovery cache's key and keeping, with a counting `discover`: whether a read discovers
 * again is what is under test, not discovery itself, so no test parses workflows.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as archonPaths from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { createDiscoveryCache } from './discovery-cache';

const track = trackTempRoots();

async function project(): Promise<string> {
  const root = track(await mkdtemp(join(tmpdir(), 'discovery-cache-')));
  await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
  await writeFile(join(root, '.archon', 'workflows', 'one.yaml'), 'name: one\n');
  return root;
}

/** A cache over a `discover` that counts its calls and answers a new result each time. */
function counted(loadConfig: () => Promise<{ commands?: { folder?: string } }> = async () => ({})) {
  const calls = { count: 0 };
  const read = createDiscoveryCache(loadConfig, async () => {
    calls.count++;
    return { workflows: [], errors: [] } satisfies WorkflowLoadResult;
  });
  return { read, calls };
}

/**
 * Writes `path` under the scratch home the test preload sets, runs `then`, and puts back what
 * was there before (the file, or nothing).
 */
async function inHome(path: string, body: string, then: () => Promise<unknown>): Promise<void> {
  const before = await readFile(path, 'utf8').catch(() => null);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  // A later time than any write the scratch home saw, so an edit at the same size shows.
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  try {
    await then();
  } finally {
    if (before === null) await rm(path, { force: true });
    else await writeFile(path, before);
  }
}

describe('createDiscoveryCache', () => {
  test('answers a second read with the kept discovery while nothing changed', async () => {
    const root = await project();
    const { read, calls } = counted();
    const first = await read(root);
    expect(await read(root)).toBe(first);
    expect(calls.count).toBe(1);
  });

  test('discovers again when a project workflow file is edited', async () => {
    const root = await project();
    const { read, calls } = counted();
    await read(root);
    const file = join(root, '.archon', 'workflows', 'one.yaml');
    await writeFile(file, 'name: one\n');
    // Same size: the later modification time alone shows the edit.
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    await read(root);
    expect(calls.count).toBe(2);
  });

  test('discovers again when a project workflow file is added or removed', async () => {
    const root = await project();
    const { read, calls } = counted();
    await read(root);
    const added = join(root, '.archon', 'workflows', 'two.yaml');
    await writeFile(added, 'name: two\n');
    await read(root);
    await rm(added);
    await read(root);
    expect(calls.count).toBe(3);
  });

  test("discovers again when an installed pack's workflow changes", async () => {
    const root = await project();
    const { read, calls } = counted();
    const file = join(archonPaths.getPluginsPath(), 'packs', 'acme', 'flow', 'c1', 'stage.yaml');
    await mkdir(dirname(file), { recursive: true });
    await read(root);
    await inHome(file, 'name: stage\n', () => read(root));
    expect(calls.count).toBe(2);
  });

  test("discovers again when the home's workflows or config change", async () => {
    const root = await project();
    const { read, calls } = counted();
    await mkdir(archonPaths.getHomeWorkflowsPath(), { recursive: true });
    await read(root);
    await inHome(join(archonPaths.getHomeWorkflowsPath(), 'home.yaml'), 'name: home\n', () =>
      read(root)
    );
    expect(calls.count).toBe(2);
    // The home workflow is gone again: another change.
    await read(root);
    expect(calls.count).toBe(3);
    await inHome(archonPaths.getArchonConfigPath(), 'assistant: claude\n', () => read(root));
    expect(calls.count).toBe(4);
  });

  test('discovers again when a configured command folder outside .archon changes', async () => {
    const root = await project();
    await mkdir(join(root, 'prompts'), { recursive: true });
    const { read, calls } = counted(async () => ({ commands: { folder: 'prompts' } }));
    await read(root);
    await writeFile(join(root, 'prompts', 'ask.md'), 'Ask.\n');
    await read(root);
    expect(calls.count).toBe(2);
  });

  test('keeps nothing for a project that is itself a pack folder', async () => {
    const root = await project();
    await writeFile(join(root, 'archon-plugin.json'), '{"kind":"provider"}');
    const { read, calls } = counted();
    await read(root);
    await read(root);
    expect(calls.count).toBe(2);
  });

  test('keeps nothing for a root with a link, whose edits the stamp cannot see', async () => {
    const root = await project();
    const elsewhere = track(await mkdtemp(join(tmpdir(), 'discovery-cache-linked-')));
    // A junction needs no privilege on Windows and is a plain directory link elsewhere.
    await symlink(elsewhere, join(root, '.archon', 'workflows', 'linked'), 'junction');
    const { read, calls } = counted();
    await read(root);
    await read(root);
    expect(calls.count).toBe(2);
  });

  test('keeps nothing from a discovery that rejected', async () => {
    const root = await project();
    let calls = 0;
    const read = createDiscoveryCache(
      async () => ({}),
      async () => {
        calls++;
        if (calls === 1) throw new Error('config unreadable');
        return { workflows: [], errors: [] };
      }
    );
    await expect(read(root)).rejects.toThrow('config unreadable');
    await read(root);
    expect(calls).toBe(2);
  });
});
