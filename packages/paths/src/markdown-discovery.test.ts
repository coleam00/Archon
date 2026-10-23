import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, mkdtemp, writeFile, symlink as fsSymlink } from 'fs/promises';
import {
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  findMarkdownFilesRecursive,
  findCommandFiles,
} from './markdown-discovery';
import { usePathEnvSnapshot, removeTempTree } from './test-utils';

const isWindows = process.platform === 'win32';

describe('markdown-discovery', () => {
  usePathEnvSnapshot();

  describe('getCommandFolderSearchPaths', () => {
    test('returns .archon/commands by default', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths).toEqual(['.archon/commands']);
    });

    test('includes configured folder when provided', () => {
      const paths = getCommandFolderSearchPaths('.claude/commands/archon');
      expect(paths).toEqual(['.archon/commands', '.claude/commands/archon']);
    });

    test('.archon/commands has highest priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[0]).toBe('.archon/commands');
    });

    test('does not duplicate .archon/commands if configured', () => {
      const paths = getCommandFolderSearchPaths('.archon/commands');
      expect(paths).toEqual(['.archon/commands']);
    });
  });

  describe('getWorkflowFolderSearchPaths', () => {
    test('returns .archon/workflows', () => {
      const paths = getWorkflowFolderSearchPaths();
      expect(paths).toEqual(['.archon/workflows']);
    });
  });

  test('findCommandFiles excludes markdown directly inside node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-command-discovery-'));
    try {
      await writeFile(join(root, 'root.md'), '# root');
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'node_modules', 'unwanted.md'), '# unwanted');

      expect(await findCommandFiles(root)).toEqual([
        { commandName: 'root', relativePath: 'root.md' },
      ]);
    } finally {
      await removeTempTree(root);
    }
  });
});

describe.skipIf(isWindows)('findMarkdownFilesRecursive - symlinks', () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `archon-md-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    sourceDir = join(
      tmpdir(),
      `archon-md-symlink-source-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(tempDir);
    await removeTempTree(sourceDir);
  });

  test('finds .md file reached via symlink in the search root', async () => {
    await writeFile(join(sourceDir, 'linked.md'), '# linked');
    await fsSymlink(join(sourceDir, 'linked.md'), join(tempDir, 'linked.md'));

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files).toEqual([{ commandName: 'linked', relativePath: 'linked.md' }]);
  });

  test('mixes regular files and symlinks in the same directory', async () => {
    await writeFile(join(tempDir, 'regular.md'), '# regular');
    await writeFile(join(sourceDir, 'linked.md'), '# linked');
    await fsSymlink(join(sourceDir, 'linked.md'), join(tempDir, 'linked.md'));

    const files = await findMarkdownFilesRecursive(tempDir);
    const commandNames = files.map(file => file.commandName).sort();

    expect(commandNames).toEqual(['linked', 'regular']);
  });

  test('descends into a symlinked directory of .md files', async () => {
    await writeFile(join(sourceDir, 'nested.md'), '# nested');
    await fsSymlink(sourceDir, join(tempDir, 'linked-dir'));

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files).toEqual([
      { commandName: 'nested', relativePath: join('linked-dir', 'nested.md') },
    ]);
  });

  test('returns entries in name order regardless of creation order', async () => {
    // Created in reverse-alphabetical order at every level. On a filesystem
    // that reports creation order (ext4 without dir_index, tmpfs), an unsorted
    // walk returns this tree reversed.
    for (const name of ['zeta', 'mid', 'alpha']) {
      const dir = join(tempDir, name);
      await mkdir(dir);
      for (const leaf of ['z-leaf', 'a-leaf']) {
        await writeFile(join(dir, `${leaf}.md`), `# ${leaf}`);
      }
    }
    await writeFile(join(tempDir, 'z-root.md'), '# z-root');
    await writeFile(join(tempDir, 'a-root.md'), '# a-root');

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files.map(file => file.relativePath)).toEqual([
      'a-root.md',
      join('alpha', 'a-leaf.md'),
      join('alpha', 'z-leaf.md'),
      join('mid', 'a-leaf.md'),
      join('mid', 'z-leaf.md'),
      'z-root.md',
      join('zeta', 'a-leaf.md'),
      join('zeta', 'z-leaf.md'),
    ]);
  });

  test('preserves sibling symlink aliases that point to the same directory', async () => {
    const localSourceDir = join(tempDir, 'source');
    await mkdir(localSourceDir);
    await writeFile(join(localSourceDir, 'foo.md'), '# foo');
    await fsSymlink(localSourceDir, join(tempDir, 'alias'));

    const files = await findMarkdownFilesRecursive(tempDir);

    // No sort: 'alias' precedes 'source', and the walk defines that order.
    expect(files.map(file => file.relativePath)).toEqual([
      join('alias', 'foo.md'),
      join('source', 'foo.md'),
    ]);
  });

  test('skips broken symlinks silently', async () => {
    await writeFile(join(tempDir, 'regular.md'), '# regular');
    await fsSymlink(join(sourceDir, 'missing.md'), join(tempDir, 'broken.md'));

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files).toEqual([{ commandName: 'regular', relativePath: 'regular.md' }]);
  });

  test('does not recurse infinitely on a self-referential symlink cycle', async () => {
    await writeFile(join(tempDir, 'root.md'), '# root');
    await fsSymlink(tempDir, join(tempDir, 'self'));

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files).toEqual([{ commandName: 'root', relativePath: 'root.md' }]);
  });

  test('does not recurse infinitely on a multi-level symlink cycle', async () => {
    const firstDir = join(tempDir, 'first');
    const secondDir = join(firstDir, 'second');
    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, 'nested.md'), '# nested');
    await fsSymlink(firstDir, join(secondDir, 'back-to-first'));

    const files = await findMarkdownFilesRecursive(tempDir);

    expect(files).toEqual([
      { commandName: 'nested', relativePath: join('first', 'second', 'nested.md') },
    ]);
  });
});
