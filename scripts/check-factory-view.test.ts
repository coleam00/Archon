import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '../packages/paths/src/test-utils';
import type { PackGraph } from '../packages/workflows/src/pack-graph';
import {
  UNKNOWN_COMMIT,
  checkView,
  commitWords,
  packFolderProblem,
  graphOfTree,
  packIdentity,
  parseArgs,
} from './check-factory-view';

const docsCopy = resolve(import.meta.dir, '../docs/factory-console/pack-view/factory-view.json');
const readDocsCopy = (): unknown => JSON.parse(readFileSync(docsCopy, 'utf8'));
/** The graph of the pack commit the docs copy is written for, af6d0b4a, as the checker's graph read gives it. */
const shippedGraph = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      '../packages/web/src/experiments/console/factory/__fixtures__/pack-graph-af6d0b4a.json'
    ),
    'utf8'
  )
) as PackGraph;

const track = trackTempRoots();

/** A graph of the one in-flow stage `make`, named by an installed pack's run names. */
const graph = {
  pack: 'acme.factory',
  stages: [
    {
      name: 'acme/factory:make',
      workflow: 'make',
      inFlow: true,
      outcome: null,
      nodes: [{ id: 'write' }],
    },
  ],
  groups: [],
  arrows: [],
} as unknown as PackGraph;

const view = (stage: string) => ({
  version: 1,
  summary: 'x',
  howItWorks: {
    title: 'x',
    caption: 'x',
    root: 'top',
    views: {
      top: {
        cards: [
          { id: 'a', title: 'a', text: 'a', icon: 'hammer', kind: 'stage', col: 1, row: 1 },
          {
            id: 'b',
            title: 'b',
            text: 'b',
            icon: 'hammer',
            kind: 'stage',
            col: 2,
            row: 1,
            stages: [stage],
          },
        ],
        edges: [{ from: 'b', to: 'a', kind: 'loops-back' }],
      },
    },
  },
});

test('the committed docs copy reads clean against the pack graph it is written for', () => {
  // CI runs this file: a stale, invalid or unworded entry in the shipped view fails it.
  expect(checkView(readDocsCopy(), shippedGraph)).toEqual({ code: 0, lines: ['0 problems'] });
});

describe('checkView', () => {
  test('passes a file whose picture names only what the graph has, with a summary line', () => {
    expect(checkView(view('make'), graph)).toEqual({ code: 0, lines: ['0 problems'] });
  });

  /** Each printed problem as `path: [kind]`, without its message. */
  const kinds = (report: ReturnType<typeof checkView>): string[] =>
    report.lines.slice(0, -1).map(entry => entry.replace(/\] .*$/, ']'));

  test('exits 1 on a stale stage: every problem is an error, each printed with its kind', () => {
    const report = checkView(view('deploy'), graph);
    expect(report.code).toBe(1);
    expect(kinds(report)).toEqual(['howItWorks.views.top.cards.1.stages.0: [dropped]']);
  });

  test("exits 1 on a key the file does not have, an older file's stage words among them", () => {
    const report = checkView({ ...view('make'), stages: { make: { label: 'Make' } } }, graph);
    expect(report.code).toBe(1);
    expect(kinds(report)).toEqual(['stages: [unknown]']);
  });

  test('exits 1 on a file whose envelope does not read', () => {
    expect(checkView({ ...view('make'), version: 2 }, graph).code).toBe(1);
  });
});

