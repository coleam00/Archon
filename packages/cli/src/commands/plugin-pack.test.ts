import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packTreePath, readReceipts } from '@archon/plugin-manifest/store';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { pluginCommand, type PluginEnvironment } from './plugin';
import { tarGz, type FixtureEntry } from './plugin-tar-fixture';

// A local stand-in for GitHub serving one real repository of workflow packs:
// git's dumb HTTP protocol for `git ls-remote`, `git show` for raw files and
// `git archive` for codeload tarballs, so every install reads real git output.
// `craftedTarballs` replaces a commit's tarball with entries git never writes.

const tempRoot = trackTempRoots();
const ID = 'owner/packs/packs/review-kit';
const TREE_FILES = [
  '.shared/util.ts',
  'archon-plugin.json',
  'helper/helper.yaml',
  'receipt.json',
  'review/commands/scope.md',
  'review/review.yaml',
  'review/scripts/check.ts',
];

let repo: string;
let server: ReturnType<typeof Bun.serve>;
const commits = new Map<string, string>();
const craftedTarballs = new Map<string, Uint8Array>();

const manifest = (name: string, entrypoints: Record<string, string>): string =>
  `${JSON.stringify({ schemaVersion: 1, kind: 'workflow-pack', name, description: 'fixture', entrypoints }, null, 2)}\n`;

function git(...args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd: repo }
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'plugin-pack-fixture-'));
  git('init', '-q');
  await write('README.md', 'not part of any plugin\n');
  const kit = 'packs/review-kit';
  await write(
    `${kit}/archon-plugin.json`,
    manifest('review-kit', { review: 'review/review.yaml' })
  );
  await write(`${kit}/review/review.yaml`, 'name: review\n# v1\n');
  await write(`${kit}/review/commands/scope.md`, 'Scope the change.\n');
  await write(`${kit}/review/scripts/check.ts`, 'console.log("ok");\n');
  await write(`${kit}/helper/helper.yaml`, 'name: helper\n');
  await write(`${kit}/.shared/util.ts`, 'export const util = 1;\n');
  // A pack may hold a file named like a receipt; it must never be read as one.
  await write(`${kit}/receipt.json`, '{"not": "a receipt"}\n');
  await write(
    'packs/review-kit-fork/archon-plugin.json',
    manifest('review-kit', { review: 'review/review.yaml' })
  );
  await write('packs/review-kit-fork/review/review.yaml', 'name: review\n');
  await write('packs/missing/archon-plugin.json', manifest('missing', { go: 'go/go.yaml' }));
  await write('packs/crowded/archon-plugin.json', manifest('crowded', { go: 'go/go.yaml' }));
  await write('packs/crowded/go/go.yaml', 'name: go\n');
  await write('packs/crowded/go/other.yml', 'name: other\n');
  await write('packs/linked/archon-plugin.json', manifest('linked', { go: 'go/go.yaml' }));
  await write('packs/linked/go/go.yaml', 'name: go\n');
  git('add', '.');
  git('update-index', '--chmod=+x', `${kit}/review/scripts/check.ts`);
  // A symlink inside a plugin, staged directly so no filesystem symlink is needed.
  await writeFile(join(repo, 'link-target'), '../../README.md');
  const blob = git('hash-object', '-w', 'link-target');
  git('update-index', '--add', '--cacheinfo', `120000,${blob},packs/linked/go/readme`);
  git('commit', '-q', '-m', 'v1');
  git('tag', 'v1');
  commits.set('v1', git('rev-parse', 'HEAD'));
  await write(`${kit}/review/review.yaml`, 'name: review\n# v2\n');
  git('add', `${kit}/review/review.yaml`);
  git('commit', '-q', '-m', 'v2');
  commits.set('head', git('rev-parse', 'HEAD'));
  git('update-server-info');

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const gitFile = /^\/owner\/packs\.git\/(.+)$/.exec(path);
      if (gitFile) {
        const file = Bun.file(join(repo, '.git', gitFile[1]));
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      }
      const raw = /^\/raw\/owner\/packs\/([0-9a-f]{40})\/(.+)$/.exec(path);
      if (raw) {
        const shown = Bun.spawnSync(['git', 'show', `${raw[1]}:${raw[2]}`], { cwd: repo });
        return shown.exitCode === 0
          ? new Response(shown.stdout)
          : new Response(null, { status: 404 });
      }
      const codeload = /^\/codeload\/owner\/packs\/tar\.gz\/([0-9a-f]{40})$/.exec(path);
      if (codeload) {
        const crafted = craftedTarballs.get(codeload[1]);
        if (crafted) return new Response(crafted);
        const archive = Bun.spawnSync(
          ['git', 'archive', '--format=tar.gz', `--prefix=packs-${codeload[1]}/`, codeload[1]],
          { cwd: repo }
        );
        return new Response(archive.stdout);
      }
      return new Response(null, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await removeTempTree(repo);
});

