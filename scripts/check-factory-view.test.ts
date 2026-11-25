import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PackGraph } from '../packages/workflows/src/pack-graph';
import { factoryViewSchema } from '../packages/workflows/src/schemas/factory-view';
import { checkView, packIdentity, parseArgs } from './check-factory-view';

const docsCopy = resolve(import.meta.dir, '../docs/factory-console/pack-view/factory-view.json');
const readDocsCopy = (): unknown => JSON.parse(readFileSync(docsCopy, 'utf8'));

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
  title: 'Factory',
  summary: 'x',
  stages: { [stage]: { label: 'Make', blurb: 'x' } },
  map: { cards: [{ id: 'make', stages: [stage] }] },
  howItWorks: {
    title: 'x',
    caption: 'x',
    root: 'top',
    views: {
      top: {
        cards: [
          { id: 'a', title: 'a', text: 'a', icon: 'hammer', kind: 'stage', col: 1, row: 1 },
          { id: 'b', title: 'b', text: 'b', icon: 'hammer', kind: 'stage', col: 2, row: 1 },
        ],
        edges: [{ from: 'b', to: 'a', kind: 'loops-back' }],
      },
    },
  },
});

test('the committed docs copy matches the factory view schema', () => {
  expect(factoryViewSchema.safeParse(readDocsCopy()).error?.issues ?? []).toEqual([]);
});

describe('checkView', () => {
  test('passes a view naming only what the graph has, with a summary line', () => {
    expect(checkView(view('make'), graph)).toEqual({ code: 0, lines: ['0 errors, 0 warnings'] });
  });

  test('exits 1 on an unknown stage and still prints the warnings', () => {
    const report = checkView(view('deploy'), graph);
    expect(report.code).toBe(1);
    expect(report.lines.map(entry => entry.split(':')[0])).toEqual([
      'stages.deploy',
      'map.cards.0.stages.0',
      'map.cards',
      'stages',
      '2 errors, 2 warnings',
    ]);
  });

  test('exits 1 on a file the schema refuses, before comparing names', () => {
    expect(checkView({ ...view('make'), placement: {} }, graph).code).toBe(1);
  });
});

describe('packIdentity', () => {
  const installed = join('home', 'plugins', 'packs', 'acme', 'factory', 'abc123');

  test('reads owner/name and the commit from an installed tree', () => {
    expect(packIdentity(installed)).toEqual({ repo: 'acme/factory', commit: 'abc123' });
  });

  test('takes --repo for any other tree, at commit local', () => {
    expect(packIdentity(join('src', 'factory'), 'acme/factory')).toEqual({
      repo: 'acme/factory',
      commit: 'local',
    });
    expect(packIdentity(join('src', 'factory'))).toHaveProperty('error');
    expect(packIdentity(installed, 'not-a-repo')).toHaveProperty('error');
  });
});

test('parseArgs takes one pack dir and the --view and --repo flags', () => {
  expect(parseArgs(['p', '--view', 'v.json', '--repo', 'a/b'])).toEqual({
    dir: resolve('p'),
    view: 'v.json',
    repo: 'a/b',
  });
  expect(parseArgs([])).toHaveProperty('error');
  expect(parseArgs(['p', '--view'])).toHaveProperty('error');
});
