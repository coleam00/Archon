import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { packTreePath, readReceipts, receiptPath } from '@archon/plugin-manifest/store';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { pluginCommand, type PluginEnvironment } from './plugin';

// One real git repository of workflow packs stands in for GitHub. The installer
// resolves and fetches it with git over a file URL (`<root>/owner/packs.git`), exactly
// the path it takes against github.com; a small HTTP server answers the raw
// manifest reads with `git show`. Trees git would never produce from a working
// directory (links, escaping or Windows-unsafe names) are built with plumbing and
// tagged, so every refusal is exercised against real git output.

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

let root: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const commits = new Map<string, string>();

const manifest = (name: string, entrypoints: Record<string, string>): string =>
  `${JSON.stringify({ schemaVersion: 1, kind: 'workflow-pack', name, description: 'fixture', entrypoints }, null, 2)}\n`;

function git(args: string[], input?: string): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd: repo, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) }
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

type Tree = { [name: string]: Tree | { mode: string; oid: string } };

/** Commit a tree built with `git mktree`, which accepts entry names a checkout never would. */
function commitTree(entries: Record<string, { mode: string; oid: string }>, tag: string): void {
  const tree: Tree = {};
  for (const [path, entry] of Object.entries(entries)) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Tree;
    node[parts[parts.length - 1]] = entry;
  }
  const build = (node: Tree): string =>
    git(
      ['mktree'],
      Object.entries(node)
        .map(([name, child]) =>
          'mode' in child && typeof child.mode === 'string'
            ? `${child.mode} ${child.mode === '160000' ? 'commit' : 'blob'} ${String(child.oid)}\t${name}\n`
            : `040000 tree ${build(child as Tree)}\t${name}\n`
        )
        .join('')
    );
  const commit = git(['commit-tree', build(tree), '-m', tag]);
  git(['tag', tag, commit]);
  commits.set(tag, commit);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-pack-fixture-'));
  repo = join(root, 'owner', 'packs.git');
  await mkdir(repo, { recursive: true });
  git(['init', '-q']);
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
  git(['add', '.']);
  git(['update-index', '--chmod=+x', `${kit}/review/scripts/check.ts`]);
  git(['commit', '-q', '-m', 'v1']);
  git(['tag', 'v1']);
  commits.set('v1', git(['rev-parse', 'HEAD']));
  await write(`${kit}/review/review.yaml`, 'name: review\n# v2\n');
  git(['add', `${kit}/review/review.yaml`]);
  git(['commit', '-q', '-m', 'v2']);
  commits.set('head', git(['rev-parse', 'HEAD']));
  git(['tag', 'v2']);

  // Crafted trees, each a valid review-kit pack plus one entry. Tags only: the
  // default branch head stays the ordinary v2 commit.
  const blob = (content: string): { mode: string; oid: string } => ({
    mode: '100644',
    oid: git(['hash-object', '-w', '--stdin'], content),
  });
  const pack = {
    'packs/review-kit/archon-plugin.json': blob(
      manifest('review-kit', { review: 'review/review.yaml' })
    ),
    'packs/review-kit/review/review.yaml': blob('name: review\n'),
  };
  const link = { mode: '120000', oid: git(['hash-object', '-w', '--stdin'], '../../README.md') };
  commitTree({ ...pack, 'packs/review-kit/review/readme': link }, 'crafted-symlink');
  commitTree(
    { ...pack, 'packs/review-kit/vendor': { mode: '160000', oid: commits.get('v1') ?? '' } },
    'crafted-submodule'
  );
  commitTree({ ...pack, 'packs/review-kit/review/../../evil.txt': blob('x') }, 'crafted-escape');
  commitTree(
    { ...pack, 'packs/review-kit/review/..\\..\\evil.cmd': blob('x') },
    'crafted-backslash'
  );
  commitTree({ ...pack, 'packs/review-kit/review/C:evil': blob('x') }, 'crafted-colon');
  commitTree({ ...pack, 'elsewhere/notes:file\\x.txt': blob('x') }, 'crafted-outside');
  commitTree(
    {
      ...pack,
      'packs/review-kit/archon-plugin.json': blob(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'workflow-pack',
          name: 'review-kit',
          description: 'fixture',
          compatibility: { archon: '>=99.0.0' },
          entrypoints: { review: 'review/review.yaml' },
        })}\n`
      ),
    },
    'crafted-compat'
  );
  // The pack's own attributes ask for CRLF endings and `$Id$` expansion on checkout.
  commitTree(
    {
      ...pack,
      'packs/review-kit/.gitattributes': blob('* text eol=crlf ident\n'),
      'packs/review-kit/review/review.yaml': blob('name: review\n# $Id$\n'),
    },
    'crafted-attributes'
  );

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const raw = /^\/raw\/owner\/packs\/([0-9a-f]{40})\/(.+)$/.exec(path);
      if (!raw) return new Response(null, { status: 404 });
      const shown = Bun.spawnSync(['git', 'show', `${raw[1]}:${raw[2]}`], { cwd: repo });
      return shown.exitCode === 0
        ? new Response(shown.stdout)
        : new Response(null, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await removeTempTree(root);
});

async function environment(): Promise<PluginEnvironment> {
  const home = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-pack-home-')));
  return {
    pluginsDir: join(home, 'plugins'),
    archonVersion: '0.11.0',
    projectDir: join(home, 'project'),
    // `file:///C:/...` on Windows; git reads a file URL the same way it reads https.
    githubUrl: pathToFileURL(root).href,
    rawUrl: `${server.url.origin}/raw`,
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
      expect((await stat(join(tree, 'review/review.yaml'))).mode & 0o111).toBe(0);
    }
    // The pack's own `receipt.json` sits outside the receipts tree, and nothing of
    // the fetch is left behind.
    const receipts = await readReceipts(env.pluginsDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: ID, commit: commit('head') });
    expect(receipts[0].tag).toBeUndefined();
    expect((await readdir(env.pluginsDir)).sort()).toEqual(['installed', 'packs']);
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

  // An update that changes nothing is settled from `ls-remote` alone: fetching the
  // repository at depth 1 costs its whole checkout size, once per idempotent update.
  test('an update that keeps the installed commit never fetches', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v2`)).code).toBe(0);
    const trace = join(env.pluginsDir, '..', 'git-trace.log');
    for (const target of [`${ID}@v2`, ID]) {
      await writeFile(trace, '');
      process.env.GIT_TRACE = trace;
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(env, 'update', target);
      } finally {
        delete process.env.GIT_TRACE;
      }
      expect(result.err).toBe('');
      const commands = await readFile(trace, 'utf8');
      expect(commands).toContain('ls-remote');
      expect(commands).not.toMatch(/built-in: git (?:.* )?fetch /);
    }
  });

  test('an update that keeps the installed commit still refuses an incompatible Archon', async () => {
    const env = await environment();
    const newer = { ...env, archonVersion: '99.0.0' };
    expect((await run(newer, 'install', `${ID}@crafted-compat`)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'update', `${ID}@crafted-compat`);
    expect(result.code).toBe(1);
    expect(result.err).toContain('requires Archon >=99.0.0; this is Archon 0.11.0');
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('an update to another tag on the installed commit keeps the live tree and rewrites the receipt', async () => {
    const env = await environment();
    expect((await run(env, 'install', ID)).code).toBe(0);
    const tree = packTreePath(env.pluginsDir, ID, commit('head'));
    const files = await snapshot(tree);
    // Replacing the live tree with the same bytes would delete it on the way out,
    // since the old and new tree are the same directory.
    const updated = await run(env, 'update', `${ID}@v2`);
    expect(updated.err).toBe('');
    expect(updated.out).toContain('-> v2 (commit');
    expect(updated.out).toContain('files unchanged');
    expect(await snapshot(tree)).toEqual(files);
    expect((await readReceipts(env.pluginsDir))[0]).toMatchObject({
      tag: 'v2',
      commit: commit('head'),
    });
  });

  // A read-only receipt directory makes publishing the receipt fail after the new tree
  // was renamed into place. Windows ignores the mode and root bypasses it, so the
  // failure cannot be staged there.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed receipt write removes the new tree and keeps the previous install',
    async () => {
      const env = await environment();
      expect((await run(env, 'install', ID)).code).toBe(0);
      const before = await snapshot(env.pluginsDir);
      const receiptDir = dirname(receiptPath(env.pluginsDir, ID));
      await chmod(receiptDir, 0o555);
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(env, 'update', `${ID}@v1`);
      } finally {
        await chmod(receiptDir, 0o755);
      }
      expect(result.code).toBe(1);
      expect(await snapshot(packTreePath(env.pluginsDir, ID, commit('v1')))).toEqual({});
      expect(await snapshot(env.pluginsDir)).toEqual(before);
    }
  );

  test('copy writes to the repository root when run from a subdirectory', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v1`)).code).toBe(0);
    const project = join(env.projectDir, '..', 'repo');
    await mkdir(join(project, 'src', 'deep'), { recursive: true });
    Bun.spawnSync(['git', 'init', '-q'], { cwd: project });
    const copied = await run({ ...env, projectDir: join(project, 'src', 'deep') }, 'copy', ID);
    expect(copied.err).toBe('');
    expect(
      Object.keys(await snapshot(join(project, '.archon', 'workflows', 'review-kit')))
    ).toEqual(TREE_FILES);
    expect(await snapshot(join(project, 'src'))).toEqual({});
  });

  // Workflow discovery reads the same receipts on every call, so "nothing installed"
  // must be empty on every platform. On Windows, Bun's recursive readdir reports a
  // missing directory as EINVAL rather than ENOENT.
  test('an install that never ran `archon plugin` has no plugins, on every platform', async () => {
    const env = await environment();
    expect(await readReceipts(env.pluginsDir)).toEqual([]);
    expect((await run(env, 'list')).out).toBe('No plugins installed.');
    await mkdir(join(env.pluginsDir, 'installed'), { recursive: true });
    expect(await readReceipts(env.pluginsDir)).toEqual([]);
  });

  test('copy makes a project-owned copy and refuses an existing destination', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v1`)).code).toBe(0);
    await mkdir(env.projectDir, { recursive: true });
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
    ['a symlink', `${ID}@crafted-symlink`, '"review/readme" is a symlink'],
    ['a submodule', `${ID}@crafted-submodule`, '"vendor" is a submodule'],
    ['an escaping path', `${ID}@crafted-escape`, 'escapes the plugin directory'],
    // Git keeps these names; Windows would read them as a path outside the pack.
    ['a backslash name', `${ID}@crafted-backslash`, 'which Windows reads as path syntax'],
    ['a drive-letter name', `${ID}@crafted-colon`, '"review/C:evil" contains \\ or :'],
    [
      'an incompatible Archon range',
      `${ID}@crafted-compat`,
      'requires Archon >=99.0.0; this is Archon 0.11.0',
    ],
  ])('refuses a pack with %s and writes nothing', async (_case, target, message) => {
    const env = await environment();
    const result = await run(env, 'install', target);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(await snapshot(env.pluginsDir)).toEqual({});
  });

  // Windows runners and many Windows users set core.autocrlf=true globally. The
  // installed tree must hold the committed bytes regardless.
  test("installs the committed bytes even when the pack's own .gitattributes asks otherwise", async () => {
    const env = await environment();
    const result = await run(env, 'install', `${ID}@crafted-attributes`);
    expect(result.err).toBe('');
    const tree = packTreePath(env.pluginsDir, ID, commit('crafted-attributes'));
    expect(await readFile(join(tree, 'review/review.yaml'), 'utf8')).toBe('name: review\n# $Id$\n');
    expect(await readFile(join(tree, '.gitattributes'), 'utf8')).toBe('* text eol=crlf ident\n');
  });

  test("installs the committed bytes even when the user's git converts line endings", async () => {
    const env = await environment();
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'true',
    });
    try {
      expect((await run(env, 'install', `${ID}@v1`)).code).toBe(0);
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    const installed = await readFile(
      join(packTreePath(env.pluginsDir, ID, commit('v1')), 'review/review.yaml'),
      'utf8'
    );
    expect(installed).toBe('name: review\n# v1\n');
  });

  test('a file outside the plugin never blocks the install, whatever its name', async () => {
    const env = await environment();
    const result = await run(env, 'install', `${ID}@crafted-outside`);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(
      Object.keys(await snapshot(packTreePath(env.pluginsDir, ID, commit('crafted-outside'))))
    ).toEqual(['archon-plugin.json', 'review/review.yaml']);
  });
});