async function environment(): Promise<PluginEnvironment> {
  const home = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-pack-home-')));
  return {
    pluginsDir: join(home, 'plugins'),
    archonVersion: '0.11.0',
    projectDir: join(home, 'project'),
    githubUrl: server.url.origin,
    rawUrl: `${server.url.origin}/raw`,
    codeloadUrl: `${server.url.origin}/codeload`,
  };
}

async function run(
  env: PluginEnvironment,
  subcommand: string,
  target?: string
): Promise<{ code: number; out: string; err: string }> {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await pluginCommand(subcommand, target ? [target] : [], env);
    return {
      code,
      out: log.mock.calls.map(call => call.join(' ')).join('\n'),
      err: error.mock.calls.map(call => call.join(' ')).join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

/** Every file under a directory with a digest, to prove a failure wrote nothing. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  for (const entry of entries.sort()) {
    try {
      files[entry.split('\\').join('/')] = createHash('sha256')
        .update(await readFile(join(dir, entry)))
        .digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    }
  }
  return files;
}

const commit = (name: string): string => commits.get(name) ?? '';

/** A codeload-shaped tarball of the review-kit pack at v1, plus `extra` entries. */
function craftedPack(extra: FixtureEntry[], manifestOverride?: string): Uint8Array {
  const root = `packs-${commit('v1')}/packs/review-kit`;
  return tarGz([
    {
      path: `${root}/archon-plugin.json`,
      data: manifestOverride ?? manifest('review-kit', { review: 'review/review.yaml' }),
    },
    { path: `${root}/review/review.yaml`, data: 'name: review\n' },
    ...extra.map(entry => ({ ...entry, path: entry.path.replace('<root>', root) })),
  ]);
}

describe('archon plugin: workflow packs', () => {
  test('installs the default branch head as one complete tree, then updates, lists and removes it', async () => {
    const env = await environment();
    const installed = await run(env, 'install', ID);
    expect(installed.err).toBe('');
    expect(installed.out).toContain(`default branch (commit ${commit('head')})`);
    expect(installed.out).toContain('owner/review-kit:review');

    const tree = packTreePath(env.pluginsDir, ID, commit('head'));
    expect(Object.keys(await snapshot(tree))).toEqual(TREE_FILES);
    expect(await readFile(join(tree, 'review/review.yaml'), 'utf8')).toContain('# v2');
    if (process.platform !== 'win32') {
      expect((await stat(join(tree, 'review/scripts/check.ts'))).mode & 0o111).not.toBe(0);
    }
    // The pack's own `receipt.json` sits outside the receipts tree.
    const receipts = await readReceipts(env.pluginsDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: ID, commit: commit('head') });
    expect(receipts[0].tag).toBeUndefined();
    expect((await run(env, 'list')).out).toBe(
      `${ID}  workflow-pack  -  ${commit('head').slice(0, 12)}  archon any`
    );

    const updated = await run(env, 'update', `${ID}@v1`);
    expect(updated.err).toBe('');
    expect(updated.out).toContain(`(commit ${commit('head')}) -> v1 (commit ${commit('v1')})`);
    const v1Tree = packTreePath(env.pluginsDir, ID, commit('v1'));
    expect(await readFile(join(v1Tree, 'review/review.yaml'), 'utf8')).toContain('# v1');
    expect(await snapshot(tree)).toEqual({});

    const before = await snapshot(env.pluginsDir);
    const again = await run(env, 'update', `${ID}@v1`);
    expect(again.out).toContain('is already at v1');
    expect(await snapshot(env.pluginsDir)).toEqual(before);

    const removed = await run(env, 'remove', ID);
    expect(removed.code).toBe(0);
    expect(await snapshot(env.pluginsDir)).toEqual({});
  });

  test('copy makes a project-owned copy and refuses an existing destination', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v1`)).code).toBe(0);
    const copied = await run(env, 'copy', ID);
    expect(copied.err).toBe('');
    const target = join(env.projectDir, '.archon', 'workflows', 'review-kit');
    expect(Object.keys(await snapshot(target))).toEqual(TREE_FILES);

    // An existing destination is never merged into, even when no file would collide.
    const other = { ...env, projectDir: join(env.projectDir, '..', 'other') };
    const occupied = join(other.projectDir, '.archon', 'workflows', 'review-kit');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'mine.txt'), 'mine');
    const refused = await run(other, 'copy', ID);
    expect(refused.err).toContain('already exists');
    expect(Object.keys(await snapshot(occupied))).toEqual(['mine.txt']);
  });

  test('refuses a second pack with the same owner and name', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v1`)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const clash = await run(env, 'install', 'owner/packs/packs/review-kit-fork@v1');
    expect(clash.err).toContain(`are both workflow packs named owner/review-kit`);
    expect(clash.err).toContain(ID);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test.each([
    ['a symlink', 'owner/packs/packs/linked@v1', '"go/readme" is a symlink'],
    [
      'a missing entrypoint',
      'owner/packs/packs/missing@v1',
      'entrypoint "go" names go/go.yaml, which is not in the pack',
    ],
    [
      'a folder with two YAML files',
      'owner/packs/packs/crowded@v1',
      'must hold exactly one .yaml file (found 2)',
    ],
  ])('refuses a pack with %s and writes nothing', async (_case, target, message) => {
    const env = await environment();
    const result = await run(env, 'install', target);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(await snapshot(env.pluginsDir)).toEqual({});
  });

  test.each([
    [
      'an entry escaping the archive',
      [{ path: '<root>/../../../../evil.txt', data: 'x' }],
      'escapes its root',
    ],
    [
      'a hard link',
      [{ path: '<root>/review/hard', type: '1' as const, link: 'etc/passwd' }],
      '"review/hard" is a hardlink',
    ],
  ])('refuses a tarball with %s and writes nothing', async (_case, extra, message) => {
    const env = await environment();
    craftedTarballs.set(commit('v1'), craftedPack(extra));
    try {
      const result = await run(env, 'install', `${ID}@v1`);
      expect(result.err).toContain(message);
      expect(await snapshot(env.pluginsDir)).toEqual({});
    } finally {
      craftedTarballs.delete(commit('v1'));
    }
  });

  test('refuses a tarball whose manifest differs from the one at the same commit', async () => {
    const env = await environment();
    craftedTarballs.set(
      commit('v1'),
      craftedPack([], manifest('review-kit', { review: 'review/review.yaml', more: 'more/m.yaml' }))
    );
    try {
      const result = await run(env, 'install', `${ID}@v1`);
      expect(result.err).toContain('differs from the one at the same commit');
      expect(await snapshot(env.pluginsDir)).toEqual({});
    } finally {
      craftedTarballs.delete(commit('v1'));
    }
  });
});