describe('packFolderProblem', () => {
  const folder = (manifest: object | null): string => {
    const dir = track(mkdtempSync(join(tmpdir(), 'factory-view-folder-')));
    if (manifest !== null) writeFileSync(join(dir, 'archon-plugin.json'), JSON.stringify(manifest));
    return dir;
  };

  test("accepts a folder whose manifest name is --repo's name half, under any owner", () => {
    const dir = folder({ name: 'factory' });
    expect(packFolderProblem(dir, 'acme/factory')).toBeUndefined();
    expect(packFolderProblem(dir, 'someone-else/factory')).toBeUndefined();
  });

  test('refuses, naming the folder and the name that would work, a --repo of another name', () => {
    const dir = folder({ name: 'gizmo' });
    const problem = packFolderProblem(dir, 'acme/nope') ?? '';
    expect(problem).toContain(dir);
    expect(problem).toContain('--repo <owner>/gizmo');
  });

  test('refuses a folder that does not exist or holds no manifest', () => {
    expect(packFolderProblem(join(tmpdir(), 'factory-view-no-such-folder'), 'a/b')).toBeDefined();
    expect(packFolderProblem(folder(null), 'a/b')).toBeDefined();
  });
});

describe('packIdentity', () => {
  const commit = 'a'.repeat(40);
  const installed = join('home', 'plugins', 'packs', 'acme', 'factory', commit);

  test('reads owner/name and the commit from an installed tree', () => {
    expect(packIdentity(installed)).toEqual({ repo: 'acme/factory', commit, from: 'install' });
    expect(packIdentity(installed, 'acme/factory')).toEqual({
      repo: 'acme/factory',
      commit,
      from: 'install',
    });
  });

  test('takes --repo for any other tree, and says when its commit cannot be known', () => {
    const tree = track(mkdtempSync(join(tmpdir(), 'factory-view-tree-')));
    const pack = packIdentity(tree, 'acme/factory');
    expect(pack).toEqual({ repo: 'acme/factory', commit: UNKNOWN_COMMIT, from: 'unknown' });
    expect(commitWords(pack as Exclude<typeof pack, { error: string }>)).toContain(
      'commit unknown'
    );
    expect(packIdentity(tree)).toHaveProperty('error');
    expect(packIdentity(installed, 'not-a-repo')).toHaveProperty('error');
  });

  test("takes a checkout's own HEAD, never that of a repository the tree sits inside", () => {
    const tree = track(mkdtempSync(join(tmpdir(), 'factory-view-checkout-')));
    writeFileSync(join(tree, 'archon-plugin.json'), '{}');
    const git = (...args: string[]): string => {
      const run = Bun.spawnSync(['git', '-C', tree, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString().trim();
    };
    git('init', '-q');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'pack');
    expect(packIdentity(tree, 'acme/factory')).toEqual({
      repo: 'acme/factory',
      commit: git('rev-parse', 'HEAD'),
      from: 'checkout',
    });
    // This file's own checkout: a folder inside it is not a checkout of its own.
    const inside = packIdentity(resolve(import.meta.dir, '../docs'), 'acme/factory');
    expect(inside).toMatchObject({ commit: UNKNOWN_COMMIT, from: 'unknown' });
  });
});

test('a pack tree that is not installed reads its graph with --repo (#231)', () => {
  const tree = track(mkdtempSync(join(tmpdir(), 'factory-view-pack-')));
  writeFileSync(
    join(tree, 'archon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: 'factory',
      description: 'One stage',
      entrypoints: { make: 'make/make.yaml' },
    })
  );
  mkdirSync(join(tree, 'make'));
  writeFileSync(
    join(tree, 'make', 'make.yaml'),
    'name: make\ndescription: makes it\nnodes:\n  - id: write\n    bash: "true"\n'
  );
  const pack = packIdentity(tree, 'acme/factory');
  if ('error' in pack) throw new Error(pack.error);
  const read = graphOfTree(tree, pack);
  if ('error' in read) throw new Error(read.error);
  expect(read.graph.stages.map(stage => stage.workflow)).toContain('make');
}, 60_000);

test('parseArgs takes one pack dir and the --view and --repo flags', () => {
  expect(parseArgs(['p', '--view', 'v.json', '--repo', 'a/b'])).toEqual({
    dir: resolve('p'),
    view: 'v.json',
    repo: 'a/b',
  });
  expect(parseArgs([])).toHaveProperty('error');
  expect(parseArgs(['p', '--view'])).toHaveProperty('error');
});
