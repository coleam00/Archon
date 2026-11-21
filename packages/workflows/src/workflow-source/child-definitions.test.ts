import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { BaseRunDefinitions } from '../schemas/run-metadata';
import { withChildDefinitions } from './child-definitions';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const done = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  return done.stdout.toString().trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A run's checkout with one commit, and the parent's captured project scope beside it. */
function fixture(): { checkout: string; parentProject: string; commit: string } {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-child-defs-'))));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  git(checkout, 'init', '-q');
  write(checkout, '.archon/workflows/slot.yaml', 'ORIGINAL\n');
  git(checkout, 'add', '-A');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return {
    checkout,
    parentProject: join(root, 'parent-project'),
    commit: git(checkout, 'rev-parse', 'HEAD'),
  };
}

const definitions = (checkout: string, commit: string): BaseRunDefinitions => ({
  from: 'base',
  remote: 'origin',
  branch: 'dev',
  commit,
  merge_base: commit,
  checkout,
  local_files: [],
});

const noConfig = async (): Promise<{ commands?: { folder?: string } }> => ({});

async function compose(
  input: Parameters<typeof withChildDefinitions>[0]
): Promise<{ files: Map<string, string>; definitions: BaseRunDefinitions }> {
  return withChildDefinitions(input, async composed => {
    const files = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), path);
        else files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
      }
    };
    walk(composed.root, '');
    return { files, definitions: composed.definitions };
  });
}

describe("a base-definitions child's definitions", () => {
  test('compose from a parent with no project scope', async () => {
    const { checkout, parentProject, commit } = fixture();
    write(checkout, '.archon/workflows/authored.yaml', 'AUTHORED\n');

    const { files } = await compose({
      parentProject,
      definitions: definitions(checkout, commit),
      checkout,
      since: commit,
      commandFolder: undefined,
      loadConfig: noConfig,
    });

    expect(files.get('.archon/workflows/authored.yaml')).toBe('AUTHORED\n');
  });

  test("take a file the parent's checkout restored, not the copy the parent captured", async () => {
    const { checkout, parentProject, commit } = fixture();
    // The parent captured the checkout's dirty edit; the checkout has since restored it.
    write(parentProject, '.archon/workflows/slot.yaml', 'DIRTY\n');
    const parent = {
      ...definitions(checkout, commit),
      run_files: {
        checkout,
        since: commit,
        files: [{ path: '.archon/workflows/slot.yaml', change: 'modified' as const }],
      },
    };

    const { files } = await compose({
      parentProject,
      definitions: parent,
      checkout,
      since: commit,
      commandFolder: undefined,
      loadConfig: noConfig,
    });

    expect(files.get('.archon/workflows/slot.yaml')).toBe('ORIGINAL\n');
  });

  test("take the whole command folder the checkout's config now selects", async () => {
    const { checkout, parentProject, commit } = fixture();
    write(checkout, 'new-commands/plan.md', 'plan\n');
    git(checkout, 'add', '-A');
    git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'folder');
    write(checkout, '.archon/config.yaml', 'commands:\n  folder: new-commands\n');

    const { files, definitions: recorded } = await compose({
      parentProject,
      definitions: definitions(checkout, commit),
      checkout,
      since: git(checkout, 'rev-parse', 'HEAD'),
      commandFolder: 'old-commands',
      loadConfig: async () => ({ commands: { folder: 'new-commands' } }),
    });

    expect(files.get('new-commands/plan.md')).toBe('plan\n');
    expect(recorded.run_files?.files).toContainEqual({
      path: 'new-commands/plan.md',
      change: 'added',
    });
  });
});
